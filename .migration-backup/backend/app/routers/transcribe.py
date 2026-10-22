"""Quick transcription: upload any audio, get a transcript, save a record.

This is the simple counterpart to the long-capture auto-detect pipeline.
No diarization-driven session splitting, no visitor/company extraction —
just transcribe the file and store it as one org-scoped Conversation so
it shows up on the dashboard. Use this for ad-hoc clips, voice notes,
single recordings that aren't a multi-visitor booth day.

GPT lead analysis still runs (best-effort) so the dashboard detail view
is populated; it won't block or fail the transcription if it errors.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import Conversation, EventDay, User, Visitor
from ..services.analysis import analyze_transcript
from ..services.transcription import render_diarized_transcript, transcribe_audio
from ..services.voice_identity import identify_speakers_for_user
from .auth import require_user

router = APIRouter(prefix="/api/transcribe", tags=["transcribe"])

ALLOWED_AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".mp4", ".webm", ".ogg", ".flac"}
MAX_MB = 2048  # 2 GB cap for Quick transcribe — Deepgram handles large files.


class SpeakerStat(BaseModel):
    speaker: str
    seconds: float
    percent: float
    utterance_count: int


class TranscribeOut(BaseModel):
    transcript: str
    conversation_id: int
    visitor_id: int
    title: str
    lead_score: int | None = None
    lead_temperature: str | None = None
    diarized: bool = False
    speaker_count: int = 0
    speaker_stats: list[SpeakerStat] = []
    duration_seconds: float | None = None
    created_at: str | None = None
    event_name: str | None = None
    event_day_label: str | None = None
    # Auto-detected mapping like {"Speaker 0": "Ahmed", "Speaker 1": "Sarah"}
    # — only includes speakers whose names GPT was able to infer from the
    # transcript itself (self-introductions or being addressed by name).
    speaker_names: dict[str, str] = {}


def _compute_speaker_stats(speakers: list[dict]) -> list[dict]:
    """Per-speaker talk-time + share-of-conversation, sorted by talk time.

    Output mirrors the screenshot's chip row: "Speaker A 47%, Speaker B 32%, ...".
    """
    if not speakers:
        return []
    totals: dict[str, dict] = {}
    for u in speakers:
        spk = str(u.get("speaker") or "").strip()
        if not spk:
            continue
        dur = max(0.0, float(u.get("end") or 0.0) - float(u.get("start") or 0.0))
        slot = totals.setdefault(
            spk, {"speaker": spk, "seconds": 0.0, "utterance_count": 0}
        )
        slot["seconds"] += dur
        slot["utterance_count"] += 1

    total = sum(s["seconds"] for s in totals.values()) or 1.0
    rows = []
    for s in totals.values():
        rows.append(
            {
                "speaker": s["speaker"],
                "seconds": round(s["seconds"], 2),
                "percent": round((s["seconds"] / total) * 100.0, 1),
                "utterance_count": s["utterance_count"],
            }
        )
    rows.sort(key=lambda r: r["seconds"], reverse=True)
    return rows


@router.post("", response_model=TranscribeOut)
async def transcribe(
    audio: UploadFile = File(...),
    title: str | None = Form(default=None),
    event_day_id: int | None = Form(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> TranscribeOut:
    settings = get_settings()

    # Resolve the optional event-day pick so we can stamp event/day labels
    # onto the conversation and surface them on the dashboard/result card.
    event_day: EventDay | None = None
    if event_day_id is not None:
        event_day = db.get(EventDay, event_day_id)
        if event_day is None or event_day.event is None or event_day.event.org_id != user.org_id:
            raise HTTPException(status_code=404, detail="Event day not found")

    suffix = Path(audio.filename or "").suffix.lower() or ".wav"
    if suffix not in ALLOWED_AUDIO_EXTS:
        raise HTTPException(status_code=415, detail=f"Unsupported audio type: {suffix}")

    target_dir = settings.audio_path / "transcribe"
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"tx_{uuid.uuid4().hex}{suffix}"

    max_bytes = MAX_MB * 1024 * 1024
    written = 0
    async with aiofiles.open(target_path, "wb") as out:
        while chunk := await audio.read(4 * 1024 * 1024):
            written += len(chunk)
            if written > max_bytes:
                await out.close()
                target_path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=413, detail=f"Audio exceeds {MAX_MB} MB limit"
                )
            await out.write(chunk)
    if written == 0:
        target_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Empty audio upload")

    # Transcribe with whatever provider is configured (Whisper or Deepgram).
    try:
        stt = transcribe_audio(target_path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Transcription failed: {exc}")

    plain = (stt.get("text") or "").strip()
    name_map = (
        identify_speakers_for_user(db, user, stt["speakers"])
        if stt.get("diarized") and stt.get("speakers")
        else {}
    )
    diarized = (
        render_diarized_transcript(stt["speakers"], name_map)
        if stt.get("diarized") and stt.get("speakers")
        else ""
    )
    transcript = diarized or plain
    if not transcript:
        raise HTTPException(
            status_code=422,
            detail="No speech detected in the audio (the file may be silent, music, or noise only).",
        )

    display_title = (
        title or Path(audio.filename or "audio").stem or "Transcription"
    ).strip()

    # Each quick transcription becomes its own Visitor row so it's
    # identifiable on the dashboard (mirrors the reference project, where
    # the filename is the record title).
    visitor = Visitor(
        org_id=user.org_id,
        name=f"Transcription: {display_title}",
        source="transcription",
    )
    db.add(visitor)
    db.flush()

    # Best-effort lead analysis — never blocks the transcript.
    analysis = None
    try:
        analysis = analyze_transcript(
            transcript,
            visitor_context={
                "diarized": bool(stt.get("diarized")),
                "stt_provider": stt.get("provider"),
            },
        )
    except Exception:  # noqa: BLE001
        analysis = None

    # Prefer the picked event's name over the global default so the row is
    # filed under the user's selected category.
    event_name = event_day.event.name if event_day else settings.event_name
    day_label = (event_day.label or f"Day {event_day.day_number}") if event_day else None

    conv = Conversation(
        org_id=user.org_id,
        visitor_id=visitor.id,
        staff_name=user.name or user.email,
        event_name=event_name,
        booth_name=settings.booth_name,
        event_day_id=event_day.id if event_day else None,
        audio_filename=str(target_path),
        audio_mime=audio.content_type,
        transcript=transcript,
        transcript_language=stt.get("language"),
        duration_seconds=stt.get("duration"),
        analysis=analysis,
        lead_score=(analysis or {}).get("lead_score"),
        lead_temperature=(analysis or {}).get("lead_temperature"),
        status="analyzed",
    )
    db.add(conv)
    db.commit()
    db.refresh(conv)

    speaker_stats = _compute_speaker_stats(stt.get("speakers") or [])

    return TranscribeOut(
        transcript=transcript,
        conversation_id=conv.id,
        visitor_id=visitor.id,
        title=display_title,
        lead_score=conv.lead_score,
        lead_temperature=conv.lead_temperature,
        diarized=bool(stt.get("diarized")),
        speaker_count=int(stt.get("speaker_count") or 0),
        speaker_stats=[SpeakerStat(**s) for s in speaker_stats],
        duration_seconds=stt.get("duration"),
        created_at=(conv.created_at.isoformat() + "Z") if conv.created_at else None,
        event_name=event_name,
        event_day_label=day_label,
        # Merge the primary-user / registry relabels (name_map) on top of the
        # LLM auto-detected names so the speaker chips + legend show the user's
        # real name, matching the relabeled transcript text (not "Speaker A").
        speaker_names={
            **((analysis or {}).get("speaker_names") or {}),
            **name_map,
        },
    )
