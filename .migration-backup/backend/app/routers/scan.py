"""Card / document scan endpoints.

POST /api/scan       — upload an image, get a parsed contact + persisted Visitor row
GET  /api/scan/history — list visitors created from a scan (source='scan')

Contact CRUD lives alongside the existing visitors router (PUT/DELETE were
added there to keep all visitor mutations in one place).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiofiles
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import Company, User, Visitor
from ..schemas import VisitorOut
from ..services import research as research_svc
from ..services.scanner import scan_image, vision_configured
from .auth import require_user
from .companies import upsert_company_for_scan

logger = logging.getLogger("booth.scan")

router = APIRouter(prefix="/api/scan", tags=["scan"])

ALLOWED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp"}
MAX_MB = 25  # business-card photos are tiny; 25 MB is generous
MAX_BULK = 20  # cap a single bulk upload so one request can't run for minutes


class ScanOut(BaseModel):
    """Result envelope: the parsed/structured fields + the persisted Visitor row."""
    visitor: VisitorOut
    raw_text: str
    qr_payload: str | None = None
    source: str  # 'qr' | 'ocr' | 'qr+ocr'
    # The parsed fields *before* we wrote them to the DB. Handy for the UI
    # to highlight what was auto-detected vs. left blank.
    parsed: dict[str, Any]


class ResearchOut(BaseModel):
    """AI quick-research result for a scanned contact + their company."""
    visitor: VisitorOut
    linkedin_url: str | None = None
    # The person's LinkedIn-verified current employer, when research found one.
    # Used by the UI to correct a company name that was mis-read off the card.
    current_company: str | None = None
    # Company industry / website filled in by research, so the UI can populate
    # those fields automatically. Present only when research actually set them.
    industry: str | None = None
    website: str | None = None
    person_summary: str | None = None
    company_summary: str | None = None
    competitors: list[dict[str, Any]] = []
    sources: list[str] = []
    # Present (and human-readable) only when research couldn't be produced.
    error: str | None = None


class BulkScanItem(BaseModel):
    """Per-file outcome in a bulk upload. One bad image yields status='failed'
    with an `error`, leaving the rest of the batch unaffected."""
    filename: str
    status: str  # 'ok' | 'failed'
    visitor: VisitorOut | None = None
    raw_text: str | None = None
    qr_payload: str | None = None
    source: str | None = None
    parsed: dict[str, Any] | None = None
    error: str | None = None


class BulkScanOut(BaseModel):
    """Envelope for a bulk upload: per-file results + a quick tally."""
    results: list[BulkScanItem]
    ok_count: int
    failed_count: int


@router.get("/status")
def scan_status() -> dict:
    """Cheap health check the frontend uses to disable the scan button with
    a friendly message when the Vision key isn't configured."""
    return {"configured": vision_configured()}


@router.post("", response_model=ScanOut)
async def scan(
    image: UploadFile = File(...),
    contact_type: str = Form(default="lead"),
    notes: str | None = Form(default=None),
    qr_payload: str | None = Form(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> ScanOut:
    if not vision_configured():
        raise HTTPException(
            status_code=503,
            detail="Scanner is not configured: set the GOOGLE_APPLICATION_CREDENTIALS_JSON secret.",
        )

    target_path = await _save_upload(image)
    return await _scan_and_persist(target_path, contact_type, notes, db, user, qr_payload)


@router.post("/bulk", response_model=BulkScanOut)
async def scan_bulk(
    images: list[UploadFile] = File(...),
    contact_type: str = Form(default="lead"),
    notes: str | None = Form(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> BulkScanOut:
    """Upload several card images at once → one contact per image.

    Each file is processed independently so a single bad image yields a
    per-file 'failed' result instead of aborting the whole batch. Research
    enrichment is NOT run inline (too slow for a batch) — the UI can trigger
    it per contact afterwards via POST /api/scan/{visitor_id}/research.
    """
    if not vision_configured():
        raise HTTPException(
            status_code=503,
            detail="Scanner is not configured: set the GOOGLE_APPLICATION_CREDENTIALS_JSON secret.",
        )
    if not images:
        raise HTTPException(status_code=400, detail="No images uploaded")
    if len(images) > MAX_BULK:
        raise HTTPException(
            status_code=400,
            detail=f"Too many images: {len(images)} (max {MAX_BULK} per upload)",
        )

    results: list[BulkScanItem] = []
    for image in images:
        filename = image.filename or "image"
        try:
            target_path = await _save_upload(image)
            out = await _scan_and_persist(target_path, contact_type, notes, db, user)
            results.append(
                BulkScanItem(
                    filename=filename,
                    status="ok",
                    visitor=out.visitor,
                    raw_text=out.raw_text,
                    qr_payload=out.qr_payload,
                    source=out.source,
                    parsed=out.parsed,
                )
            )
        except HTTPException as exc:
            # Roll back any partial state so the session stays usable for the
            # remaining files in the batch.
            db.rollback()
            results.append(
                BulkScanItem(filename=filename, status="failed", error=str(exc.detail))
            )
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            logger.exception("Bulk scan item failed: %s", filename)
            results.append(
                BulkScanItem(filename=filename, status="failed", error=str(exc))
            )

    ok = sum(1 for r in results if r.status == "ok")
    return BulkScanOut(results=results, ok_count=ok, failed_count=len(results) - ok)


async def _save_upload(image: UploadFile) -> Path:
    """Validate an upload's type/size and stream it to disk under the media
    root. Returns the saved path; raises HTTPException on any problem.

    The original capture is kept so it can be re-parsed later if heuristics
    improve. Lives under audio_path/scans (audio_path doubles as the app's
    writable media root — existing code already mkdirs it)."""
    suffix = Path(image.filename or "").suffix.lower() or ".jpg"
    if suffix not in ALLOWED_IMAGE_EXTS:
        raise HTTPException(status_code=415, detail=f"Unsupported image type: {suffix}")

    target_dir = get_settings().audio_path / "scans"
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"scan_{uuid.uuid4().hex}{suffix}"

    max_bytes = MAX_MB * 1024 * 1024
    written = 0
    async with aiofiles.open(target_path, "wb") as out:
        while chunk := await image.read(1024 * 1024):
            written += len(chunk)
            if written > max_bytes:
                await out.close()
                target_path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=413, detail=f"Image exceeds {MAX_MB} MB limit"
                )
            await out.write(chunk)
    if written == 0:
        target_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Empty image upload")
    return target_path


async def _scan_and_persist(
    target_path: Path,
    contact_type: str,
    notes: str | None,
    db: Session,
    user: User,
    client_qr_payload: str | None = None,
) -> ScanOut:
    """Scan one saved image, dedupe/persist a Visitor (+ Company) and return a
    ScanOut. Raises HTTPException on scan failure (and removes the orphan file).

    Shared by the single-card and bulk endpoints so both behave identically."""
    try:
        data = await _read_and_scan(target_path, client_qr_payload)
    except HTTPException:
        target_path.unlink(missing_ok=True)
        raise
    except RuntimeError as exc:
        # Vision API misconfig / network / quota. Drop the file so we don't
        # accumulate orphan uploads with no DB row pointing at them.
        target_path.unlink(missing_ok=True)
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        target_path.unlink(missing_ok=True)
        logger.exception("Scan pipeline crashed")
        raise HTTPException(status_code=500, detail=f"Scan failed: {exc}")

    # Drop the scaffolding keys so `parsed` is *just* contact fields.
    parsed = {
        k: v for k, v in data.items()
        if k in {"name", "company", "email", "phone", "designation", "website",
                 "gst_number", "address", "industry", "linkedin_url"} and v
    }
    raw_text = data.get("raw_text") or ""
    qr_payload = data.get("qr_payload")

    name = (parsed.get("name") or "").strip()
    if not name:
        # Fall back so we never crash on an unrecognized card — user can rename.
        name = f"Scanned contact · {target_path.stem[-6:]}"

    # Dedup within the same org by email/phone so re-scanning a card updates
    # the existing record instead of creating a duplicate.
    contact_type = (contact_type or "lead").lower()
    if contact_type not in {"lead", "customer", "employee"}:
        contact_type = "lead"

    existing: Visitor | None = None
    if parsed.get("email"):
        existing = db.scalar(
            select(Visitor).where(
                Visitor.org_id == user.org_id,
                Visitor.email == parsed["email"].lower(),
            )
        )
    if existing is None and parsed.get("phone"):
        existing = db.scalar(
            select(Visitor).where(
                Visitor.org_id == user.org_id,
                Visitor.phone == parsed["phone"],
            )
        )

    if existing is not None:
        # Re-scan = enrich missing fields, don't overwrite manual edits.
        for field, value in parsed.items():
            if value and not getattr(existing, field, None):
                setattr(existing, field, value)
        existing.scan_image_path = str(target_path)
        existing.scan_raw_text = raw_text
        existing.scan_metadata = {"qr_payload": qr_payload, "source": data.get("source")}
        existing.source = "scan"
        if notes:
            existing.notes = (existing.notes + "\n" if existing.notes else "") + notes
        visitor = existing
    else:
        visitor = Visitor(
            org_id=user.org_id,
            name=name,
            company=parsed.get("company"),
            email=(parsed.get("email") or None),
            phone=parsed.get("phone"),
            designation=parsed.get("designation"),
            industry=parsed.get("industry"),
            website=parsed.get("website"),
            gst_number=parsed.get("gst_number"),
            address=parsed.get("address"),
            linkedin_url=parsed.get("linkedin_url"),
            contact_type=contact_type,
            source="scan",
            notes=notes,
            scan_image_path=str(target_path),
            scan_raw_text=raw_text,
            scan_metadata={"qr_payload": qr_payload, "source": data.get("source")},
        )
        db.add(visitor)

    # Upsert the Company record from the parsed card data and link the
    # visitor to it. Company-level fields (website, industry, address, GST)
    # default to whatever was on the card the first time we see this
    # company; subsequent scans never overwrite a manually-set value.
    if parsed.get("company"):
        company = upsert_company_for_scan(
            db,
            user.org_id,
            name=parsed["company"],
            website=parsed.get("website"),
            industry=parsed.get("industry"),
            address=parsed.get("address"),
            gst_number=parsed.get("gst_number"),
        )
        if company is not None:
            visitor.company_id = company.id
            # Keep the denormalized string in sync with the canonical name.
            visitor.company = company.name
    db.commit()
    db.refresh(visitor)

    return ScanOut(
        visitor=VisitorOut.model_validate(visitor),
        raw_text=raw_text,
        qr_payload=qr_payload,
        source=str(data.get("source") or "ocr"),
        parsed=parsed,
    )


@router.post("/{visitor_id}/research", response_model=ResearchOut)
def research_contact(
    visitor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> ResearchOut:
    """Run AI "quick research" on a scanned contact and their company.

    Produces a company summary + competitor list and a short brief on the
    person (and best-effort LinkedIn URL) via OpenAI's hosted web_search tool,
    persists them to the Visitor and its linked Company, and returns them.

    Kept separate from POST /api/scan so scanning stays fast — the UI triggers
    this on demand from the review screen. Degrades gracefully: if research
    can't be produced the contact is untouched and `error` explains why.
    """
    visitor = db.get(Visitor, visitor_id)
    if visitor is None or visitor.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Visitor not found")

    if not research_svc.research_available():
        raise HTTPException(
            status_code=503,
            detail="Research is not configured: set the OPENAI_API_KEY secret.",
        )

    scanned_company = (visitor.company or "").strip()

    person = research_svc.research_person(
        name=visitor.name,
        company=scanned_company or None,
        email=visitor.email,
        designation=visitor.designation,
    )

    # The company name read off a business card is often blank, stale, or wrong
    # (OCR mistakes / the LLM guessing). The person's LinkedIn-verified current
    # employer is more reliable, so when research is confident about one, prefer
    # it: research the correct company AND correct the stored value so the saved
    # contact and the company link aren't wrong.
    current_company = (person.get("current_company") or "").strip()
    company_changed = bool(
        current_company and current_company.lower() != scanned_company.lower()
    )
    company_name = current_company or scanned_company
    if company_changed:
        visitor.company = current_company

    company = (
        research_svc.research_company(company_name, website=visitor.website)
        if company_name
        else {"summary": "", "competitors": [], "sources": []}
    )

    errors = [e for e in (person.get("error"), company.get("error")) if e]
    sources = list(dict.fromkeys((person.get("sources") or []) + (company.get("sources") or [])))

    # Auto-fill industry / website from company research. Done BEFORE the company
    # upsert so the Company row picks the values up too. We return the value we
    # applied (a "" means "cleared") so the UI can mirror the change; None means
    # "left as-is".
    research_industry = (company.get("industry") or "").strip()
    research_website = (company.get("website") or "").strip()
    applied_industry: str | None = None
    applied_website: str | None = None
    if company_changed:
        # The company itself was corrected, so any scanned industry/website
        # belonged to the WRONG company. Replace them with research's values,
        # clearing them when research couldn't confirm one.
        visitor.industry = research_industry or None
        visitor.website = research_website or None
        applied_industry = research_industry
        applied_website = research_website
    else:
        # Same company — only fill gaps, never clobber a value already present.
        if research_industry and not (visitor.industry or "").strip():
            visitor.industry = research_industry
            applied_industry = research_industry
        if research_website and not (visitor.website or "").strip():
            visitor.website = research_website
            applied_website = research_website

    # Persist person research. Only fill linkedin_url when we don't already
    # have one (respect a value captured from the card or typed by the user).
    if person.get("linkedin_url") and not (visitor.linkedin_url or "").strip():
        visitor.linkedin_url = person["linkedin_url"]
    if person.get("summary"):
        visitor.person_summary = person["summary"]

    # Persist company research onto the linked Company (find-or-create by name).
    company_row: Company | None = None
    if company_name:
        company_row = upsert_company_for_scan(
            db,
            user.org_id,
            name=company_name,
            website=visitor.website,
            industry=visitor.industry,
            address=visitor.address,
            gst_number=visitor.gst_number,
            phone=visitor.phone,
            email=visitor.email,
        )
        if company_row is not None:
            # Re-link when the company was corrected by research — otherwise the
            # visitor stays tied to the wrong company row from the original scan.
            if visitor.company_id is None or company_changed:
                visitor.company_id = company_row.id
            if company.get("summary"):
                company_row.summary = company["summary"]
            if company.get("competitors"):
                company_row.competitors = company["competitors"]
            company_row.research_updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(visitor)

    return ResearchOut(
        visitor=VisitorOut.model_validate(visitor),
        linkedin_url=visitor.linkedin_url,
        current_company=current_company or None,
        industry=applied_industry,
        website=applied_website,
        person_summary=visitor.person_summary,
        company_summary=(company_row.summary if company_row else None) or company.get("summary") or None,
        competitors=(company_row.competitors if company_row and company_row.competitors else company.get("competitors")) or [],
        sources=sources,
        error="; ".join(errors) if errors else None,
    )


async def _read_and_scan(path: Path, client_qr_payload: str | None = None) -> dict[str, Any]:
    async with aiofiles.open(path, "rb") as f:
        blob = await f.read()
    return scan_image(blob, client_qr_payload=client_qr_payload)


@router.get("/history", response_model=list[VisitorOut])
def scan_history(
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> list[Visitor]:
    """All visitors created (or last updated) via the scanner."""
    return list(
        db.scalars(
            select(Visitor)
            .where(Visitor.org_id == user.org_id, Visitor.source == "scan")
            .order_by(Visitor.created_at.desc())
        )
    )
