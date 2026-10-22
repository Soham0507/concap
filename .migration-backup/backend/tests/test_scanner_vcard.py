"""Tests for QR / vCard payload parsing in the card scanner.

Focus: LinkedIn URLs must be captured into ``linkedin_url`` (not ``website``),
whether they arrive as a plain-URL QR payload or inside a vCard URL field.
"""
from __future__ import annotations

import importlib

from app.services.scanner import _merge_fields, _parse_vcard, _pick_richer_payload


def test_plain_linkedin_url_goes_to_linkedin():
    out = _parse_vcard("https://www.linkedin.com/in/jane-doe")
    assert out["linkedin_url"] == "https://www.linkedin.com/in/jane-doe"
    assert "website" not in out


def test_plain_non_linkedin_url_goes_to_website():
    out = _parse_vcard("https://acme.example.com")
    assert out["website"] == "https://acme.example.com"
    assert "linkedin_url" not in out


def test_plain_linkedin_url_without_scheme_is_normalized():
    out = _parse_vcard("www.linkedin.com/in/jane-doe")
    assert out["linkedin_url"] == "https://www.linkedin.com/in/jane-doe"


def test_vcard_url_field_with_linkedin():
    payload = (
        "BEGIN:VCARD\n"
        "VERSION:3.0\n"
        "FN:Jane Doe\n"
        "ORG:Acme Inc\n"
        "URL:https://linkedin.com/in/jane-doe\n"
        "END:VCARD"
    )
    out = _parse_vcard(payload)
    assert out["linkedin_url"] == "https://linkedin.com/in/jane-doe"
    assert "website" not in out


def test_vcard_url_field_with_company_site():
    payload = (
        "BEGIN:VCARD\n"
        "VERSION:3.0\n"
        "FN:Jane Doe\n"
        "URL:https://acme.example.com\n"
        "END:VCARD"
    )
    out = _parse_vcard(payload)
    assert out["website"] == "https://acme.example.com"
    assert "linkedin_url" not in out


def test_mecard_url_field_with_linkedin_is_normalized():
    out = _parse_vcard("MECARD:N:Doe,Jane;URL:linkedin.com/in/jane-doe;;")
    assert out["linkedin_url"] == "https://linkedin.com/in/jane-doe"


# --- Field merge: QR vs OCR/LLM precedence -------------------------------
#
# Cards commonly carry a QR that's just a bare URL (a "save vCard" link or the
# company site). It must NOT clobber the richer fields the LLM read off the
# card text — only a structured vCard/MeCard (with name/email/phone) is
# authoritative. The camera path auto-captures on QR detection, so this is the
# precise cause of "wrong details" on camera scans.

def test_bare_url_qr_does_not_overwrite_llm_website():
    ocr = {"name": "Jane Doe", "company": "Acme", "website": "https://acme.com"}
    qr = {"website": "https://qr.io/save-jane"}  # bare "download my card" link
    merged = _merge_fields(ocr, qr)
    assert merged["website"] == "https://acme.com"  # LLM value preserved
    assert merged["name"] == "Jane Doe"


def test_bare_url_qr_fills_only_missing_fields():
    ocr = {"name": "Jane Doe", "company": "Acme"}  # no website found by OCR
    qr = {"website": "https://acme.com"}
    merged = _merge_fields(ocr, qr)
    assert merged["website"] == "https://acme.com"  # gap filled


def test_bare_linkedin_qr_fills_gap_without_clobbering():
    ocr = {"name": "Jane Doe", "linkedin_url": "https://linkedin.com/in/jane"}
    qr = {"linkedin_url": "https://linkedin.com/company/acme"}
    merged = _merge_fields(ocr, qr)
    # OCR already had a (personal) LinkedIn — the QR company link must not win.
    assert merged["linkedin_url"] == "https://linkedin.com/in/jane"


def test_structured_vcard_qr_is_authoritative():
    ocr = {"name": "Jane D", "phone": "12345", "website": "https://wrong.com"}
    qr = {"name": "Jane Doe", "phone": "+1 555 0100", "email": "jane@acme.com"}
    merged = _merge_fields(ocr, qr)
    # A real vCard (has name/email/phone) wins on the fields it provides.
    assert merged["name"] == "Jane Doe"
    assert merged["phone"] == "+1 555 0100"
    assert merged["email"] == "jane@acme.com"
    # Fields only OCR had still survive.
    assert merged["website"] == "https://wrong.com"


def test_empty_qr_leaves_ocr_untouched():
    ocr = {"name": "Jane Doe", "company": "Acme"}
    assert _merge_fields(ocr, {}) == ocr


def test_pick_richer_payload_prefers_longer():
    # OpenCV often returns a truncated vCard; the browser's full decode is
    # longer and must win.
    short = "BEGIN:VCARD\nFN:Jane Doe\nORG:Acme\nEND:VCARD"
    full = ("BEGIN:VCARD\nFN:Jane Doe\nORG:Acme\nEMAIL:jane@acme.com\n"
            "TEL:+1 555 0100\nEND:VCARD")
    assert _pick_richer_payload(short, full) == full
    assert _pick_richer_payload(full, short) == full


def test_pick_richer_payload_handles_missing():
    assert _pick_richer_payload(None, "x") == "x"
    assert _pick_richer_payload("x", None) == "x"
    assert _pick_richer_payload(None, None) is None


def test_scan_image_caps_oversized_client_payload():
    # An authenticated client could submit a huge text part; scan_image must
    # truncate it before parsing/LLM rather than carry unbounded text.
    from app.services import scanner

    captured = {}

    class _Stop(Exception):
        pass

    def fake_decode_qr(_bytes):
        return None

    def fake_pick(client, server):
        captured["client_len"] = len(client) if client else 0
        raise _Stop  # short-circuit before OCR/LLM

    scanner._decode_qr = fake_decode_qr  # type: ignore[assignment]
    scanner._pick_richer_payload = fake_pick  # type: ignore[assignment]
    try:
        scanner.scan_image(b"\x89PNG", client_qr_payload="A" * 100_000)
    except _Stop:
        pass
    finally:
        importlib.reload(scanner)

    assert captured["client_len"] == 16_384


def test_structured_qr_website_and_linkedin_override_ocr():
    # When the QR is a real vCard (has identity), its website/linkedin_url are
    # authoritative too — locking in "structured QR wins" beyond identity keys.
    ocr = {"name": "Jane D", "website": "https://ocr-guess.com",
           "linkedin_url": "https://linkedin.com/in/ocr-guess"}
    qr = {"name": "Jane Doe", "email": "jane@acme.com",
          "website": "https://acme.com",
          "linkedin_url": "https://linkedin.com/in/jane-doe"}
    merged = _merge_fields(ocr, qr)
    assert merged["website"] == "https://acme.com"
    assert merged["linkedin_url"] == "https://linkedin.com/in/jane-doe"
