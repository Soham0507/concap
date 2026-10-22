"""Scan a business card / document / badge → structured contact dict.

Pipeline:
  1. QR decode (OpenCV, no external service) — if the image carries a
     structured vCard / MeCard QR (one with a name / email / phone) we trust
     it over the OCR heuristics. A QR that is just a bare URL (a "save my
     card" link or company site) only fills GAPS so it can't clobber the
     richer fields read off the card text — see _merge_fields.
  2. OCR via Google Cloud Vision `document_text_detection` — better than
     plain `text_detection` for the dense, multi-column layout of cards.
  3. Parse the OCR text into name / company / designation / email / phone /
     website / GST / address — the LLM parser first, regex heuristics as a
     fallback.

The Vision client is created lazily so the app still boots when the
credential secret isn't set yet — the /api/scan endpoint will 503 with
a clear message, but nothing else breaks.
"""
from __future__ import annotations

import json
import logging
import re
from functools import lru_cache
from typing import Any

import cv2
import numpy as np

from ..config import get_settings

logger = logging.getLogger("booth.scanner")

_MAX_QR_PAYLOAD_LEN = 16_384


# ---- Vision client ------------------------------------------------------

@lru_cache
def _vision_client() -> "vision.ImageAnnotatorClient | None":
    from google.cloud import vision
    from google.oauth2 import service_account

    raw = (get_settings().google_application_credentials_json or "").strip()
    if not raw:
        return None
    try:
        info = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            "GOOGLE_APPLICATION_CREDENTIALS_JSON is set but isn't valid JSON. "
            "Paste the entire service-account key file contents."
        ) from exc
    creds = service_account.Credentials.from_service_account_info(info)
    return vision.ImageAnnotatorClient(credentials=creds)


def vision_configured() -> bool:
    try:
        return _vision_client() is not None
    except Exception:
        return False


# ---- LLM field extraction ----------------------------------------------

_LLM_FIELDS = (
    "name", "company", "designation", "email", "phone",
    "website", "gst_number", "address", "industry", "linkedin_url",
)

_CARD_SYSTEM_PROMPT = (
    "You read business cards. You are given the raw OCR text from a single card. "
    "The lines may be out of order because the card has a logo and multiple columns. "
    "Extract the contact details into a JSON object with EXACTLY these keys: "
    "name, company, designation, email, phone, website, gst_number, address, industry, linkedin_url. "
    "Use an empty string for anything you cannot determine. Rules:\n"
    "- name: the PERSON's full name (e.g. 'Islam J. Shaikh'). Never put the company here.\n"
    "- company: the full organisation name, INCLUDING words like 'Technologies', 'Solutions', "
    "'Pvt Ltd', 'Inc' (e.g. 'PreCloud Technologies'). If a logo word and a suffix word are on "
    "separate OCR lines but form one name, merge them. Never put the person's name here.\n"
    "- designation: the job title (e.g. 'Founder & CEO').\n"
    "- email: the primary email address, lowercased.\n"
    "- phone: the primary phone number; keep the country code and original formatting.\n"
    "- website: the company website only; never an email address and never a 'mailto:' link.\n"
    "- gst_number: an Indian GSTIN if present, otherwise empty.\n"
    "- address: the full postal address on a single line.\n"
    "- industry: your best short guess of the company's industry "
    "(e.g. 'Information Technology'), otherwise empty.\n"
    "- linkedin_url: a LinkedIn profile/company URL printed on the card "
    "(e.g. 'linkedin.com/in/...'); prefix with 'https://' if missing. Empty if none.\n"
    "Output ONLY the JSON object."
)


def _llm_parse_card(raw_text: str, qr_payload: str | None) -> dict[str, Any]:
    """Turn messy OCR text into structured contact fields with the configured
    OpenAI model. Far more reliable than regex on cards with logos and
    multi-column layouts. Returns {} when OpenAI isn't configured or the call
    fails, so the caller can fall back to the regex heuristics.
    """
    text = (raw_text or "").strip()
    if not text:
        return {}
    settings = get_settings()
    if not settings.openai_api_key:
        return {}

    user_content = "OCR TEXT FROM CARD:\n" + text
    if qr_payload:
        user_content += "\n\nQR CODE PAYLOAD (authoritative if present):\n" + qr_payload

    from openai import OpenAI

    try:
        client = OpenAI(api_key=settings.openai_api_key, timeout=30.0)
        resp = client.chat.completions.create(
            model=settings.analysis_model,
            response_format={"type": "json_object"},
            temperature=0,
            messages=[
                {"role": "system", "content": _CARD_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
        )
        parsed = json.loads(resp.choices[0].message.content or "{}")
    except Exception as exc:  # noqa: BLE001
        logger.warning("LLM card parse failed, falling back to regex: %s", exc)
        return {}

    if not isinstance(parsed, dict):
        return {}
    out: dict[str, Any] = {}
    for key in _LLM_FIELDS:
        val = parsed.get(key)
        if isinstance(val, str) and val.strip():
            out[key] = val.strip()
    if "email" in out:
        out["email"] = out["email"].lower()
    return out


# ---- OCR + QR primitives ------------------------------------------------

def _decode_qr_variant(detector: "cv2.QRCodeDetector", img) -> str | None:
    """Best (longest) decode of a single image variant. OpenCV can truncate a
    dense vCard QR, so when multiple QRs/results come back we keep the longest
    — that's the one carrying the most fields."""
    best: str | None = None
    try:
        data, _pts, _ = detector.detectAndDecode(img)
        if data:
            best = data.strip()
    except Exception:  # noqa: BLE001
        pass
    # Some cards have multiple QRs (e.g. LinkedIn + vCard); multi-detect too.
    try:
        ok, decoded, _, _ = detector.detectAndDecodeMulti(img)
        if ok:
            for d in decoded:
                if d and (best is None or len(d.strip()) > len(best)):
                    best = d.strip()
    except Exception:  # noqa: BLE001
        pass
    return best


def _decode_qr(image_bytes: bytes) -> str | None:
    """Return the decoded QR payload, or None if no QR is detected.

    Uses OpenCV's bundled detector — no extra system libs needed. OpenCV's
    detector is sensitive to scale/contrast and on small or dense QRs will
    either miss the code or return a *truncated* payload. We try a few cheap
    image variants (original, grayscale, 2x upscaled) and keep the longest
    decode, which recovers fields a single pass would drop. This is a fallback
    — the browser's jsQR result (passed as client_qr_payload) is preferred.
    """
    try:
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return None
        detector = cv2.QRCodeDetector()

        variants = [img]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        variants.append(gray)
        # Upscale small images so the QR modules are big enough to decode.
        longest_edge = max(img.shape[0], img.shape[1])
        if longest_edge < 1600:
            factor = min(3.0, 1600 / longest_edge)
            variants.append(
                cv2.resize(gray, None, fx=factor, fy=factor, interpolation=cv2.INTER_CUBIC)
            )

        best: str | None = None
        for variant in variants:
            result = _decode_qr_variant(detector, variant)
            if result and (best is None or len(result) > len(best)):
                best = result
        return best
    except Exception as exc:  # noqa: BLE001
        logger.warning("QR decode failed: %s", exc)
    return None


def _ocr_text(image_bytes: bytes) -> tuple[str, dict[str, Any]]:
    """Return (full text, raw response metadata) from Vision."""
    from google.cloud import vision

    client = _vision_client()
    if client is None:
        raise RuntimeError(
            "Google Cloud Vision is not configured. Set the "
            "GOOGLE_APPLICATION_CREDENTIALS_JSON secret with your service-account JSON."
        )
    image = vision.Image(content=image_bytes)
    # `document_text_detection` handles multi-line, multi-column layouts
    # (which business cards basically are) better than `text_detection`.
    resp = client.document_text_detection(image=image)
    if resp.error.message:
        raise RuntimeError(f"Vision API error: {resp.error.message}")
    full = resp.full_text_annotation.text if resp.full_text_annotation else ""
    meta = {
        "page_count": len(resp.full_text_annotation.pages) if resp.full_text_annotation else 0,
    }
    return (full or "").strip(), meta


# ---- Parsers ------------------------------------------------------------

# Phone: international with optional country code, parentheses, dashes,
# spaces. We require at least 8 digits total to filter dates and IDs.
_PHONE_RE = re.compile(
    r"(?:(?:\+|00)\d{1,3}[\s\-.]?)?(?:\(\d{1,4}\)[\s\-.]?)?\d[\d\s\-.]{7,}\d"
)
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
# India GSTIN: 2 digits state + 10 char PAN + 1 entity + Z + 1 checksum.
_GST_RE = re.compile(r"\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b")
_URL_RE = re.compile(
    r"(?:https?://)?(?:www\.)?[A-Za-z0-9\-]+\.(?:com|net|org|io|co|in|ai|app|dev|tech|biz|info|me|us|uk|de|fr|jp|cn)(?:/[^\s,]*)?",
    re.IGNORECASE,
)

# Lines containing one of these tokens are almost certainly a company name.
_COMPANY_TOKENS = re.compile(
    r"\b(inc|llc|ltd|limited|llp|pvt|private|corp|corporation|gmbh|s\.?a\.?|co\.?|company|solutions|technologies|systems|consulting|group|holdings|global|partners|labs|studio|industries|enterprises|associates|services|networks|capital|ventures)\b",
    re.IGNORECASE,
)
_DESIGNATION_TOKENS = re.compile(
    r"\b(ceo|cto|coo|cfo|cmo|founder|co-?founder|director|head|chief|vp|vice president|president|manager|lead|engineer|developer|designer|architect|consultant|analyst|specialist|officer|executive|partner|associate|sales|marketing|operations|product|principal|owner)\b",
    re.IGNORECASE,
)
_ADDRESS_HINTS = re.compile(
    r"\b(road|street|st\.?|avenue|ave\.?|lane|ln\.?|boulevard|blvd\.?|sector|floor|building|tower|plaza|complex|nagar|colony|po box|p\.o\.|pin|zip|district|state)\b",
    re.IGNORECASE,
)
_PINCODE_RE = re.compile(r"\b\d{5,6}\b")


def _normalize_url(value: str) -> str:
    """Ensure a captured URL has an http(s) scheme so it stores/links cleanly."""
    value = (value or "").strip()
    if value and not value.lower().startswith(("http://", "https://")):
        value = "https://" + value.lstrip("/")
    return value


def _parse_vcard(payload: str) -> dict[str, Any]:
    """Parse a vCard / MeCard QR payload into our contact shape.

    Spec is generous; we handle the fields actually seen on conference badges
    and standard vCard exports. Unknown lines are ignored.
    """
    out: dict[str, Any] = {}
    payload = payload.strip()

    # MeCard format: MECARD:N:Doe,John;TEL:+1...;EMAIL:..;;
    if payload.upper().startswith("MECARD:"):
        body = payload.split(":", 1)[1]
        for part in body.rstrip(";").split(";"):
            if ":" not in part:
                continue
            k, v = part.split(":", 1)
            k = k.upper().strip()
            v = v.strip()
            if k == "N":
                out["name"] = " ".join(reversed([s.strip() for s in v.split(",")])).strip()
            elif k == "TEL":
                out.setdefault("phone", v)
            elif k == "EMAIL":
                out.setdefault("email", v)
            elif k == "URL":
                if "linkedin." in v.lower():
                    out.setdefault("linkedin_url", _normalize_url(v))
                else:
                    out.setdefault("website", v)
            elif k == "ORG":
                out.setdefault("company", v)
            elif k == "ADR":
                out.setdefault("address", v.replace(",", ", "))
        return out

    # vCard 3.0 / 4.0
    if "BEGIN:VCARD" in payload.upper():
        for line in payload.splitlines():
            line = line.strip()
            if not line or ":" not in line:
                continue
            key, value = line.split(":", 1)
            key = key.split(";", 1)[0].upper()
            value = value.strip()
            if not value:
                continue
            if key == "FN":
                out["name"] = value
            elif key == "N" and "name" not in out:
                parts = [p for p in value.split(";") if p]
                # vCard N: Family;Given;Additional;Prefix;Suffix
                if len(parts) >= 2:
                    out["name"] = f"{parts[1]} {parts[0]}".strip()
                elif parts:
                    out["name"] = parts[0]
            elif key.startswith("TEL"):
                out.setdefault("phone", value)
            elif key.startswith("EMAIL"):
                out.setdefault("email", value)
            elif key.startswith("URL"):
                if "linkedin." in value.lower():
                    out.setdefault("linkedin_url", _normalize_url(value))
                else:
                    out.setdefault("website", value)
            elif key == "ORG":
                out.setdefault("company", value.split(";")[0].strip())
            elif key == "TITLE":
                out.setdefault("designation", value)
            elif key.startswith("ADR"):
                # ADR: PO;Extended;Street;City;Region;Postal;Country
                bits = [b for b in value.split(";") if b]
                out.setdefault("address", ", ".join(bits))
        return out

    # Plain URL → LinkedIn profile if it points at linkedin.*, else website.
    if payload.startswith(("http://", "https://", "www.")):
        if "linkedin." in payload.lower():
            out["linkedin_url"] = _normalize_url(payload)
        else:
            out["website"] = payload
        return out

    return out


def _parse_ocr_text(text: str) -> dict[str, Any]:
    """Pull structured fields out of free-form OCR text using regexes +
    line heuristics. Conservative — missing > wrong.
    """
    if not text:
        return {}

    out: dict[str, Any] = {}
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]

    # --- Single-token regex hits (greedy: first match wins) ---
    email = _EMAIL_RE.search(text)
    if email:
        out["email"] = email.group(0).lower()
    gst = _GST_RE.search(text.upper())
    if gst:
        out["gst_number"] = gst.group(0)
    url = _URL_RE.search(text)
    if url:
        site = url.group(0)
        # Don't accidentally pick up the email's domain.
        if "@" not in site:
            out["website"] = site.rstrip(".,;")

    # Phone: first match that has at least 8 digits and isn't obviously the
    # ZIP/PIN code from an address line.
    for m in _PHONE_RE.finditer(text):
        candidate = m.group(0).strip()
        digits = re.sub(r"\D", "", candidate)
        if len(digits) < 8 or len(digits) > 15:
            continue
        out["phone"] = candidate
        break

    # --- Line-by-line classification ---
    used = set()
    company_line = None
    designation_line = None
    address_lines = []

    for i, line in enumerate(lines):
        low = line.lower()
        # Skip lines that are *just* a regex hit we already captured.
        if "@" in line or _URL_RE.fullmatch(line.strip()):
            used.add(i)
            continue
        if _GST_RE.search(line.upper()):
            used.add(i)
            continue
        if _PHONE_RE.fullmatch(line):
            used.add(i)
            continue
        if _COMPANY_TOKENS.search(low) and company_line is None:
            company_line = line
            used.add(i)
            continue
        if _DESIGNATION_TOKENS.search(low) and designation_line is None:
            designation_line = line
            used.add(i)
            continue
        if _ADDRESS_HINTS.search(low) or _PINCODE_RE.search(line):
            address_lines.append(line)
            used.add(i)
            continue

    if company_line:
        out["company"] = company_line
    if designation_line:
        out["designation"] = designation_line
    if address_lines:
        out["address"] = ", ".join(address_lines)

    # Name = first short, alphabetic, title-cased line we haven't claimed.
    # Business cards almost always lead with the person's name in big type,
    # which Vision returns first.
    for i, line in enumerate(lines):
        if i in used:
            continue
        clean = re.sub(r"[^A-Za-z\s'.\-]", "", line).strip()
        if not clean or len(clean) > 60:
            continue
        words = clean.split()
        if not (2 <= len(words) <= 4):
            continue
        # Avoid all-caps brand names ("WHITESTONE GLOBAL") — those are usually
        # companies, not people. Allow Title Case or Mixed Case.
        if clean.isupper() and len(clean) > 12:
            continue
        out["name"] = clean
        break

    return out


# ---- Field merge --------------------------------------------------------

# Identity fields that make a QR payload a *real* contact record (a proper
# vCard / MeCard) rather than a bare link.
_QR_IDENTITY_FIELDS = ("name", "email", "phone")


def _merge_fields(
    ocr_fields: dict[str, Any], qr_fields: dict[str, Any]
) -> dict[str, Any]:
    """Combine OCR/LLM-parsed fields with QR-decoded fields.

    A QR that carries a structured vCard/MeCard (it has a name, email or
    phone) is machine-readable and authoritative, so it wins outright. But a
    very common case is a card whose QR is just a *bare URL* — a "save my
    vCard" link, a digital-card landing page, or the company site. Those used
    to overwrite the website/links the LLM had correctly read off the card
    text, which is exactly the "wrong details" users hit on camera scans
    (the camera auto-captures the moment any QR is seen). So a bare-URL QR now
    only fills GAPS — it never clobbers a field OCR/LLM already found.
    """
    qr_is_structured = any(qr_fields.get(k) for k in _QR_IDENTITY_FIELDS)
    if qr_is_structured:
        return {**ocr_fields, **{k: v for k, v in qr_fields.items() if v}}

    merged = dict(ocr_fields)
    for key, value in qr_fields.items():
        if value and not merged.get(key):
            merged[key] = value
    return merged


# ---- Public API ---------------------------------------------------------

def _pick_richer_payload(a: str | None, b: str | None) -> str | None:
    """Choose the more complete of two QR payloads for the same image.

    The browser (jsQR / BarcodeDetector) and the server (OpenCV) can disagree:
    OpenCV frequently *truncates* a dense vCard QR, returning only the first
    few fields (name/company) and dropping email/phone/address. When both
    decoders produced something, keep the longer string — it carries the
    fields the truncated one lost.
    """
    if a and b:
        return a if len(a) >= len(b) else b
    return a or b


def scan_image(image_bytes: bytes, client_qr_payload: str | None = None) -> dict[str, Any]:
    """Run the full QR + OCR + parse pipeline on a single image.

    `client_qr_payload` is the QR text the browser already decoded (the camera
    and upload paths both run jsQR client-side). Browser decoders read dense
    vCard QRs reliably, whereas OpenCV often truncates them — so we prefer the
    richer of the two payloads.

    Returns a dict with:
      - parsed fields (name, company, email, phone, …) — only present when found
      - raw_text: the full OCR string
      - qr_payload: the decoded QR string, or None
      - source: 'qr' | 'ocr' | 'qr+ocr' depending on which contributed
    """
    if not image_bytes:
        raise ValueError("Empty image upload")

    client_qr_payload = (client_qr_payload or "").strip()[:_MAX_QR_PAYLOAD_LEN] or None
    qr_payload = _pick_richer_payload(client_qr_payload, _decode_qr(image_bytes))
    qr_fields: dict[str, Any] = {}
    if qr_payload:
        try:
            qr_fields = _parse_vcard(qr_payload)
        except Exception as exc:  # noqa: BLE001
            logger.warning("QR parse failed (payload kept): %s", exc)

    raw_text, ocr_meta = _ocr_text(image_bytes)
    # Prefer the LLM parser (handles logos / multi-column cards reliably);
    # fall back to the regex heuristics if OpenAI isn't configured or errors.
    ocr_fields = _llm_parse_card(raw_text, qr_payload)
    if not ocr_fields:
        ocr_fields = _parse_ocr_text(raw_text)

    merged = _merge_fields(ocr_fields, qr_fields)

    source = "qr+ocr" if qr_fields and ocr_fields else "qr" if qr_fields else "ocr"

    return {
        **merged,
        "raw_text": raw_text,
        "qr_payload": qr_payload,
        "source": source,
        "vision": ocr_meta,
    }
