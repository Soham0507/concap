"""Plaud integration endpoints — per-USER OAuth connection + recording sync.

Connection model: each *user* connects their own Plaud account (voice
recordings are personal). Access + refresh tokens are stored encrypted on the
user row — there is no shared/global account.

The OAuth callback (`/oauth/callback`) is a top-level browser redirect from
Plaud with no bearer header, so it authenticates via the signed `state` and
lives on a separate, unprotected router (registered in main.py). Every other
endpoint requires a bearer token.

`POST /sync` pulls the user's recordings from the Plaud MCP server, dedupes on
the Plaud recording id (PlaudRecording mapping), and for each new recording
creates BOTH (a) a queued MeetingDocument (meeting_source="plaud") that the
meeting worker turns into Minutes-of-Meeting, and (b) a Conversation that runs
through the standard Concap analysis pipeline so the recording also shows up in
Conversations + the Dashboard. Recordings imported before the conversation
bridge existed are backfilled into a Conversation on the next sync.
"""
from __future__ import annotations

import logging
from urllib.parse import quote

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import Conversation, MeetingDocument, PlaudRecording, User, Visitor
from ..services import plaud_mcp
from ..services import plaud_oauth as oauth
from ..services.meeting_intelligence import generate_transcript_id
from .auth import is_preview_user, require_user
from .conversations import _run_pipeline_in_background

logger = logging.getLogger("concap.plaud.router")

router = APIRouter(prefix="/api/plaud", tags=["plaud"])
# Public router for the OAuth callback — no bearer dependency (auth via state).
public_router = APIRouter(prefix="/api/plaud", tags=["plaud"])

# Cap a single sync so a huge backlog can't enqueue thousands of docs at once.
MAX_SYNC = 200


def _require_personal_account(user: User) -> None:
    if is_preview_user(user):
        raise HTTPException(
            status_code=403,
            detail="Sign in with your own account to connect or sync Plaud. The shared preview workspace cannot hold private recordings.",
        )


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

@router.get("/status")
def plaud_status(db: Session = Depends(get_db), user: User = Depends(require_user)) -> dict:
    """Report the current user's Plaud connection state. Never exposes tokens."""
    if is_preview_user(user):
        return {
            "oauth_configured": False,
            "connected": False,
            "needs_reconnect": False,
            "preview_only": True,
            "reason": "Sign in with your own account to connect Plaud. Private recordings must not be imported into the shared preview workspace.",
        }
    s = get_settings()
    base = {"oauth_configured": s.plaud_oauth_configured()}

    if user.plaud_access_token_enc:
        if user.plaud_needs_reconnect:
            return {
                **base,
                "connected": False,
                "needs_reconnect": True,
                "account_email": user.plaud_account_email,
                "reason": "Plaud connection expired — please reconnect.",
            }
        return {
            **base,
            "connected": True,
            "needs_reconnect": False,
            "account_email": user.plaud_account_email,
            "account_name": user.plaud_account_name,
            "connected_at": user.plaud_connected_at.isoformat() if user.plaud_connected_at else None,
            "last_synced_at": user.plaud_last_synced_at.isoformat() if user.plaud_last_synced_at else None,
        }

    return {
        **base,
        "connected": False,
        "needs_reconnect": False,
        "reason": None if base["oauth_configured"] else (
            "Plaud OAuth is not configured on this server. An administrator must "
            "set PUBLIC_BASE_URL. Personal-account OAuth registration is automatic; "
            "Embedded Developer Portal keys are not used for this connection."
        ),
    }


# ---------------------------------------------------------------------------
# Imported library — read existing data without contacting Plaud.
# ---------------------------------------------------------------------------

def _library_query(db: Session, user: User):
    _require_personal_account(user)
    return db.query(PlaudRecording).filter(
        PlaudRecording.user_id == user.id,
        PlaudRecording.org_id == user.org_id,
    )


@router.get("/recordings")
def plaud_recordings(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """The user's imported library stays readable after disconnecting Plaud."""
    query = _library_query(db, user)
    rows = query.order_by(PlaudRecording.synced_at.desc(), PlaudRecording.id.desc()).offset(offset).limit(limit).all()
    items = []
    for row in rows:
        doc = db.query(MeetingDocument).filter(
            MeetingDocument.id == row.document_id,
            MeetingDocument.org_id == user.org_id,
            MeetingDocument.user_id == user.id,
        ).first()
        items.append({
            "id": row.id,
            "title": row.title or "Untitled Plaud recording",
            "synced_at": row.synced_at.isoformat() if row.synced_at else None,
            "meeting_date": doc.meeting_date if doc else None,
            "analysis_status": doc.status if doc else "unavailable",
        })
    return {"items": items, "total": query.count(), "offset": offset, "limit": limit}


@router.get("/recordings/{recording_id}")
def plaud_recording_detail(
    recording_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    row = _library_query(db, user).filter(PlaudRecording.id == recording_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Recording not found")
    doc = db.query(MeetingDocument).filter(
        MeetingDocument.id == row.document_id,
        MeetingDocument.org_id == user.org_id,
        MeetingDocument.user_id == user.id,
    ).first()
    conv = db.query(Conversation).filter(
        Conversation.id == row.conversation_id,
        Conversation.org_id == user.org_id,
    ).first()
    return {
        "id": row.id,
        "title": row.title or "Untitled Plaud recording",
        "transcript": doc.transcript_text if doc else (conv.transcript if conv else None),
        "plaud_summary": doc.source_summary if doc else None,
        "meeting_analysis": doc.document_markdown if doc else None,
        "analysis_status": doc.status if doc else "unavailable",
        "conversation_id": conv.id if conv else None,
        "document_id": doc.id if doc else None,
    }


# ---------------------------------------------------------------------------
# OAuth connect (start + callback)
# ---------------------------------------------------------------------------

@router.get("/oauth/start")
def plaud_oauth_start(db: Session = Depends(get_db), user: User = Depends(require_user)) -> dict:
    """Return the Plaud authorize URL for the current user. The frontend
    navigates the browser to it. We return JSON (not a 302) because this call
    is made via an authenticated fetch — a redirect from fetch wouldn't drive
    the top-level browser navigation."""
    _require_personal_account(user)
    try:
        url = oauth.authorize_url(db, user)
    except oauth.PlaudOAuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"authorize_url": url}


def _redirect_integrations(*, connected: bool = False, error: str | None = None) -> RedirectResponse:
    params = []
    if connected:
        params.append("plaud=connected")
    if error:
        params.append(f"plaud_error={quote(error)}")
    suffix = ("?" + "&".join(params)) if params else ""
    return RedirectResponse(url=f"/integrations{suffix}", status_code=302)


@public_router.get("/oauth/callback")
def plaud_oauth_callback(
    db: Session = Depends(get_db),
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
) -> RedirectResponse:
    """OAuth redirect target. Authenticated by the signed `state` (no bearer).
    Always redirects back to /integrations with a status query param."""
    if error:
        return _redirect_integrations(error=error)
    if not code or not state:
        return _redirect_integrations(error="Missing authorization code")
    try:
        payload = oauth.verify_state(state)
    except oauth.PlaudOAuthError as exc:
        return _redirect_integrations(error=str(exc))

    user = db.get(User, int(payload.get("uid", 0)))
    if user is None or not user.is_active:
        return _redirect_integrations(error="Unknown user")
    if is_preview_user(user):
        return _redirect_integrations(error="Sign in with your own account to connect Plaud.")

    try:
        oauth.consume_state(db, user, payload)
        oauth.complete_connection(db, user, code)
    except oauth.PlaudOAuthError as exc:
        logger.warning("Plaud connect failed for user #%s: %s", user.id, exc)
        return _redirect_integrations(error=str(exc))
    logger.info("Plaud connected for user #%s", user.id)
    return _redirect_integrations(connected=True)


# ---------------------------------------------------------------------------
# Disconnect
# ---------------------------------------------------------------------------

@router.post("/disconnect")
def plaud_disconnect(db: Session = Depends(get_db), user: User = Depends(require_user)) -> dict:
    """Disconnect the current user's Plaud account (clears stored tokens)."""
    if user.plaud_access_token_enc or user.plaud_client_id:
        oauth.disconnect(db, user)
    return {"connected": False, "disconnected": True}


# ---------------------------------------------------------------------------
# Sync recordings -> queued meeting documents
# ---------------------------------------------------------------------------

def _recording_id(rec: dict) -> str | None:
    for key in ("id", "file_id", "fileId", "recording_id", "recordingId", "uuid"):
        val = rec.get(key)
        if val not in (None, ""):
            return str(val)
    return None


def _recording_title(rec: dict) -> str | None:
    for key in ("title", "name", "filename", "file_name"):
        val = rec.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()[:300]
    return None


def _recording_date(rec: dict) -> str | None:
    for key in ("created_at", "createdAt", "date", "recorded_at", "start_time"):
        val = rec.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def _user_display(user: User) -> str | None:
    return (user.name or "").strip() or (user.email or "").strip() or None


def _get_or_create_plaud_conversation(
    db: Session, user: User, *, file_id: str, title: str | None, transcript: str
) -> tuple[Conversation | None, bool]:
    """Create (or return the existing) Conversation for a Plaud recording.

    Each recording gets its own placeholder Visitor (source="plaud") so it
    behaves like a normal lead in the Conversations list + Dashboard. The
    transcript is set up-front; the caller schedules the standard analysis
    pipeline which fills in summary/lead score/topic/etc. Deduped on a
    deterministic ``client_capture_id`` so a recording maps to at most one
    conversation even across backfills.

    Returns ``(conversation, created)``. ``created`` is False when a
    conversation already existed (so the caller doesn't re-run analysis).
    """
    # Namespace the capture id by org so a Plaud file id that happens to collide
    # across accounts can never resolve another tenant's conversation. The query
    # is also org-scoped for defense in depth.
    cap_id = f"plaud:{user.org_id}:{file_id}"
    existing = (
        db.query(Conversation)
        .filter(
            Conversation.org_id == user.org_id,
            Conversation.client_capture_id == cap_id,
        )
        .first()
    )
    if existing is not None:
        return existing, False
    if len((transcript or "").strip()) < 20:
        return None, False

    visitor = Visitor(
        org_id=user.org_id,
        name=((title or "").strip()[:200] or "Plaud recording"),
        source="plaud",
        contact_type="lead",
    )
    db.add(visitor)
    db.flush()

    conv = Conversation(
        org_id=user.org_id,
        visitor_id=visitor.id,
        staff_name=_user_display(user),
        event_name="Plaud",
        transcript=transcript,
        status="created",
        client_capture_id=cap_id,
    )
    db.add(conv)
    db.flush()
    return conv, True


@router.post("/sync")
def plaud_sync(
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """Pull the user's Plaud recordings, dedupe on the Plaud recording id, and
    for each new one create a queued meeting document AND a Conversation that
    runs through the standard Concap analysis pipeline. Idempotent: re-running
    only imports recordings not already mapped, and backfills a Conversation
    for any previously-imported recording that doesn't have one yet."""
    _require_personal_account(user)
    try:
        token = oauth.get_valid_access_token(db, user)
    except oauth.PlaudOAuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        recordings = plaud_mcp.list_files(token)
    except plaud_mcp.PlaudMCPAuthError as exc:
        oauth._mark_needs_reconnect(db, user)
        raise HTTPException(status_code=400, detail="Plaud connection expired — please reconnect.") from exc
    except plaud_mcp.PlaudMCPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not read Plaud recordings: {exc}") from exc

    # Existing mappings for this user, keyed by file id — the dedup set, which
    # also lets us backfill a Conversation onto a recording imported before the
    # conversation bridge existed.
    existing = {
        r.plaud_file_id: r
        for r in db.query(PlaudRecording)
        .filter(PlaudRecording.user_id == user.id)
        .all()
    }

    imported = 0
    skipped_existing = 0
    skipped_empty = 0
    errors = 0
    conversations_created = 0
    new_conversation_ids: list[int] = []
    for rec in recordings:
        if imported >= MAX_SYNC:
            break
        file_id = _recording_id(rec)
        if not file_id:
            continue
        if file_id in existing:
            skipped_existing += 1
            # Backfill a Conversation for an already-imported recording that
            # never got one (imported before the conversation bridge existed).
            mapping = existing[file_id]
            if mapping is not None and mapping.conversation_id is None:
                doc = db.get(MeetingDocument, mapping.document_id) if mapping.document_id else None
                body = (doc.transcript_text if doc else "") or ""
                conv, created = _get_or_create_plaud_conversation(
                    db, user, file_id=file_id,
                    title=mapping.title or (doc.meeting_title if doc else None),
                    transcript=body,
                )
                if conv is not None:
                    mapping.conversation_id = conv.id
                    if created:
                        new_conversation_ids.append(conv.id)
                        conversations_created += 1
            continue

        try:
            transcript = plaud_mcp.get_transcript(token, file_id)
            note = plaud_mcp.get_note(token, file_id)
        except plaud_mcp.PlaudMCPAuthError as exc:
            oauth._mark_needs_reconnect(db, user)
            raise HTTPException(status_code=400, detail="Plaud connection expired — please reconnect.") from exc
        except plaud_mcp.PlaudMCPError as exc:
            logger.warning("Plaud fetch failed for file %s: %s", file_id, exc)
            errors += 1
            continue

        summary_text = (note or {}).get("text") or ""
        # The worker needs >=20 chars of transcript to extract. Fall back to the
        # Plaud summary when no transcript is available; skip truly empty ones.
        body_text = transcript if len(transcript.strip()) >= 20 else summary_text
        if len(body_text.strip()) < 20:
            skipped_empty += 1
            continue

        title = _recording_title(rec)
        doc = MeetingDocument(
            org_id=user.org_id,
            user_id=user.id,
            transcript_id=generate_transcript_id(),
            meeting_source="plaud",
            meeting_date=_recording_date(rec),
            meeting_title=title,
            participants=[],
            transcript_text=body_text,
            external_id=file_id,
            source_summary=summary_text or None,
            source_summary_json=(note or {}).get("json"),
            status="queued",
        )
        db.add(doc)
        db.flush()
        # Also surface the recording as a standard Concap conversation.
        conv, created = _get_or_create_plaud_conversation(
            db, user, file_id=file_id, title=title, transcript=body_text,
        )
        db.add(PlaudRecording(
            org_id=user.org_id,
            user_id=user.id,
            plaud_file_id=file_id,
            title=title,
            document_id=doc.id,
            conversation_id=conv.id if conv is not None else None,
        ))
        if conv is not None and created:
            new_conversation_ids.append(conv.id)
            conversations_created += 1
        existing[file_id] = None  # mark seen for this run (value unused)
        imported += 1

    from ..models import utcnow
    user.plaud_last_synced_at = utcnow()
    db.commit()

    # Run the standard analysis pipeline for each new conversation in the
    # background so the sync request returns promptly.
    for conv_id in new_conversation_ids:
        background.add_task(_run_pipeline_in_background, conv_id)

    logger.info(
        "Plaud sync user #%s: imported=%d conversations=%d skipped_existing=%d "
        "skipped_empty=%d errors=%d total_seen=%d",
        user.id, imported, conversations_created, skipped_existing,
        skipped_empty, errors, len(recordings),
    )
    return {
        "imported": imported,
        "conversations_created": conversations_created,
        "skipped_existing": skipped_existing,
        "skipped_empty": skipped_empty,
        "errors": errors,
        "total_seen": len(recordings),
    }
