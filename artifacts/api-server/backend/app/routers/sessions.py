"""Long-capture session management.

Workflow:
  1. POST /api/sessions                              create a session
  2. POST /api/sessions/{id}/audio                   upload the long recording
  3. POST /api/sessions/{id}/markers                 add visitor_start / visitor_end markers
  4. POST /api/sessions/{id}/process                 slice + transcribe + analyze each visitor window
  5. GET  /api/sessions/{id}                         see derived conversations
"""
from __future__ import annotations

import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import aiofiles
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from ..config import get_settings
from ..database import SessionLocal, get_db
from ..models import Conversation, EventDay, Session, SessionMarker, User, Visitor
from ..services.analysis import analyze_transcript
from ..services.autodetect import (
    propose_sessions,
    render_segment_transcript,
    slice_utterances,
    transcribe_session,
)
from ..services.pipeline import _persist_action_items, _populate_embedding, process_conversation
from .auth import require_user
from ..services.segmentation import (
    FFmpegMissingError,
    derive_segments_from_markers,
    extract_segment,
    probe_duration_seconds,
)

router = APIRouter(prefix="/api/sessions", tags=["sessions"])

ALLOWED_AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".mp4", ".webm", ".ogg", ".flac"}
MAX_LONG_AUDIO_MB = 800  # long-day recordings can be hundreds of MB


# -- Schemas (kept inline; this router has a different shape than the rest) -

class SessionCreate(BaseModel):
    name: str
    staff_name: str | None = None
    recording_started_at: datetime | None = None
    event_day_id: int | None = None


class MarkerIn(BaseModel):
    marker_type: str  # visitor_start | visitor_end | note
    timestamp_seconds: float
    label: str | None = None
    visitor_data: dict[str, Any] | None = None


class MarkerOut(BaseModel):
    id: int
    marker_type: str
    timestamp_seconds: float
    label: str | None
    visitor_data: dict[str, Any] | None
    created_at: datetime

    class Config:
        from_attributes = True


class SessionOut(BaseModel):
    id: int
    name: str
    event_name: str | None
    booth_name: str | None
    staff_name: str | None
    event_day_id: int | None
    event_day_label: str | None
    audio_filename: str | None
    audio_mime: str | None
    duration_seconds: float | None
    status: str
    error_message: str | None
    recording_started_at: datetime | None
    created_at: datetime
    updated_at: datetime
    markers: list[MarkerOut]
    derived_conversation_ids: list[int]
    ai_proposal: dict | None = None

    class Config:
        from_attributes = True


def _to_session_out(s: Session) -> SessionOut:
    day = s.event_day if s.event_day_id else None
    day_label = (
        (day.label or f"Day {day.day_number}") if day is not None else None
    )
    return SessionOut(
        id=s.id,
        name=s.name,
        event_name=s.event_name,
        booth_name=s.booth_name,
        staff_name=s.staff_name,
        event_day_id=s.event_day_id,
        event_day_label=day_label,
        audio_filename=s.audio_filename,
        audio_mime=s.audio_mime,
        duration_seconds=s.duration_seconds,
        status=s.status,
        error_message=s.error_message,
        recording_started_at=s.recording_started_at,
        created_at=s.created_at,
        updated_at=s.updated_at,
        markers=[MarkerOut.model_validate(m) for m in s.markers],
        derived_conversation_ids=[c.id for c in s.conversations],
        ai_proposal=s.ai_proposal,
    )


# -- Endpoints --------------------------------------------------------------

@router.post("", response_model=SessionOut, status_code=status.HTTP_201_CREATED)
def create_session(
    payload: SessionCreate,
    db: DBSession = Depends(get_db),
    user: User = Depends(require_user),
) -> SessionOut:
    settings = get_settings()

    # Resolve the optional event-day pick (mirrors /api/transcribe) so derived
    # conversations inherit it and the session is filed under the chosen event.
    event_day: EventDay | None = None
    if payload.event_day_id is not None:
        event_day = db.get(EventDay, payload.event_day_id)
        if event_day is None or event_day.event is None or event_day.event.org_id != user.org_id:
            raise HTTPException(status_code=404, detail="Event day not found")

    s = Session(
        org_id=user.org_id,
        name=payload.name,
        staff_name=payload.staff_name or user.name or user.email,
        event_name=event_day.event.name if event_day else settings.event_name,
        booth_name=settings.booth_name,
        event_day_id=event_day.id if event_day else None,
        recording_started_at=payload.recording_started_at,
        status="created",
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return _to_session_out(s)


@router.get("", response_model=list[SessionOut])
def list_sessions(
    db: DBSession = Depends(get_db),
    user: User = Depends(require_user),
) -> list[SessionOut]:
    rows = list(
        db.scalars(
            select(Session)
            .where(Session.org_id == user.org_id)
            .order_by(Session.created_at.desc())
        )
    )
    return [_to_session_out(s) for s in rows]


def _get_owned_session(session_id: int, user: User, db: DBSession) -> Session:
    s = db.get(Session, session_id)
    if s is None or s.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Session not found")
    return s


@router.get("/{session_id}", response_model=SessionOut)
def get_session(
    session_id: int,
    db: DBSession = Depends(get_db),
    user: User = Depends(require_user),
) -> SessionOut:
    return _to_session_out(_get_owned_session(session_id, user, db))


@router.post("/{session_id}/audio", response_model=SessionOut)
async def upload_session_audio(
    session_id: int,
    file: UploadFile = File(...),
    client_duration_seconds: float | None = Form(default=None),
    db: DBSession = Depends(get_db),
    user: User = Depends(require_user),
) -> SessionOut:
    settings = get_settings()
    s = _get_owned_session(session_id, user, db)

    suffix = Path(file.filename or "").suffix.lower() or ".wav"
    if suffix not in ALLOWED_AUDIO_EXTS:
        raise HTTPException(status_code=415, detail=f"Unsupported audio type: {suffix}")

    target_dir = settings.audio_path / "sessions"
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"session_{session_id}_{uuid.uuid4().hex}{suffix}"

    max_bytes = MAX_LONG_AUDIO_MB * 1024 * 1024
    written = 0
    async with aiofiles.open(target_path, "wb") as out:
        while chunk := await file.read(4 * 1024 * 1024):
            written += len(chunk)
            if written > max_bytes:
                await out.close()
                target_path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=413,
                    detail=f"Audio exceeds {MAX_LONG_AUDIO_MB} MB limit for long-capture sessions",
                )
            await out.write(chunk)

    if written == 0:
        target_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Empty audio upload")

    s.audio_filename = str(target_path)
    s.audio_mime = file.content_type
    # Prefer ffprobe; fall back to the browser-detected duration the client
    # sent (so segmentation still works when ffprobe isn't installed).
    probed = probe_duration_seconds(target_path)
    if probed is not None:
        s.duration_seconds = probed
    elif client_duration_seconds and client_duration_seconds > 0:
        s.duration_seconds = float(client_duration_seconds)
    else:
        s.duration_seconds = None
    s.status = "audio_uploaded"
    s.error_message = None
    db.commit()
    db.refresh(s)
    return _to_session_out(s)


@router.post("/{session_id}/markers", response_model=MarkerOut, status_code=status.HTTP_201_CREATED)
def add_marker(
    session_id: int,
    payload: MarkerIn,
    db: DBSession = Depends(get_db),
    user: User = Depends(require_user),
) -> MarkerOut:
    s = _get_owned_session(session_id, user, db)
    if payload.marker_type not in {"visitor_start", "visitor_end", "note"}:
        raise HTTPException(status_code=400, detail="marker_type must be visitor_start | visitor_end | note")
    if payload.timestamp_seconds < 0:
        raise HTTPException(status_code=400, detail="timestamp_seconds must be non-negative")

    m = SessionMarker(
        session_id=s.id,
        marker_type=payload.marker_type,
        timestamp_seconds=payload.timestamp_seconds,
        label=payload.label,
        visitor_data=payload.visitor_data,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return MarkerOut.model_validate(m)


@router.delete("/{session_id}/markers/{marker_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_marker(
    session_id: int,
    marker_id: int,
    db: DBSession = Depends(get_db),
    user: User = Depends(require_user),
) -> None:
    _get_owned_session(session_id, user, db)  # 404s if not the caller's org
    m = db.get(SessionMarker, marker_id)
    if m is None or m.session_id != session_id:
        raise HTTPException(status_code=404, detail="Marker not found")
    db.delete(m)
    db.commit()


# -- Processing -------------------------------------------------------------

def _process_session_blocking(session_id: int) -> None:
    """Slice audio by markers, create one Conversation per window, run pipeline."""
    db = SessionLocal()
    try:
        s = db.get(Session, session_id)
        if s is None or not s.audio_filename:
            return

        source = Path(s.audio_filename)
        if not source.exists():
            s.status = "error"
            s.error_message = f"Session audio missing: {source}"
            db.commit()
            return

        s.status = "processing"
        s.error_message = None
        db.commit()

        try:
            markers = [
                {
                    "marker_type": m.marker_type,
                    "timestamp_seconds": m.timestamp_seconds,
                    "label": m.label,
                    "visitor_data": m.visitor_data,
                }
                for m in s.markers
            ]

            settings = get_settings()
            seg_dir = settings.audio_path / "segments"
            seg_dir.mkdir(parents=True, exist_ok=True)

            segments = derive_segments_from_markers(
                markers=markers,
                total_duration=s.duration_seconds,
                output_dir=seg_dir,
                source_suffix=source.suffix or ".wav",
            )

            if not segments:
                s.status = "error"
                s.error_message = (
                    "No usable visitor windows found. Add at least one 'visitor_start' marker, "
                    "and either a matching 'visitor_end' or a session duration."
                )
                db.commit()
                return

            created_conv_ids: list[int] = []
            for seg in segments:
                try:
                    extract_segment(source, seg.start, seg.end, seg.output_path)
                except FFmpegMissingError as exc:
                    s.status = "error"
                    s.error_message = str(exc)
                    db.commit()
                    return

                # Find-or-create visitor from the marker's visitor_data.
                vdata = seg.visitor_data or {}
                vname = (vdata.get("name") or seg.label or "Unknown visitor").strip() or "Unknown visitor"
                email = (vdata.get("email") or "").strip() or None
                phone = (vdata.get("phone") or "").strip() or None

                visitor = None
                if email or phone:
                    q = select(Visitor).where(Visitor.org_id == s.org_id)
                    if email and phone:
                        q = q.where((Visitor.email == email) | (Visitor.phone == phone))
                    elif email:
                        q = q.where(Visitor.email == email)
                    else:
                        q = q.where(Visitor.phone == phone)
                    visitor = db.scalar(q)
                if visitor is None:
                    visitor = Visitor(
                        org_id=s.org_id,
                        name=vname,
                        company=(vdata.get("company") or None),
                        email=email,
                        phone=phone,
                        designation=(vdata.get("designation") or None),
                        industry=(vdata.get("industry") or None),
                        interest_category=(vdata.get("interest_category") or None),
                        source="session",
                    )
                    db.add(visitor)
                    db.flush()

                # Use the actual output path (extract_segment may have switched
                # to .wav if it had to re-encode).
                actual_path = seg.output_path if seg.output_path.exists() else seg.output_path.with_suffix(".wav")

                conv = Conversation(
                    org_id=s.org_id,
                    visitor_id=visitor.id,
                    staff_name=s.staff_name,
                    event_name=s.event_name,
                    booth_name=s.booth_name,
                    event_day_id=s.event_day_id,
                    audio_filename=str(actual_path),
                    audio_mime="audio/wav" if actual_path.suffix == ".wav" else s.audio_mime,
                    status="uploaded",
                    session_id=s.id,
                    session_start_seconds=seg.start,
                    session_end_seconds=seg.end,
                )
                db.add(conv)
                db.flush()
                created_conv_ids.append(conv.id)

            db.commit()

            # Run the existing per-conversation pipeline on each new row.
            for cid in created_conv_ids:
                # Use a fresh session per call so a single failure doesn't
                # poison the others.
                inner = SessionLocal()
                try:
                    process_conversation(inner, cid)
                finally:
                    inner.close()

            s = db.get(Session, session_id)  # re-fetch
            s.status = "processed"
            s.error_message = None
            db.commit()
        except Exception as exc:  # noqa: BLE001
            s = db.get(Session, session_id)
            if s is not None:
                s.status = "error"
                s.error_message = str(exc)[:1000]
                db.commit()
    finally:
        db.close()


@router.post("/{session_id}/process", response_model=SessionOut)
def process_session(
    session_id: int,
    background: BackgroundTasks,
    db: DBSession = Depends(get_db),
    user: User = Depends(require_user),
) -> SessionOut:
    s = _get_owned_session(session_id, user, db)
    if not s.audio_filename:
        raise HTTPException(status_code=400, detail="Upload the session audio first")

    # Pre-flight: ffmpeg is mandatory for slicing. Fail fast with an
    # actionable message instead of letting the background task die later.
    import shutil

    if shutil.which("ffmpeg") is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "ffmpeg is not installed on the server, so long-capture audio "
                "can't be split. Install it and restart the server — Windows: "
                "`winget install Gyan.FFmpeg` (then open a new terminal); "
                "macOS: `brew install ffmpeg`; Linux: `apt-get install ffmpeg`."
            ),
        )

    if not any(mk.marker_type == "visitor_start" for mk in s.markers):
        raise HTTPException(
            status_code=400,
            detail="Add at least one 'visitor_start' marker before processing.",
        )

    s.status = "queued"
    s.error_message = None
    db.commit()
    db.refresh(s)

    background.add_task(_process_session_blocking, s.id)
    return _to_session_out(s)


# -- AI auto-detection ------------------------------------------------------

def _auto_detect_blocking(session_id: int) -> None:
    """Deepgram diarize the whole recording, then GPT-propose the visitor
    breakdown. Stored on the session for the user to review."""
    db = SessionLocal()
    try:
        s = db.get(Session, session_id)
        if s is None or not s.audio_filename:
            return
        src = Path(s.audio_filename)
        if not src.exists():
            s.status = "error"
            s.error_message = f"Session audio missing: {src}"
            db.commit()
            return
        s.status = "detecting"
        s.error_message = None
        db.commit()
        try:
            stt = transcribe_session(src)
            utterances = stt.get("speakers") or []
            if not utterances:
                s.status = "error"
                s.error_message = (
                    "Deepgram returned no speaker segments — the audio may be "
                    "silent, too short, or in an unsupported format."
                )
                db.commit()
                return
            if stt.get("duration") and not s.duration_seconds:
                s.duration_seconds = stt["duration"]
            s.diarized_segments = utterances
            proposal = propose_sessions(utterances)
            s.ai_proposal = proposal
            s.status = "proposed"
            s.error_message = None
            db.commit()
        except Exception as exc:  # noqa: BLE001
            s = db.get(Session, session_id)
            if s is not None:
                s.status = "error"
                s.error_message = str(exc)[:1000]
                db.commit()
    finally:
        db.close()


@router.post("/{session_id}/auto-detect", response_model=SessionOut)
def auto_detect(
    session_id: int,
    background: BackgroundTasks,
    db: DBSession = Depends(get_db),
    user: User = Depends(require_user),
) -> SessionOut:
    s = _get_owned_session(session_id, user, db)
    if not s.audio_filename:
        raise HTTPException(status_code=400, detail="Upload the session audio first")

    settings = get_settings()
    if not settings.deepgram_api_key:
        raise HTTPException(
            status_code=400,
            detail=(
                "AI auto-detection needs speaker diarization. Set "
                "DEEPGRAM_API_KEY in backend/.env and restart the server "
                "(Whisper cannot diarize speakers)."
            ),
        )

    s.status = "queued"
    s.error_message = None
    db.commit()
    db.refresh(s)
    background.add_task(_auto_detect_blocking, s.id)
    return _to_session_out(s)


class ConfirmSessionItem(BaseModel):
    company: str | None = None
    visitor_name: str | None = None
    visitor_email: str | None = None
    visitor_phone: str | None = None
    start_seconds: float
    end_seconds: float


class ConfirmRequest(BaseModel):
    sessions: list[ConfirmSessionItem]


@router.post("/{session_id}/confirm", response_model=SessionOut)
def confirm_sessions(
    session_id: int,
    payload: ConfirmRequest,
    db: DBSession = Depends(get_db),
    user: User = Depends(require_user),
) -> SessionOut:
    """Turn the user-reviewed proposal into Conversation/CRM records.

    Reuses the already-obtained diarized transcript — no second STT pass,
    no ffmpeg — so confirming is fast and cheap.
    """
    s = _get_owned_session(session_id, user, db)
    if not s.diarized_segments:
        raise HTTPException(
            status_code=400,
            detail="Run AI auto-detect first (no diarized transcript on this session).",
        )
    if not payload.sessions:
        raise HTTPException(status_code=400, detail="No sessions selected to confirm.")

    rep_speakers = (s.ai_proposal or {}).get("rep_speakers") or []
    utterances = s.diarized_segments
    created: list[int] = []

    for item in payload.sessions:
        if item.end_seconds <= item.start_seconds:
            continue
        seg_utts = slice_utterances(utterances, item.start_seconds, item.end_seconds)
        if not seg_utts:
            continue
        transcript = render_segment_transcript(seg_utts, rep_speakers)

        email = (item.visitor_email or "").strip() or None
        phone = (item.visitor_phone or "").strip() or None
        vname = (item.visitor_name or "").strip() or (item.company or "Unknown visitor").strip()

        visitor = None
        if email or phone:
            q = select(Visitor).where(Visitor.org_id == s.org_id)
            if email and phone:
                q = q.where((Visitor.email == email) | (Visitor.phone == phone))
            elif email:
                q = q.where(Visitor.email == email)
            else:
                q = q.where(Visitor.phone == phone)
            visitor = db.scalar(q)
        if visitor is None:
            visitor = Visitor(
                org_id=s.org_id,
                name=vname,
                company=(item.company or None),
                email=email,
                phone=phone,
                source="auto_session",
            )
            db.add(visitor)
            db.flush()

        analysis = analyze_transcript(
            transcript,
            visitor_context={
                "name": visitor.name,
                "company": visitor.company,
                "diarized": True,
                "stt_provider": "deepgram",
            },
        )
        conv = Conversation(
            org_id=s.org_id,
            visitor_id=visitor.id,
            staff_name=s.staff_name,
            event_name=s.event_name,
            booth_name=s.booth_name,
            event_day_id=s.event_day_id,
            transcript=transcript,
            transcript_language="en",
            analysis=analysis,
            lead_score=analysis.get("lead_score"),
            lead_temperature=analysis.get("lead_temperature"),
            topic=(analysis.get("topic") or "").strip()[:200] or None,
            status="analyzed",
            session_id=s.id,
            session_start_seconds=item.start_seconds,
            session_end_seconds=item.end_seconds,
        )
        db.add(conv)
        db.flush()
        _persist_action_items(db, conv, analysis.get("action_items") or [])
        _populate_embedding(db, conv, analysis)
        created.append(conv.id)

    if not created:
        raise HTTPException(status_code=400, detail="No usable sessions to create from the selection.")

    s.status = "processed"
    s.error_message = None
    db.commit()
    db.refresh(s)
    return _to_session_out(s)


@router.post("/{session_id}/audio_form", response_model=SessionOut)
async def upload_session_audio_form(
    session_id: int,
    file: UploadFile = File(...),
    auto_process: bool = Form(default=False),
    background: BackgroundTasks = None,  # noqa: B008
    db: DBSession = Depends(get_db),
    user: User = Depends(require_user),
) -> SessionOut:
    """Alternate upload endpoint that also accepts `auto_process=true` to kick
    off processing immediately after upload. Useful for the long-capture page."""
    result = await upload_session_audio(session_id=session_id, file=file, db=db, user=user)
    if auto_process and background is not None:
        background.add_task(_process_session_blocking, session_id)
    return result
