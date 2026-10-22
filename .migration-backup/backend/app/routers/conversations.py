import csv
import io
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

import aiofiles
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import SessionLocal, get_db
from ..models import Company, Conversation, EventDay, User, Visitor
from ..schemas import (
    ConversationCreate,
    ConversationLinkCompany,
    ConversationLinkContact,
    ConversationListItem,
    ConversationOut,
)
from ..services.hubspot import HubSpotError, HubSpotNotConfigured, sync_conversation
from ..services.salesforce import (
    SalesforceError,
    SalesforceNotConfigured,
    sync_conversation as sync_conversation_salesforce,
)
from ..services.pipeline import process_conversation
from .auth import require_user

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

ALLOWED_AUDIO_EXTS = {".webm", ".wav", ".mp3", ".m4a", ".mp4", ".ogg", ".flac"}


def _resolve_owned_company(db: Session, company_id: int | None, user: User) -> Company | None:
    """Look up a company by id and confirm it belongs to the caller's org.
    Raises 404 for missing or cross-tenant ids. Returns None when no id
    is supplied (caller decides how to fall back)."""
    if company_id is None:
        return None
    c = db.get(Company, company_id)
    if c is None or c.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Company not found")
    return c


def _safe_inherit_company_id(db: Session, company_id: int | None, user: User) -> int | None:
    """Inheritance path (visitor -> conversation): return the id only if
    the company is in the caller's org. Unlike `_resolve_owned_company`
    this never raises — a corrupted cross-tenant id is silently dropped
    so the conversation lands unlinked rather than carrying a leaky link.
    """
    if company_id is None:
        return None
    c = db.get(Company, company_id)
    if c is None or c.org_id != user.org_id:
        return None
    return company_id


def _to_conversation_out(conv: Conversation, db: Session) -> ConversationOut:
    """Build a ConversationOut with the joined company name + suggested
    company surfaced from the analysis blob for the frontend's chips.

    Tenant-isolation belt-and-braces: the Company lookup is scoped to the
    conversation's own org_id so a stray cross-tenant company_id (created
    by some future bug, manual SQL, or a corrupted visitor inherit) can't
    leak the other org's company name through this endpoint. If the FK
    resolves to nothing in-org, we surface company_id=None so the UI shows
    the transcript as unlinked rather than half-linked.
    """
    out = ConversationOut.model_validate(conv)
    if conv.event_day is not None:
        out.event_day_label = conv.event_day.label or f"Day {conv.event_day.day_number}"
    if conv.company_id is not None:
        c = db.scalar(
            select(Company).where(
                Company.id == conv.company_id,
                Company.org_id == conv.org_id,
            )
        )
        if c is not None:
            out.company_name = c.name
        else:
            out.company_id = None
    # Only surface the chip when the transcript is actually unlinked at the
    # row level. Using conv.company_id (not the joined row) means a dangling
    # cross-tenant id still hides the suggestion instead of mis-prompting.
    if conv.company_id is None and isinstance(conv.analysis, dict):
        sc = str(conv.analysis.get("suggested_company") or "").strip()
        if sc:
            out.suggested_company = sc
    if isinstance(conv.analysis, dict):
        block = conv.analysis.get("consent")
        if isinstance(block, dict):
            out.consent = block
    return out


@router.post("", response_model=ConversationOut, status_code=status.HTTP_201_CREATED)
def create_conversation(
    payload: ConversationCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> ConversationOut:
    settings = get_settings()
    visitor = db.get(Visitor, payload.visitor_id)
    if visitor is None or visitor.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Visitor not found")

    # Explicit > visitor's existing link. Either path is validated against
    # the caller's org so the FK can't be abused to leak data cross-tenant.
    # When inheriting from the visitor we re-resolve via the org-scoped
    # helper so a corrupted visitor.company_id (a cross-tenant id smuggled
    # in by some other code path) is silently dropped rather than carried.
    explicit = _resolve_owned_company(db, payload.company_id, user)
    inherited = _safe_inherit_company_id(db, visitor.company_id, user)
    company_id = explicit.id if explicit else inherited

    conv = Conversation(
        org_id=user.org_id,
        visitor_id=visitor.id,
        company_id=company_id,
        staff_name=payload.staff_name,
        event_name=settings.event_name,
        booth_name=settings.booth_name,
        status="created",
    )
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return _to_conversation_out(conv, db)


@router.patch("/{conversation_id}/company", response_model=ConversationOut)
def link_conversation_to_company(
    conversation_id: int,
    payload: ConversationLinkCompany,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> ConversationOut:
    """Manual relink / unlink. Pass `company_id: null` to clear the link.
    Used by the company-detail page's "move transcript" affordance and by
    the "Suggested: Acme — confirm" chip on the dashboard.
    """
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    target = _resolve_owned_company(db, payload.company_id, user)
    conv.company_id = target.id if target else None
    db.commit()
    db.refresh(conv)
    return _to_conversation_out(conv, db)


@router.patch("/{conversation_id}/contact", response_model=ConversationOut)
def link_conversation_to_contact(
    conversation_id: int,
    payload: ConversationLinkContact,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> ConversationOut:
    """Reassign a conversation to a different in-org contact (visitor).

    The conversation's company link is re-resolved from the new contact's
    company so the displayed company stays consistent with the contact.
    Cross-tenant conversation or visitor ids are treated as 404 so the FK
    can't be abused to attach another tenant's data.
    """
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    visitor = db.get(Visitor, payload.visitor_id)
    if visitor is None or visitor.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Contact not found")
    conv.visitor_id = visitor.id
    conv.company_id = _safe_inherit_company_id(db, visitor.company_id, user)
    db.commit()
    db.refresh(conv)
    return _to_conversation_out(conv, db)


def _run_pipeline_in_background(conversation_id: int) -> None:
    """Background task: open a fresh session so we don't reuse the request session."""
    db = SessionLocal()
    try:
        process_conversation(db, conversation_id)
    finally:
        db.close()


@router.post("/{conversation_id}/audio", response_model=ConversationOut)
async def upload_audio(
    conversation_id: int,
    background: BackgroundTasks,
    file: UploadFile = File(...),
    auto_process: bool = Form(default=True),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> Conversation:
    settings = get_settings()
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Conversation not found")

    suffix = Path(file.filename or "").suffix.lower() or ".webm"
    if suffix not in ALLOWED_AUDIO_EXTS:
        raise HTTPException(status_code=415, detail=f"Unsupported audio type: {suffix}")

    target_dir = settings.audio_path
    target_name = f"conv_{conversation_id}_{uuid.uuid4().hex}{suffix}"
    target_path = target_dir / target_name

    max_bytes = settings.max_audio_mb * 1024 * 1024
    written = 0
    async with aiofiles.open(target_path, "wb") as out:
        while chunk := await file.read(1024 * 1024):
            written += len(chunk)
            if written > max_bytes:
                await out.close()
                target_path.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail=f"Audio exceeds {settings.max_audio_mb} MB limit")
            await out.write(chunk)

    if written == 0:
        target_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Empty audio upload")

    conv.audio_filename = str(target_path)
    conv.audio_mime = file.content_type
    conv.status = "uploaded"
    conv.error_message = None
    db.commit()
    db.refresh(conv)

    if auto_process:
        background.add_task(_run_pipeline_in_background, conv.id)

    return conv


@router.get("/{conversation_id}/audio")
def get_conversation_audio(
    conversation_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> FileResponse:
    """Stream a conversation's recorded audio for inline playback.

    Org-scoped: a conversation that isn't in the caller's org is treated the
    same as one that doesn't exist (404), so the endpoint never confirms the
    existence of another tenant's recording. Also 404s when no audio was ever
    attached or the backing file has gone missing from disk.

    Starlette's FileResponse honors the Range request header, so the audio
    can be seeked without downloading the whole clip up front.
    """
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if not conv.audio_filename:
        raise HTTPException(status_code=404, detail="No audio for this conversation")

    # Defense in depth: only ever serve files that resolve inside the
    # configured audio directory, so a corrupted/tampered audio_filename row
    # can't be used to read arbitrary files off disk.
    audio_root = get_settings().audio_path.resolve()
    path = Path(conv.audio_filename).resolve()
    if audio_root not in path.parents:
        raise HTTPException(status_code=404, detail="Audio file is missing")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Audio file is missing")
    return FileResponse(
        path,
        media_type=conv.audio_mime or "application/octet-stream",
        headers={"Content-Disposition": f'inline; filename="conversation_{conversation_id}{path.suffix}"'},
    )


@router.post("/{conversation_id}/process", response_model=ConversationOut)
def reprocess(
    conversation_id: int,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> Conversation:
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if not conv.audio_filename and not (conv.transcript or "").strip():
        raise HTTPException(status_code=400, detail="Nothing to analyze — no audio or transcript on this conversation")
    conv.status = "queued"
    conv.error_message = None
    db.commit()
    db.refresh(conv)
    background.add_task(_run_pipeline_in_background, conv.id)
    return conv


@router.delete("/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(
    conversation_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> Response:
    """Permanently delete a conversation (and its recording file).

    Org-scoped: a conversation outside the caller's org is treated as missing
    (404) so the endpoint never confirms another tenant's data. Related rows
    are handled by the DB's declared foreign keys — action items cascade-delete,
    while Plaud recordings and quotes have their conversation link set to NULL
    (so re-syncing Plaud will simply re-create the conversation)."""
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Best-effort remove the backing audio file, but only if it safely resolves
    # inside the configured audio directory (never follow a tampered path).
    if conv.audio_filename:
        try:
            audio_root = get_settings().audio_path.resolve()
            path = Path(conv.audio_filename).resolve()
            if audio_root in path.parents and path.is_file():
                path.unlink()
        except OSError:
            # A missing/locked file shouldn't block deleting the DB record.
            pass

    db.delete(conv)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("", response_model=list[ConversationListItem])
def list_conversations(
    event_id: int | None = Query(default=None, description="Filter by Event id (any of its days)"),
    event_day_id: int | None = Query(default=None, description="Filter by a specific EventDay id"),
    session_id: int | None = Query(default=None, description="Filter by source long-capture Session id"),
    from_date: date | None = Query(default=None, description="Inclusive lower bound on capture date (YYYY-MM-DD)"),
    to_date: date | None = Query(default=None, description="Inclusive upper bound on capture date (YYYY-MM-DD)"),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> list[ConversationListItem]:
    stmt = (
        select(Conversation, Visitor, EventDay, Company)
        .join(Visitor, Visitor.id == Conversation.visitor_id)
        .outerjoin(EventDay, EventDay.id == Conversation.event_day_id)
        # Org guard goes in the ON clause (not WHERE) so a cross-tenant
        # company_id simply yields NULL on the join instead of either
        # leaking the name or dropping the conversation from the list.
        .outerjoin(
            Company,
            and_(Company.id == Conversation.company_id, Company.org_id == user.org_id),
        )
        .where(Conversation.org_id == user.org_id)
    )
    if event_day_id is not None:
        stmt = stmt.where(Conversation.event_day_id == event_day_id)
    elif event_id is not None:
        # Match any conversation whose event_day belongs to this event. Inner-
        # join semantics are fine here because conversations without an
        # event_day should not match an event filter.
        stmt = stmt.where(EventDay.event_id == event_id)
    if session_id is not None:
        stmt = stmt.where(Conversation.session_id == session_id)
    if from_date is not None:
        stmt = stmt.where(Conversation.created_at >= datetime.combine(from_date, datetime.min.time()))
    if to_date is not None:
        # Inclusive upper bound — bump to the start of the next day.
        stmt = stmt.where(Conversation.created_at < datetime.combine(to_date + timedelta(days=1), datetime.min.time()))
    rows = db.execute(stmt.order_by(Conversation.created_at.desc())).all()
    def _suggested(analysis) -> str | None:
        if isinstance(analysis, dict):
            s = str(analysis.get("suggested_company") or "").strip()
            return s or None
        return None

    def _topic(conv) -> str | None:
        # Mirror the detail view's title fallback: prefer the denormalized
        # `topic` column, but older rows analyzed before that column was
        # populated only carry the label inside the analysis JSON blob.
        if (conv.topic or "").strip():
            return conv.topic.strip()
        if isinstance(conv.analysis, dict):
            t = str(conv.analysis.get("topic") or "").strip()
            return t or None
        return None
    return [
        ConversationListItem(
            id=c.id,
            visitor_id=c.visitor_id,
            visitor_name=v.name,
            visitor_company=v.company,
            staff_name=c.staff_name,
            status=c.status,
            lead_score=c.lead_score,
            lead_temperature=c.lead_temperature,
            duration_seconds=c.duration_seconds,
            created_at=c.created_at,
            event_name=c.event_name,
            event_day_label=(d.label or f"Day {d.day_number}") if d else None,
            company_id=co.id if co else None,
            company_name=co.name if co else None,
            # Only prompt the user to confirm a suggestion when the row
            # itself has no link. A dangling cross-tenant company_id (co
            # is None but c.company_id is not) shouldn't surface a chip.
            suggested_company=_suggested(c.analysis) if c.company_id is None else None,
            has_audio=bool(c.audio_filename),
            topic=_topic(c),
        )
        for c, v, d, co in rows
    ]


@router.get("/{conversation_id}", response_model=ConversationOut)
def get_conversation(
    conversation_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> ConversationOut:
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return _to_conversation_out(conv, db)


@router.post("/{conversation_id}/hubspot-sync")
def hubspot_sync(
    conversation_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """Sync a conversation's contact, company, note, and (optionally)
    deal to HubSpot. Idempotent — repeated calls update existing
    HubSpot records rather than creating duplicates. Returns the
    HubSpot ids and clickable portal URLs so the UI can show
    "Synced ✓ · Open in HubSpot"."""
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Conversation not found")

    try:
        result = sync_conversation(db, conv.id)
    except HubSpotNotConfigured as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    except HubSpotError as exc:
        # Persist the error for next-render visibility, then surface
        # HubSpot's own message to the caller for an actionable toast.
        conv.hubspot_sync_error = str(exc)[:1000]
        db.commit()
        status_code = 502 if exc.status_code in (0, 429, 500, 502, 503, 504) else 400
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc

    return {
        **result,
        "message": "Synced to HubSpot.",
    }


@router.post("/{conversation_id}/salesforce-sync")
def salesforce_sync(
    conversation_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """Sync a conversation's contact, account, note, and (optionally)
    opportunity to Salesforce. Idempotent — repeated calls update existing
    Salesforce records rather than creating duplicates. Returns the
    Salesforce ids and clickable record URLs so the UI can show
    "Synced ✓ · Open in Salesforce"."""
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Conversation not found")

    try:
        result = sync_conversation_salesforce(db, conv.id)
    except SalesforceNotConfigured as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    except SalesforceError as exc:
        # Persist the error for next-render visibility, then surface
        # Salesforce's own message to the caller for an actionable toast.
        conv.salesforce_sync_error = str(exc)[:1000]
        db.commit()
        status_code = 502 if exc.status_code in (0, 429, 500, 502, 503, 504) else 400
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc

    return {
        **result,
        "message": "Synced to Salesforce.",
    }


@router.get("/export/csv")
def export_csv(
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> StreamingResponse:
    rows = db.execute(
        select(Conversation, Visitor)
        .join(Visitor, Visitor.id == Conversation.visitor_id)
        .where(Conversation.org_id == user.org_id)
        .order_by(Conversation.created_at.desc())
    ).all()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "conversation_id", "created_at", "visitor_name", "company", "email", "phone",
        "designation", "industry", "staff_name", "lead_score", "lead_temperature",
        "intent", "budget_range", "urgency", "timeline", "sentiment", "buying_role",
        "pain_points", "products_discussed", "competitors_mentioned", "next_action", "summary",
    ])
    for c, v in rows:
        a = c.analysis or {}
        writer.writerow([
            c.id, c.created_at.isoformat(), v.name, v.company or "", v.email or "", v.phone or "",
            v.designation or "", v.industry or "", c.staff_name or "",
            c.lead_score if c.lead_score is not None else "", c.lead_temperature or "",
            a.get("intent", ""), a.get("budget_range", ""), a.get("urgency", ""),
            a.get("timeline", ""), a.get("sentiment", ""), a.get("buying_role", ""),
            " | ".join(a.get("pain_points", []) or []),
            " | ".join(a.get("products_discussed", []) or []),
            " | ".join(a.get("competitors_mentioned", []) or []),
            a.get("next_action", ""), a.get("summary", ""),
        ])

    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=booth_leads.csv"},
    )
