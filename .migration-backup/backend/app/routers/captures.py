"""One-shot capture endpoint used by the offline queue.

The booth client stores each capture (visitor + consent + audio) in
IndexedDB along with a client-generated UUID. When the network is up,
the client POSTs the whole thing to `/api/captures`. If a duplicate
client_capture_id arrives (e.g. response was lost on the wire), we
return the existing conversation instead of double-inserting.

This collapses the four sequential calls that the online flow makes
(`POST /visitors`, `POST /consent`, `POST /conversations`, `POST .../audio`)
into one atomic, idempotent request that the queue can retry safely.
"""
import json
import uuid
from pathlib import Path

import aiofiles
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import SessionLocal, get_db
from ..models import Company, Consent, Conversation, User, Visitor
from ..schemas import ConversationOut
from ..services.pipeline import process_conversation
from .auth import require_user

router = APIRouter(prefix="/api/captures", tags=["captures"])

ALLOWED_AUDIO_EXTS = {".webm", ".wav", ".mp3", ".m4a", ".mp4", ".ogg", ".flac"}


def _run_pipeline_in_background(conversation_id: int) -> None:
    db = SessionLocal()
    try:
        process_conversation(db, conversation_id)
    finally:
        db.close()


@router.post("", response_model=ConversationOut)
async def submit_capture(
    request: Request,
    background: BackgroundTasks,
    metadata: str = Form(...),
    audio: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> Conversation:
    """Accept a full booth capture in one shot.

    `metadata` is a JSON-encoded form field:
        {
          "client_capture_id": "uuid-v4",
          "visitor": { name, company, email, phone, designation, industry,
                       interest_category, badge_id, source },
          "consent": { recording_consent, data_processing_consent,
                       marketing_consent, consent_text, consent_version },
          "staff_name": "..."  (optional)
        }
    """
    settings = get_settings()

    try:
        meta = json.loads(metadata)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="metadata field is not valid JSON")

    client_capture_id = (meta.get("client_capture_id") or "").strip()
    if not client_capture_id:
        raise HTTPException(status_code=400, detail="metadata.client_capture_id is required")

    # Idempotency: if this capture ID already exists, return it. The client's
    # retry loop relies on this so duplicate sends are safe. Scoped to org so
    # a guessed/collided id can't leak another org's conversation.
    existing = db.scalar(
        select(Conversation).where(
            Conversation.client_capture_id == client_capture_id,
            Conversation.org_id == user.org_id,
        )
    )
    if existing is not None:
        return existing

    v = meta.get("visitor") or {}
    name = (v.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="visitor.name is required")

    # Optional pre-record company pick from the booth UI's typeahead. We
    # validate ownership here (the FK can't be enforced retroactively on
    # SQLite) so a guessed id can never link a transcript into another org.
    requested_company_id_raw = meta.get("company_id")
    requested_company: Company | None = None
    if requested_company_id_raw is not None:
        try:
            requested_company_id = int(requested_company_id_raw)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="metadata.company_id must be an integer")
        requested_company = db.get(Company, requested_company_id)
        if requested_company is None or requested_company.org_id != user.org_id:
            raise HTTPException(status_code=404, detail="Company not found")

    # Consent block is optional now. When present, we still persist it for
    # audit; when absent, the capture proceeds without a Consent row.
    consent = meta.get("consent") or None

    suffix = Path(audio.filename or "").suffix.lower() or ".webm"
    if suffix not in ALLOWED_AUDIO_EXTS:
        raise HTTPException(status_code=415, detail=f"Unsupported audio type: {suffix}")

    # 1) Find-or-create visitor with email/phone dedup.
    visitor: Visitor | None = None
    email = (v.get("email") or "").strip() or None
    phone = (v.get("phone") or "").strip() or None
    if email or phone:
        ident = []
        if email:
            ident.append(Visitor.email == email)
        if phone:
            ident.append(Visitor.phone == phone)
        visitor = db.scalar(
            select(Visitor).where(and_(Visitor.org_id == user.org_id, or_(*ident)))
        )

    if visitor is None:
        visitor = Visitor(
            org_id=user.org_id,
            name=name,
            # Prefer the typed-company string from the picker (canonical) over
            # whatever the visitor block carried; falls back to the raw text.
            company=(requested_company.name if requested_company else (v.get("company") or None)),
            company_id=(requested_company.id if requested_company else None),
            email=email,
            phone=phone,
            designation=(v.get("designation") or None),
            industry=(v.get("industry") or None),
            interest_category=(v.get("interest_category") or None),
            badge_id=(v.get("badge_id") or None),
            source=(v.get("source") or "manual"),
            notes=(v.get("notes") or None),
        )
        db.add(visitor)
        db.flush()
    elif requested_company is not None and visitor.company_id != requested_company.id:
        # Existing visitor (matched by email/phone) — let the booth pick
        # re-assign them to a different company. The contact-form UI offers
        # the same affordance; keeping behaviour consistent.
        visitor.company_id = requested_company.id
        visitor.company = requested_company.name

    # 2) Record consent only when the client supplied it. The consent
    #    feature is disabled in the booth UI by request; the model + endpoint
    #    remain available for clients that still want to use them.
    if consent:
        consent_row = Consent(
            visitor_id=visitor.id,
            recording_consent=bool(consent.get("recording_consent")),
            data_processing_consent=bool(consent.get("data_processing_consent")),
            marketing_consent=bool(consent.get("marketing_consent")),
            consent_text=str(consent.get("consent_text") or ""),
            consent_version=str(consent.get("consent_version") or "v1"),
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
        db.add(consent_row)

    # 3) Persist audio to disk.
    target_dir = settings.audio_path
    target_name = f"capture_{client_capture_id}_{uuid.uuid4().hex}{suffix}"
    target_path = target_dir / target_name

    max_bytes = settings.max_audio_mb * 1024 * 1024
    written = 0
    async with aiofiles.open(target_path, "wb") as out:
        while chunk := await audio.read(1024 * 1024):
            written += len(chunk)
            if written > max_bytes:
                await out.close()
                target_path.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail=f"Audio exceeds {settings.max_audio_mb} MB limit")
            await out.write(chunk)

    if written == 0:
        target_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Empty audio upload")

    # 4) Create conversation in 'uploaded' state and queue the pipeline.
    #    company_id is set directly here (Option 5 Hybrid): the booth picker
    #    is authoritative; otherwise inherit from the resolved visitor. The
    #    inherit path re-checks org membership so a corrupted/legacy
    #    visitor.company_id pointing at another tenant doesn't get carried
    #    onto the new Conversation. If it fails the check, we land unlinked.
    if requested_company is not None:
        conv_company_id: int | None = requested_company.id
    elif visitor.company_id is not None:
        inherit = db.get(Company, visitor.company_id)
        conv_company_id = inherit.id if (inherit is not None and inherit.org_id == user.org_id) else None
    else:
        conv_company_id = None
    conv = Conversation(
        org_id=user.org_id,
        visitor_id=visitor.id,
        company_id=conv_company_id,
        staff_name=(meta.get("staff_name") or user.name or user.email),
        event_name=settings.event_name,
        booth_name=settings.booth_name,
        audio_filename=str(target_path),
        audio_mime=audio.content_type,
        status="uploaded",
        client_capture_id=client_capture_id,
    )
    db.add(conv)
    db.commit()
    db.refresh(conv)

    background.add_task(_run_pipeline_in_background, conv.id)
    return conv


@router.get("/{client_capture_id}", response_model=ConversationOut)
def lookup_by_client_id(
    client_capture_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> Conversation:
    """Used by the offline queue to check whether a capture was already accepted."""
    conv = db.scalar(
        select(Conversation).where(
            Conversation.client_capture_id == client_capture_id,
            Conversation.org_id == user.org_id,
        )
    )
    if conv is None:
        raise HTTPException(status_code=404, detail="Capture not found")
    return conv
