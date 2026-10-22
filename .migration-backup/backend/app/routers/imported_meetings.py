"""Imported Meetings — a dedicated tab separate from the existing Meeting
Intelligence page.

Ingests meeting transcripts from three sources, all org-scoped:
  - pasted / uploaded chat logs (Slack, Discord, email, SRT/VTT, plain text)
    normalized by ``conversation_parsers`` — no credentials needed;
  - cloud-recording transcripts pulled from Zoom / Google Meet / Microsoft
    Teams via per-org OAuth (``meeting_oauth`` + ``meeting_providers``).

On every import each anonymous speaker is fingerprinted (``voiceprints``) and
matched against the org's cross-meeting speaker registry. Routes return 404 (not
403) on a tenancy mismatch to avoid id enumeration.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    CreatedMeeting,
    ImportedMeeting,
    Organization,
    ProviderMeeting,
    SpeakerVoiceprint,
    User,
    utcnow,
)
from ..services import conversation_parsers as parsers
from ..services import email_sender
from ..services import meeting_oauth as oauth
from ..services import meeting_providers, voiceprints
from .auth import require_admin, require_user

logger = logging.getLogger("concap.imported_meetings.router")

router = APIRouter(prefix="/api/imported-meetings", tags=["imported-meetings"])
# Public router for the OAuth callback — no bearer dependency (auth via state).
public_router = APIRouter(prefix="/api/imported-meetings", tags=["imported-meetings"])

MAX_CONTENT_BYTES = 15 * 1024 * 1024  # 15 MB pasted/uploaded transcript cap.
ALLOWED_UPLOAD_EXTS = {".txt", ".md", ".srt", ".vtt", ".json", ".eml"}


def _org_or_none(db: Session, user: User) -> Organization | None:
    return db.get(Organization, user.org_id) if user.org_id else None


# --------------------------------------------------------------------------- #
# Serialization
# --------------------------------------------------------------------------- #


def _list_item(m: ImportedMeeting) -> dict:
    speakers = m.speakers or []
    return {
        "id": m.id,
        "provider": m.provider,
        "title": m.title,
        "source": m.source,
        "status": m.status,
        "started_at": m.started_at.isoformat() if m.started_at else None,
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "speaker_count": len(speakers),
        "matched_count": sum(1 for s in speakers if s.get("matched")),
        "utterance_count": len(m.utterances or []),
    }


def _detail(m: ImportedMeeting) -> dict:
    return {
        **_list_item(m),
        "transcript": m.transcript,
        "utterances": m.utterances or [],
        "speakers": m.speakers or [],
        "participants": m.participants or [],
        "error": m.error,
    }


def _registry(db: Session, org_id: int | None) -> list[dict]:
    rows = db.scalars(
        select(SpeakerVoiceprint).where(SpeakerVoiceprint.org_id == org_id)
    ).all()
    return [
        {"id": r.id, "canonical_name": r.canonical_name, "embedding": r.embedding or []}
        for r in rows
        if r.embedding
    ]


def _build_speakers(db: Session, org_id: int | None, utterances: list[dict]) -> list[dict]:
    """Summarize speakers and match them against the org's voiceprint registry."""
    samples = voiceprints.summarize_speakers(utterances)
    matches = voiceprints.match_speakers_to_registry(samples, _registry(db, org_id))
    out: list[dict] = []
    for s in samples:
        match = matches.get(s["speaker"])
        out.append({
            "speaker": s["speaker"],
            "name": match["name"] if match else None,
            "matched": bool(match),
            "confidence": round(match["confidence"], 3) if match else None,
            "voiceprint_id": match["voiceprint_id"] if match else None,
            "talk_time_ms": s["talk_time_ms"],
            "utterance_count": s["utterance_count"],
        })
    out.sort(key=lambda x: x["talk_time_ms"], reverse=True)
    return out


def _persist_meeting(
    db: Session, user: User, *, provider: str, source: str, title: str,
    content: str, utterances: list[dict], started_at=None, external_id=None,
    participants=None,
) -> ImportedMeeting:
    meeting = ImportedMeeting(
        org_id=user.org_id,
        created_by_user_id=user.id,
        provider=provider,
        external_id=external_id,
        title=(title or "Imported meeting")[:400],
        source=source,
        started_at=started_at,
        transcript=content,
        utterances=utterances,
        speakers=_build_speakers(db, user.org_id, utterances),
        participants=participants or [],
        status="completed",
    )
    db.add(meeting)
    db.commit()
    db.refresh(meeting)
    return meeting


# --------------------------------------------------------------------------- #
# CRUD + manual ingest
# --------------------------------------------------------------------------- #


@router.get("")
def list_meetings(db: Session = Depends(get_db), user: User = Depends(require_user)) -> dict:
    rows = db.scalars(
        select(ImportedMeeting)
        .where(ImportedMeeting.org_id == user.org_id)
        .order_by(ImportedMeeting.created_at.desc())
    ).all()
    return {"meetings": [_list_item(m) for m in rows]}


class ImportIn(BaseModel):
    content: str
    kind: str = "plain"  # plain | slack | discord | email | srt
    title: str | None = None


@router.post("/import")
def import_paste(payload: ImportIn, db: Session = Depends(get_db), user: User = Depends(require_user)) -> dict:
    content = (payload.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Nothing to import — content is empty.")
    if len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
        raise HTTPException(status_code=413, detail="Transcript too large (max 15 MB).")
    kind = payload.kind if payload.kind in {"plain", "slack", "discord", "email", "srt"} else "plain"
    normalized = parsers.normalize_conversation(content, kind, payload.title)
    utterances = parsers.transcript_to_utterances(normalized["content"], normalized["source"])
    meeting = _persist_meeting(
        db, user,
        provider=normalized["source"],
        source=normalized["source"],
        title=normalized["title"],
        content=normalized["content"],
        utterances=utterances,
        started_at=normalized.get("meeting_date"),
        participants=normalized.get("participants"),
    )
    return _detail(meeting)


@router.post("/upload")
async def import_upload(
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    kind: str | None = Form(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    name = file.filename or "upload"
    ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    if ext and ext not in ALLOWED_UPLOAD_EXTS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type {ext}.")
    buf = bytearray()
    while chunk := await file.read(1024 * 1024):
        buf.extend(chunk)
        if len(buf) > MAX_CONTENT_BYTES:
            raise HTTPException(status_code=413, detail="File too large (max 15 MB).")
    content = bytes(buf).decode("utf-8", "replace").strip()
    if not content:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    resolved_kind = kind if kind in {"plain", "slack", "discord", "email", "srt"} else parsers.detect_kind(name, content)
    normalized = parsers.normalize_conversation(content, resolved_kind, title or name)
    utterances = parsers.transcript_to_utterances(normalized["content"], normalized["source"])
    meeting = _persist_meeting(
        db, user,
        provider=normalized["source"],
        source=normalized["source"],
        title=normalized["title"],
        content=normalized["content"],
        utterances=utterances,
        started_at=normalized.get("meeting_date"),
        participants=normalized.get("participants"),
    )
    return _detail(meeting)


# --------------------------------------------------------------------------- #
# Speaker registry (voiceprints)
# --------------------------------------------------------------------------- #


@router.get("/speakers")
def list_speakers(db: Session = Depends(get_db), user: User = Depends(require_user)) -> dict:
    rows = db.scalars(
        select(SpeakerVoiceprint)
        .where(SpeakerVoiceprint.org_id == user.org_id)
        .order_by(SpeakerVoiceprint.canonical_name)
    ).all()
    return {"speakers": [
        {
            "id": r.id,
            "canonical_name": r.canonical_name,
            "email": r.email,
            "sample_count": r.sample_count,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]}


@router.delete("/speakers/{voiceprint_id}")
def delete_speaker(voiceprint_id: int, db: Session = Depends(get_db), user: User = Depends(require_user)) -> dict:
    vp = db.get(SpeakerVoiceprint, voiceprint_id)
    if vp is None or vp.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Speaker not found")
    db.delete(vp)
    db.commit()
    return {"deleted": True}


# --------------------------------------------------------------------------- #
# Provider OAuth + sync (declared before /{meeting_id} so paths don't collide)
# --------------------------------------------------------------------------- #


@router.get("/providers/status")
def providers_status(db: Session = Depends(get_db), user: User = Depends(require_user)) -> dict:
    org = _org_or_none(db, user)
    for p in oauth.PROVIDERS:
        oauth.ensure_account_label(db, org, p)
    return {"providers": [oauth.status(org, p) for p in oauth.PROVIDERS]}


@router.get("/providers/{provider}/oauth/start")
def provider_oauth_start(
    provider: str, db: Session = Depends(get_db), user: User = Depends(require_admin)
) -> dict:
    if provider not in oauth.PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown provider")
    org = _org_or_none(db, user)
    if org is None:
        raise HTTPException(status_code=400, detail="Your account is not attached to an organization.")
    try:
        url = oauth.authorize_url(db, org, user.id, provider)
    except oauth.MeetingOAuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"authorize_url": url}


@router.post("/providers/{provider}/disconnect")
def provider_disconnect(
    provider: str, db: Session = Depends(get_db), user: User = Depends(require_admin)
) -> dict:
    if provider not in oauth.PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown provider")
    org = _org_or_none(db, user)
    if org is not None and oauth.org_connected(org, provider):
        oauth.disconnect(db, org, provider)
    return {"connected": False, "disconnected": True}


@router.post("/providers/{provider}/sync")
def provider_sync(
    provider: str,
    since_days: int = Query(default=30, ge=1, le=365),
    limit: int = Query(default=20, ge=1, le=50),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    if provider not in oauth.PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown provider")
    org = _org_or_none(db, user)
    if org is None or not oauth.org_connected(org, provider):
        raise HTTPException(status_code=400, detail=f"{oauth.PROVIDERS[provider]['label']} is not connected.")
    try:
        fetched = meeting_providers.fetch_provider(db, org, provider, since_days=since_days, limit=limit)
    except oauth.MeetingOAuthError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    existing = set(db.scalars(
        select(ImportedMeeting.external_id).where(
            ImportedMeeting.org_id == user.org_id, ImportedMeeting.provider == provider
        )
    ).all())

    imported = 0
    skipped = 0
    for item in fetched:
        ext = item.get("external_id")
        if ext and ext in existing:
            skipped += 1
            continue
        _persist_meeting(
            db, user,
            provider=provider,
            source=provider,
            title=item.get("title") or oauth.PROVIDERS[provider]["label"],
            content=item.get("transcript") or "",
            utterances=item.get("utterances") or [],
            started_at=item.get("started_at"),
            external_id=ext,
            participants=item.get("participants"),
        )
        if ext:
            existing.add(ext)
        imported += 1
    return {"imported": imported, "skipped": skipped, "fetched": len(fetched)}


# --------------------------------------------------------------------------- #
# Meeting-history import (metadata only — no recordings/transcripts). Today this
# is wired for Zoom; the path is provider-generic so recording sync can be added
# later without touching it.
# --------------------------------------------------------------------------- #


def _serialize_provider_meeting(r: ProviderMeeting) -> dict:
    return {
        "id": r.id,
        "provider": r.provider,
        "external_id": r.external_id,
        "title": r.title,
        "host_name": r.host_name,
        "host_email": r.host_email,
        "participants": r.participants or [],
        "start_at": r.start_at.isoformat() if r.start_at else None,
        "end_at": r.end_at.isoformat() if r.end_at else None,
        "duration_minutes": r.duration_minutes,
        "status": r.status,
        "join_url": r.join_url,
    }


@router.get("/providers/{provider}/imported-meetings")
def list_provider_meetings(
    provider: str, db: Session = Depends(get_db), user: User = Depends(require_user)
) -> dict:
    if provider not in oauth.PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown provider")
    org = _org_or_none(db, user)
    if org is None:
        return {"meetings": []}
    rows = db.scalars(
        select(ProviderMeeting)
        .where(ProviderMeeting.org_id == org.id, ProviderMeeting.provider == provider)
        .order_by(ProviderMeeting.start_at.desc().nullslast(), ProviderMeeting.id.desc())
    ).all()
    return {"meetings": [_serialize_provider_meeting(r) for r in rows]}


@router.post("/providers/{provider}/import-meetings")
def import_provider_meetings(
    provider: str,
    since_days: int = Query(default=30, ge=1, le=365),
    limit: int = Query(default=50, ge=1, le=300),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    if provider not in oauth.PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown provider")
    if provider not in meeting_providers.METADATA_FETCHERS:
        raise HTTPException(
            status_code=400,
            detail=f"Meeting import is only available for Zoom, not {oauth.PROVIDERS[provider]['label']}.",
        )
    org = _org_or_none(db, user)
    if org is None or not oauth.org_connected(org, provider):
        raise HTTPException(
            status_code=400,
            detail=f"{oauth.PROVIDERS[provider]['label']} is not connected — connect it first.",
        )
    try:
        fetched = meeting_providers.fetch_provider_meetings(
            db, org, provider, since_days=since_days, limit=limit
        )
    except oauth.MeetingOAuthError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    existing = {
        r.external_id: r
        for r in db.scalars(
            select(ProviderMeeting).where(
                ProviderMeeting.org_id == org.id, ProviderMeeting.provider == provider
            )
        ).all()
        if r.external_id
    }

    imported = 0
    updated = 0
    for item in fetched:
        ext = item.get("external_id")
        row = existing.get(ext) if ext else None
        if row is not None:
            # Refresh mutable metadata (status/participants/timing) on re-import.
            # The freshly fetched item is authoritative; assign explicitly so
            # cleared values (e.g. an emptied participant list) are not retained.
            # Title is the one field we never blank out — keep the prior label if
            # the provider omits it.
            row.title = item.get("title") or row.title
            row.host_name = item.get("host_name")
            row.host_email = item.get("host_email")
            row.participants = item.get("participants") or []
            row.start_at = item.get("started_at")
            row.end_at = item.get("ended_at")
            row.duration_minutes = item.get("duration_minutes")
            row.status = item.get("status") or row.status
            row.join_url = item.get("join_url")
            updated += 1
            continue
        new_row = ProviderMeeting(
            org_id=org.id,
            created_by_user_id=user.id,
            provider=provider,
            external_id=ext,
            title=item.get("title") or oauth.PROVIDERS[provider]["label"],
            host_name=item.get("host_name"),
            host_email=item.get("host_email"),
            participants=item.get("participants") or [],
            start_at=item.get("started_at"),
            end_at=item.get("ended_at"),
            duration_minutes=item.get("duration_minutes"),
            status=item.get("status") or "completed",
            join_url=item.get("join_url"),
        )
        db.add(new_row)
        if ext:
            existing[ext] = new_row
        imported += 1
    db.commit()
    return {"imported": imported, "updated": updated, "fetched": len(fetched)}


# --------------------------------------------------------------------------- #
# Google Meet — create meeting + browse calendar (needs calendar.events scope)
# --------------------------------------------------------------------------- #


def _require_google_meet(db: Session, user: User) -> Organization:
    return _require_provider(db, user, "google_meet")


# Providers whose own calendar system emails attendees natively (Google Calendar
# via sendUpdates=all, Microsoft Outlook via Graph). For these the backend sends
# NO invitation email — it only records who was invited. Zoom is the exception:
# its API can't invite attendees, so the backend sends a branded email + ICS.
_PROVIDER_NATIVE_INVITES = {"google_meet", "ms_teams"}


def _require_provider(db: Session, user: User, provider: str) -> Organization:
    """Ensure the workspace has THIS provider connected — and only this one. Each
    provider validates its own connection so a Zoom action never errors about
    Google Meet (and vice versa)."""
    org = _org_or_none(db, user)
    if org is None or not oauth.org_connected(org, provider):
        label = _PLATFORM_LABELS.get(provider, provider)
        raise HTTPException(status_code=400, detail=f"{label} is not connected.")
    return org


class CreateMeetingIn(BaseModel):
    title: str = "Meeting"
    start: datetime | None = None       # ISO 8601; None = start in ~2 minutes
    duration_minutes: int = 30
    attendees: list[str] = []
    description: str | None = None


class UpdateCreatedMeetingIn(BaseModel):
    """Patch for a scheduled (app-created) meeting. Every field is optional —
    only the provided ones are changed. Updates the app's record of the meeting."""
    title: str | None = None
    start: datetime | None = None
    duration_minutes: int | None = None
    attendees: list[str] | None = None


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _created_status(r: CreatedMeeting) -> str:
    """Time-derived lifecycle status. Zoom/Meet don't push a cancel signal back
    to us (deleting a meeting removes it), so we only surface Scheduled / Ongoing
    / Completed from the schedule itself."""
    start = _aware(r.start_at)
    if start is None:
        return "Scheduled"
    now = datetime.now(timezone.utc)
    end = start + timedelta(minutes=r.duration_minutes or 0)
    if now < start:
        return "Scheduled"
    if now <= end:
        return "Ongoing"
    return "Completed"


def _can_join(r: CreatedMeeting) -> bool:
    """Join is enabled from a few minutes before the start (mirrors Zoom's
    join-before-host window); always joinable once it has no future start."""
    start = _aware(r.start_at)
    if start is None:
        return True
    return datetime.now(timezone.utc) >= start - timedelta(minutes=5)


def _organizer_name(db: Session, r: CreatedMeeting) -> str | None:
    if not r.created_by_user_id:
        return None
    u = db.get(User, r.created_by_user_id)
    if u is None:
        return None
    return getattr(u, "display_name", None) or getattr(u, "name", None) or getattr(u, "email", None)


def _organizer_email(db: Session, r: CreatedMeeting) -> str | None:
    """The organizer's address — used as the .ics ORGANIZER and the invitation
    Reply-To, so attendee replies reach the person who scheduled the meeting
    even though the email is sent from the app's own backend account."""
    if not r.created_by_user_id:
        return None
    u = db.get(User, r.created_by_user_id)
    return getattr(u, "email", None) if u is not None else None


# Friendly, recipient-facing platform labels. Provider-independent: just a
# display string in the invitation — delivery never depends on it.
_PLATFORM_LABELS = {
    "google_meet": "Google Meet",
    "zoom": "Zoom",
    "ms_teams": "Microsoft Teams",
    "teams": "Microsoft Teams",
}


def _clean_emails(raw: list[str] | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for e in raw or []:
        e = (e or "").strip()
        if "@" not in e:
            continue
        key = e.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    return out


def _now_iso() -> str:
    return utcnow().isoformat()


def _serialize_created_meeting(r: CreatedMeeting, db: Session | None = None) -> dict:
    invitations = r.invitations or []
    # attendee_count reflects invitation truth (who we actually emailed) — never
    # the raw attendees list, which can hold addresses whose invite send failed.
    count = len(invitations)
    return {
        "id": r.id,
        "provider": r.provider,
        "title": r.title,
        "join_url": r.join_url,
        "html_link": r.html_link,
        "start": r.start_at.isoformat() if r.start_at else None,
        "duration_minutes": r.duration_minutes,
        "attendees": r.attendees or [],
        "passcode": r.passcode,
        "meeting_id": r.external_id,
        "status": _created_status(r),
        "can_join": _can_join(r),
        "attendee_count": count,
        "invitations": invitations,
        "organizer_name": _organizer_name(db, r) if db is not None else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


def _store_created_meeting(
    db: Session, org: Organization, user: User, provider: str, result: dict,
    attendees: list[str] | None = None,
) -> CreatedMeeting:
    """Persist a meeting scheduled from this app so the org can see it later
    (shown only while ``provider`` stays connected). Returns the stored row."""
    row = CreatedMeeting(
        org_id=org.id,
        created_by_user_id=user.id,
        provider=provider,
        external_id=str(result.get("event_id")) if result.get("event_id") else None,
        title=result.get("title") or "Meeting",
        join_url=result.get("join_url"),
        html_link=result.get("html_link"),
        start_at=result.get("start"),
        duration_minutes=result.get("duration_minutes"),
        passcode=result.get("passcode"),
        attendees=_clean_emails(attendees) or (result.get("attendees") or []),
        invitations=[],
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _send_invites(
    db: Session, org: Organization, row: CreatedMeeting, emails: list[str], *, kind: str = "invite"
) -> dict:
    """Send a provider-independent invitation/update email to ``emails`` for
    ``row`` from the application's OWN backend email account (SMTP) — never the
    organizer's connected Google/Zoom/Teams account. Builds a branded email with
    an attached RFC-5545 calendar invite. Returns a summary ``{sent, error}`` —
    never raises (callers decide how to react)."""
    emails = _clean_emails(emails)
    if not emails:
        return {"sent": 0, "error": None}
    # Prefer the identity of the account connected to THIS meeting's provider
    # (e.g. the connected Zoom account's email) so the invitation is attributed
    # to that account rather than the app user's profile. The physical SMTP
    # sending address can't be changed (mail servers reject a From that isn't the
    # authenticated account), but we CAN attribute the invite to the connected
    # account via the display name, Reply-To, and the .ics ORGANIZER.
    connected_email = oauth.status(org, row.provider).get("account_label") if org else None
    organizer = connected_email or _organizer_name(db, row)
    organizer_email = connected_email or _organizer_email(db, row)
    when = _aware(row.start_at)
    join_url = row.join_url or row.html_link
    platform = _PLATFORM_LABELS.get(row.provider, (row.provider or "").replace("_", " ").title() or None)

    subject, html, text = email_sender.build_invitation_email(
        title=row.title,
        when=when,
        duration_minutes=row.duration_minutes,
        join_url=join_url,
        meeting_id=row.external_id,
        passcode=row.passcode,
        organizer=organizer,
        kind=kind,
        platform=platform,
        company_name=(org.brand_company_name if org else None),
        primary_color=(org.brand_primary_color if org else None),
        logo_url=(org.brand_logo_data_url if org else None),
    )

    # A calendar invite only makes sense with a concrete start time.
    ics_text = None
    if when is not None:
        descr = f"{platform} meeting" if platform else None
        if row.passcode:
            descr = (descr + f" · Passcode: {row.passcode}") if descr else f"Passcode: {row.passcode}"
        ics_text = email_sender.build_ics(
            uid=f"concap-created-{row.id}@concap.ai",
            title=row.title,
            start=when,
            duration_minutes=row.duration_minutes,
            join_url=join_url,
            description=descr,
            organizer_email=organizer_email,
            organizer_name=organizer,
            attendees=emails,
            # SEQUENCE must strictly increase per RFC 5545 so calendar clients
            # honor repeated schedule changes. New invites start at 0; each
            # update uses a monotonic, time-derived revision.
            sequence=int(datetime.now(timezone.utc).timestamp()) if kind == "update" else 0,
        )

    try:
        result = email_sender.send_invitation(
            to=emails,
            subject=subject,
            html=html,
            text=text,
            ics_text=ics_text,
            # Show the organizer (the person who scheduled it) as the sender —
            # this mirrors Google Meet / Teams, where the invite appears to come
            # from the connected account, not the app/company. Fall back to the
            # org brand name, then the SMTP default, only when no organizer.
            sender_name=organizer or (org.brand_company_name if org else None),
            reply_to=organizer_email,
        )
        logger.info(
            "Invitation %s sent for created_meeting #%s (provider=%s) from %s to %d recipient(s): %s",
            kind, row.id, row.provider,
            result.get("from", "?"),
            result.get("sent", len(emails)),
            ", ".join(result.get("recipients", emails)),
        )
        return {"sent": result.get("sent", len(emails)), "error": None}
    except email_sender.EmailError as exc:
        logger.warning(
            "Invitation %s FAILED for created_meeting #%s (provider=%s) to %d recipient(s) [%s]: %s",
            kind, row.id, row.provider, len(emails), ", ".join(emails), exc,
        )
        return {"sent": 0, "error": str(exc)}


def _apply_invitations(row: CreatedMeeting, emails: list[str], *, mark_sent: bool) -> None:
    """Merge ``emails`` into row.invitations (dedup by address), stamping
    invited_at on first add and last_sent_at when an email actually went out.
    Reassigns the list so SQLAlchemy persists the JSON change."""
    now = _now_iso()
    existing = {(i.get("email") or "").lower(): dict(i) for i in (row.invitations or [])}
    for e in emails:
        key = e.lower()
        rec = existing.get(key) or {"email": e, "status": "invited", "invited_at": now, "last_sent_at": None}
        if mark_sent:
            rec["last_sent_at"] = now
        existing[key] = rec
    row.invitations = list(existing.values())
    row.attendees = [i["email"] for i in row.invitations]


@router.post("/providers/google_meet/create-meeting")
def create_google_meeting(
    payload: CreateMeetingIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    org = _require_google_meet(db, user)
    try:
        result = meeting_providers.create_google_meet(
            db, org,
            title=payload.title,
            start=payload.start,
            duration_minutes=payload.duration_minutes,
            attendees=payload.attendees,
            description=payload.description,
        )
    except oauth.MeetingOAuthError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    row = _store_created_meeting(db, org, user, "google_meet", result, payload.attendees)
    invite = _auto_invite_on_create(db, org, row, payload.attendees)
    return {**_serialize_created_meeting(row, db), "invite": invite}


@router.post("/providers/zoom/create-meeting")
def create_zoom_meeting(
    payload: CreateMeetingIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    org = _org_or_none(db, user)
    if org is None or not oauth.org_connected(org, "zoom"):
        raise HTTPException(status_code=400, detail="Zoom is not connected.")
    try:
        result = meeting_providers.create_zoom_meeting(
            db, org,
            title=payload.title,
            start=payload.start,
            duration_minutes=payload.duration_minutes,
            agenda=payload.description,
        )
    except oauth.MeetingOAuthError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    row = _store_created_meeting(db, org, user, "zoom", result, payload.attendees)
    invite = _auto_invite_on_create(db, org, row, payload.attendees)
    return {**_serialize_created_meeting(row, db), "invite": invite}


@router.post("/providers/ms_teams/create-meeting")
def create_teams_meeting(
    payload: CreateMeetingIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """Create a Microsoft Teams meeting as a Graph calendar event. Outlook emails
    the invitations to attendees automatically — the backend sends no email."""
    org = _require_provider(db, user, "ms_teams")
    try:
        result = meeting_providers.create_ms_teams(
            db, org,
            title=payload.title,
            start=payload.start,
            duration_minutes=payload.duration_minutes,
            attendees=payload.attendees,
            description=payload.description,
        )
    except oauth.MeetingOAuthError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    row = _store_created_meeting(db, org, user, "ms_teams", result, payload.attendees)
    invite = _auto_invite_on_create(db, org, row, payload.attendees)
    return {**_serialize_created_meeting(row, db), "invite": invite}


def _push_provider_update(
    db: Session, org: Organization, row: CreatedMeeting, *, attendees: list[str] | None = None
) -> None:
    """Propagate the row's current title/start/duration to the upstream provider
    so the provider's own calendar reflects the change. For Google Meet / Teams
    this ALSO triggers native attendee notifications (Calendar sendUpdates=all /
    Outlook auto-send) — pass ``attendees`` to (re)set the invitee list. Zoom's
    API can't notify attendees, so only the schedule is pushed there.
    Raises ``oauth.MeetingOAuthError`` on provider failure."""
    if not row.external_id:
        return
    start = _aware(row.start_at)
    if row.provider == "google_meet":
        meeting_providers.update_google_meet(
            db, org, row.external_id, title=row.title, start=start,
            duration_minutes=row.duration_minutes, attendees=attendees,
        )
    elif row.provider == "ms_teams":
        meeting_providers.update_ms_teams(
            db, org, row.external_id, title=row.title, start=start,
            duration_minutes=row.duration_minutes, attendees=attendees,
        )
    elif row.provider == "zoom":
        meeting_providers.update_zoom_meeting(
            db, org, row.external_id, title=row.title, start=start,
            duration_minutes=row.duration_minutes,
        )


def _auto_invite_on_create(
    db: Session, org: Organization, row: CreatedMeeting, attendees: list[str] | None
) -> dict:
    """Record (and, for Zoom, email) invitations for attendees supplied at create
    time. For Google Meet / Teams the provider's calendar already emailed these
    attendees when the event was created (they were on the create call), so the
    backend only records them. For Zoom the backend sends a branded email + ICS;
    a send failure never fails meeting creation — it is reported back so the UI
    can surface it and offer a retry."""
    emails = _clean_emails(attendees)
    if not emails:
        return {"sent": 0, "error": None}
    if row.provider in _PROVIDER_NATIVE_INVITES:
        _apply_invitations(row, emails, mark_sent=True)
        db.commit()
        db.refresh(row)
        return {"sent": len(emails), "error": None}
    summary = _send_invites(db, org, row, emails, kind="invite")
    if not summary["error"]:
        _apply_invitations(row, emails, mark_sent=True)
        db.commit()
        db.refresh(row)
    return summary


@router.get("/providers/created-meetings")
def list_created_meetings(
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """Meetings scheduled from this app, newest first — limited to providers the
    workspace currently has connected (disconnecting a provider hides them)."""
    org = _org_or_none(db, user)
    if org is None:
        return {"meetings": []}
    connected = [p for p in ("google_meet", "zoom", "ms_teams") if oauth.org_connected(org, p)]
    if not connected:
        return {"meetings": []}
    rows = db.scalars(
        select(CreatedMeeting)
        .where(CreatedMeeting.org_id == org.id, CreatedMeeting.provider.in_(connected))
        .order_by(CreatedMeeting.created_at.desc())
    ).all()
    return {"meetings": [_serialize_created_meeting(r, db) for r in rows]}


def _get_created_or_404(db: Session, user: User, created_id: int) -> tuple[Organization, CreatedMeeting]:
    org = _org_or_none(db, user)
    row = db.get(CreatedMeeting, created_id) if org else None
    if row is None or org is None or row.org_id != org.id:
        raise HTTPException(status_code=404, detail="Meeting not found.")
    return org, row


@router.patch("/providers/created-meetings/{created_id}")
def update_created_meeting(
    created_id: int,
    payload: UpdateCreatedMeetingIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """Edit the app's record of a scheduled meeting (title, time, duration,
    invitees). Only the supplied fields change. The edit is propagated to the
    upstream provider; for Google Meet / Teams the provider's own calendar emails
    attendees the update/invite (backend sends nothing), while for Zoom the
    backend sends the 'updated' / invitation emails itself."""
    org, row = _get_created_or_404(db, user, created_id)
    native = row.provider in _PROVIDER_NATIVE_INVITES
    schedule_changed = False
    if payload.title is not None:
        title = payload.title.strip()
        if title and title != row.title:
            row.title = title[:400]
            schedule_changed = True
    if payload.start is not None and payload.start != row.start_at:
        row.start_at = payload.start
        schedule_changed = True
    if payload.duration_minutes is not None:
        new_dur = max(1, min(int(payload.duration_minutes), 1440))
        if new_dur != row.duration_minutes:
            row.duration_minutes = new_dur
            schedule_changed = True

    # Replace-semantics on attendees: the edit form carries the FULL invitee
    # list. Removed addresses are dropped (no cancellation), kept ones retain
    # their original timestamps, new ones are added.
    new_emails: list[str] | None = None
    attendees_changed = False
    added: list[str] = []
    if payload.attendees is not None:
        new_emails = _clean_emails(payload.attendees)
        existing_by = {(i.get("email") or "").lower(): dict(i) for i in (row.invitations or [])}
        added = [e for e in new_emails if e.lower() not in existing_by]
        attendees_changed = {e.lower() for e in new_emails} != set(existing_by.keys())

    # 1) Propagate to the provider. For native providers we also (re)set the
    #    attendee list so the calendar re-notifies; Zoom only carries the schedule.
    push_attendees = new_emails if (native and attendees_changed) else None
    if schedule_changed or attendees_changed:
        try:
            _push_provider_update(db, org, row, attendees=push_attendees)
        except oauth.MeetingOAuthError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    # 2) Zoom only: email newly-added invitees BEFORE persisting them, so a send
    #    failure never records a phantom (un-emailed) participant. Native
    #    providers were already notified by the PATCH above.
    if not native and added:
        invite = _send_invites(db, org, row, added, kind="invite")
        if invite["error"]:
            raise HTTPException(status_code=502, detail=invite["error"])

    # 3) Rebuild local invitation records to match the new attendee list. New
    #    records are marked sent: native providers just notified them, and for
    #    Zoom we only reach here once their invitation email actually sent.
    if new_emails is not None:
        existing_by = {(i.get("email") or "").lower(): dict(i) for i in (row.invitations or [])}
        now = _now_iso()
        rebuilt = []
        for e in new_emails:
            rec = existing_by.get(e.lower())
            if rec is None:
                rec = {"email": e, "status": "invited", "invited_at": now, "last_sent_at": now}
            rebuilt.append(rec)
        row.invitations = rebuilt
        row.attendees = [r["email"] for r in rebuilt]
    db.commit()
    db.refresh(row)

    # 4) Schedule-change notifications to everyone already invited.
    notify = {"sent": 0, "error": None}
    if native:
        # Google Calendar / Outlook already emailed attendees via the PATCH above.
        if (schedule_changed or attendees_changed) and row.invitations:
            _apply_invitations(row, [i["email"] for i in row.invitations], mark_sent=True)
            db.commit()
            db.refresh(row)
            notify = {"sent": len(row.invitations), "error": None}
    elif schedule_changed and row.invitations:
        notify = _send_invites(
            db, org, row, [i["email"] for i in row.invitations], kind="update"
        )
        if not notify["error"]:
            _apply_invitations(row, [i["email"] for i in row.invitations], mark_sent=True)
            db.commit()
            db.refresh(row)
    return {**_serialize_created_meeting(row, db), "notify": notify}


class InviteIn(BaseModel):
    emails: list[str] = []


class ResendIn(BaseModel):
    emails: list[str] | None = None


@router.post("/providers/created-meetings/{created_id}/invite")
def invite_participants(
    created_id: int,
    payload: InviteIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """Add participants to a meeting and invite them. For Google Meet / Teams the
    attendees are added to the provider's calendar event, which emails them
    natively (backend sends nothing). For Zoom the backend emails the invitation
    itself; a Zoom participant is only recorded as 'invited' once that email is
    actually sent."""
    org, row = _get_created_or_404(db, user, created_id)
    emails = _clean_emails(payload.emails)
    if not emails:
        raise HTTPException(status_code=400, detail="Add at least one valid email address.")
    if row.provider in _PROVIDER_NATIVE_INVITES:
        # Build the FULL attendee list (existing + new), de-duplicated, and push
        # it so the provider's calendar invites the new additions natively.
        merged = {(i.get("email") or "").lower(): i.get("email") for i in (row.invitations or [])}
        for e in emails:
            merged.setdefault(e.lower(), e)
        try:
            _push_provider_update(db, org, row, attendees=list(merged.values()))
        except oauth.MeetingOAuthError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        _apply_invitations(row, emails, mark_sent=True)
        db.commit()
        db.refresh(row)
        return {**_serialize_created_meeting(row, db), "invite": {"sent": len(emails), "error": None}}
    summary = _send_invites(db, org, row, emails, kind="invite")
    if summary["error"]:
        raise HTTPException(status_code=502, detail=summary["error"])
    _apply_invitations(row, emails, mark_sent=True)
    db.commit()
    db.refresh(row)
    return {**_serialize_created_meeting(row, db), "invite": summary}


@router.post("/providers/created-meetings/{created_id}/resend")
def resend_invitations(
    created_id: int,
    payload: ResendIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """Re-send invitations to all (or a subset of) already-invited participants,
    refreshing their last_sent_at timestamp. For Google Meet / Teams this re-pushes
    the calendar event so the provider re-notifies; for Zoom the backend re-emails
    the invitation."""
    org, row = _get_created_or_404(db, user, created_id)
    invited = {(i.get("email") or "").lower(): i.get("email") for i in (row.invitations or [])}
    if not invited:
        raise HTTPException(status_code=400, detail="No participants have been invited yet.")
    if payload.emails:
        targets = [invited[e.lower()] for e in payload.emails if e.lower() in invited]
        if not targets:
            raise HTTPException(status_code=400, detail="None of those participants are invited.")
    else:
        targets = list(invited.values())
    if row.provider in _PROVIDER_NATIVE_INVITES:
        # Calendar re-notification is all-or-nothing (PATCH with sendUpdates=all
        # / Outlook auto-send re-notifies EVERY attendee), so a subset resend
        # can't be honored natively — everyone invited is re-notified and the
        # count reflects that.
        all_emails = list(invited.values())
        try:
            _push_provider_update(db, org, row, attendees=all_emails)
        except oauth.MeetingOAuthError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        _apply_invitations(row, all_emails, mark_sent=True)
        db.commit()
        db.refresh(row)
        return {**_serialize_created_meeting(row, db), "resend": {"sent": len(all_emails), "error": None}}
    summary = _send_invites(db, org, row, targets, kind="invite")
    if summary["error"]:
        raise HTTPException(status_code=502, detail=summary["error"])
    _apply_invitations(row, targets, mark_sent=True)
    db.commit()
    db.refresh(row)
    return {**_serialize_created_meeting(row, db), "resend": summary}


@router.delete("/providers/created-meetings/{created_id}")
def delete_created_meeting(
    created_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    org = _org_or_none(db, user)
    row = db.get(CreatedMeeting, created_id) if org else None
    if row is None or row.org_id != org.id:
        raise HTTPException(status_code=404, detail="Meeting not found.")
    db.delete(row)
    db.commit()
    return {"deleted": True}


@router.get("/providers/google_meet/calendar")
def google_meet_calendar(
    past_days: int = Query(default=30, ge=0, le=90),
    upcoming_days: int = Query(default=21, ge=1, le=90),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    org = _require_google_meet(db, user)
    try:
        events = meeting_providers.list_google_calendar_events(
            db, org, past_days=past_days, upcoming_days=upcoming_days
        )
    except oauth.MeetingOAuthError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"events": [
        {
            "event_id": e.get("event_id"),
            "title": e.get("title"),
            "start": e["start"].isoformat() if e.get("start") else None,
            "join_url": e.get("join_url"),
            "html_link": e.get("html_link"),
            "attendees": e.get("attendees") or [],
            "is_past": e.get("is_past", False),
        }
        for e in events
    ]}


# --------------------------------------------------------------------------- #
# Per-meeting detail / speaker assignment / delete
# --------------------------------------------------------------------------- #


@router.get("/{meeting_id}")
def get_meeting(meeting_id: int, db: Session = Depends(get_db), user: User = Depends(require_user)) -> dict:
    m = db.get(ImportedMeeting, meeting_id)
    if m is None or m.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return _detail(m)


class AssignSpeakerIn(BaseModel):
    speaker: str          # the anonymous label in this meeting (e.g. "Speaker 1")
    canonical_name: str   # the real person to register / match it to
    email: str | None = None


@router.post("/{meeting_id}/assign-speaker")
def assign_speaker(
    meeting_id: int,
    payload: AssignSpeakerIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """Confirm a speaker label as a named person: builds/merges that person's
    voiceprint from their dialog in this meeting and tags the meeting."""
    m = db.get(ImportedMeeting, meeting_id)
    if m is None or m.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Meeting not found")
    name = (payload.canonical_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="A name is required.")

    text = " ".join(
        u.get("text") or "" for u in (m.utterances or []) if u.get("speaker") == payload.speaker
    ).strip()
    if not text:
        raise HTTPException(status_code=400, detail="That speaker has no dialog to fingerprint.")
    embedding = voiceprints.extract_text_embedding(text)

    vp = db.scalars(
        select(SpeakerVoiceprint).where(
            SpeakerVoiceprint.org_id == user.org_id, SpeakerVoiceprint.canonical_name == name
        )
    ).first()
    if vp is None:
        vp = SpeakerVoiceprint(
            org_id=user.org_id, canonical_name=name, email=payload.email,
            embedding=embedding, sample_count=1,
        )
        db.add(vp)
    else:
        vp.embedding = voiceprints.merge_embeddings(vp.embedding or [], vp.sample_count or 0, embedding)
        vp.sample_count = (vp.sample_count or 0) + 1
        if payload.email:
            vp.email = payload.email
        vp.updated_at = utcnow()
    db.commit()
    db.refresh(vp)

    # Tag this meeting's speaker entry as matched (recompute keeps it in sync).
    m.speakers = _build_speakers(db, user.org_id, m.utterances or [])
    for entry in m.speakers:
        if entry["speaker"] == payload.speaker and not entry["matched"]:
            entry["name"] = name
            entry["matched"] = True
            entry["confidence"] = 1.0
            entry["voiceprint_id"] = vp.id
    db.add(m)
    db.commit()
    return {"voiceprint_id": vp.id, "canonical_name": vp.canonical_name, "speakers": m.speakers}


@router.delete("/{meeting_id}")
def delete_meeting(meeting_id: int, db: Session = Depends(get_db), user: User = Depends(require_user)) -> dict:
    m = db.get(ImportedMeeting, meeting_id)
    if m is None or m.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Meeting not found")
    db.delete(m)
    db.commit()
    return {"deleted": True}


# --------------------------------------------------------------------------- #
# OAuth callback (public — authenticated by signed state)
# --------------------------------------------------------------------------- #


def _redirect_page(*, connected: bool = False, error: str | None = None) -> RedirectResponse:
    """Send the browser back to the Imported Meetings tab with a status query
    param so the page can show a toast (see frontend handleCallbackParams)."""
    params = []
    if connected:
        params.append("meeting=connected")
    if error:
        params.append(f"meeting_error={quote(error)}")
    suffix = ("?" + "&".join(params)) if params else ""
    return RedirectResponse(url=f"/imported-meetings{suffix}", status_code=302)


@public_router.get("/providers/{provider}/oauth/callback")
def provider_oauth_callback(
    provider: str,
    db: Session = Depends(get_db),
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    error_description: str | None = Query(default=None),
) -> RedirectResponse:
    if provider not in oauth.PROVIDERS:
        return _redirect_page(error="Unknown provider")
    if error:
        return _redirect_page(error=error_description or error)
    if not code or not state:
        return _redirect_page(error="Missing authorization code")
    try:
        payload = oauth.verify_state(state)
    except oauth.MeetingOAuthError as exc:
        return _redirect_page(error=str(exc))
    if payload.get("p") != provider:
        return _redirect_page(error="OAuth state/provider mismatch")

    org = db.get(Organization, int(payload.get("org", 0)))
    if org is None:
        return _redirect_page(error="Unknown organization")
    try:
        oauth.consume_state(db, org, provider, payload)
        oauth.complete_connection(db, org, provider, code)
    except oauth.MeetingOAuthError as exc:
        logger.warning("%s connect failed for org #%s: %s", provider, org.id, exc)
        return _redirect_page(error=str(exc))
    logger.info("%s connected for org #%s", provider, org.id)
    return _redirect_page(connected=True)
