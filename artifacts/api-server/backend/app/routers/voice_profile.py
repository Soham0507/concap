"""Primary User Voice Profile — Settings -> Profile -> Voice Profile.

Lets the signed-in account holder set their identity (display name, job title,
company, department) and enroll a voice sample (record or upload) so Concap AI
recognizes them in conversations and replaces generic "Speaker N" labels with
their real name across transcripts, summaries, action items, CRM notes and the
Quote agent.

The voice fingerprint is a lexical/style vector (see services.voiceprints) — no
audio biometrics — so we never persist the raw audio: the uploaded sample is
transcribed, turned into a fingerprint, then discarded. Identification improves
as the user is confirmed in real conversations.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import SpeakerVoiceprint, User, utcnow
from ..services import voice_identity
from ..services.transcription import transcribe_audio
from ..services.voiceprints import MIN_SAMPLE_CHARS
from .auth import require_user

router = APIRouter(prefix="/api/voice-profile", tags=["voice-profile"])

# Browser MediaRecorder emits webm/ogg; uploads per the spec are mp3/wav/m4a/aac.
ALLOWED_SAMPLE_EXTS = {".webm", ".ogg", ".mp3", ".wav", ".m4a", ".mp4", ".aac", ".flac"}
MAX_SAMPLE_MB = 25


# -- Schemas ----------------------------------------------------------------

class ProfileIn(BaseModel):
    display_name: str | None = Field(default=None, max_length=120)
    job_title: str | None = Field(default=None, max_length=160)
    company_name: str | None = Field(default=None, max_length=200)
    department: str | None = Field(default=None, max_length=160)
    consent: bool | None = None


def _clean(v: str | None) -> str | None:
    v = (v or "").strip()
    return v or None


def _profile_payload(db: Session, user: User) -> dict:
    vp = voice_identity.primary_for_user(db, user)
    return {
        "display_name": user.display_name,
        "job_title": user.job_title,
        "company_name": user.company_name,
        "department": user.department,
        "name": user.name,
        "email": user.email,
        "effective_name": voice_identity.primary_name(user),
        "consent": bool(user.voice_consent_at),
        "consent_at": user.voice_consent_at.isoformat() if user.voice_consent_at else None,
        "voice": {
            "enrolled": vp is not None and bool(vp.embedding),
            "status": "active" if (vp is not None and vp.embedding) else "not_enrolled",
            "sample_count": vp.sample_count if vp else 0,
            "updated_at": vp.updated_at.isoformat() if vp and vp.updated_at else None,
        },
    }


# -- Endpoints --------------------------------------------------------------

@router.get("")
def get_profile(
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
) -> dict:
    return _profile_payload(db, user)


@router.put("")
def update_profile(
    payload: ProfileIn,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
) -> dict:
    user.display_name = _clean(payload.display_name)
    user.job_title = _clean(payload.job_title)
    user.company_name = _clean(payload.company_name)
    user.department = _clean(payload.department)
    if payload.consent is True and not user.voice_consent_at:
        user.voice_consent_at = datetime.now(timezone.utc)
    elif payload.consent is False:
        user.voice_consent_at = None
    vp = voice_identity.primary_for_user(db, user)
    if payload.consent is False and vp is not None:
        # Consent withdrawn: remove the fingerprint so identification truly stops.
        db.delete(vp)
    elif vp is not None:
        # Keep the registered voiceprint's display name in sync.
        vp.canonical_name = voice_identity.primary_name(user)
        vp.updated_at = utcnow()
    db.commit()
    db.refresh(user)
    return _profile_payload(db, user)


async def _transcribe_upload(file: UploadFile) -> str:
    """Save the uploaded sample to a temp file, transcribe it, then delete it.
    Returns the transcript text. Raises HTTPException on bad input."""
    suffix = Path(file.filename or "").suffix.lower() or ".webm"
    if suffix not in ALLOWED_SAMPLE_EXTS:
        raise HTTPException(status_code=415, detail=f"Unsupported audio type: {suffix}")

    settings = get_settings()
    tmp = settings.audio_path / f"voice_sample_{uuid.uuid4().hex}{suffix}"
    max_bytes = MAX_SAMPLE_MB * 1024 * 1024
    written = 0
    try:
        with open(tmp, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > max_bytes:
                    raise HTTPException(
                        status_code=413, detail=f"Sample exceeds {MAX_SAMPLE_MB} MB limit"
                    )
                out.write(chunk)
        if written == 0:
            raise HTTPException(status_code=400, detail="Empty audio upload")
        stt = transcribe_audio(tmp)
    finally:
        tmp.unlink(missing_ok=True)

    text = (stt.get("text") or "").strip()
    if len(text) < MIN_SAMPLE_CHARS:
        raise HTTPException(
            status_code=422,
            detail=(
                "Couldn't get enough clear speech from that sample. Please record or "
                "upload at least 15 seconds of you speaking naturally."
            ),
        )
    return text


@router.post("/sample")
async def enroll_voice_sample(
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
) -> dict:
    if not user.voice_consent_at:
        raise HTTPException(
            status_code=403,
            detail="Please accept the voice profile consent notice before adding a sample.",
        )
    text = await _transcribe_upload(file)
    voice_identity.enroll_sample(db, user, text)
    return _profile_payload(db, user)


@router.post("/test")
async def test_voice_recognition(
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
) -> dict:
    if voice_identity.primary_for_user(db, user) is None:
        raise HTTPException(
            status_code=404,
            detail="No voice profile to test yet. Add a voice sample first.",
        )
    text = await _transcribe_upload(file)
    return voice_identity.test_recognition(db, user, text)


@router.delete("")
def delete_voice_profile(
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
) -> dict:
    vp = voice_identity.primary_for_user(db, user)
    if vp is not None:
        db.delete(vp)
    user.voice_consent_at = None
    db.commit()
    db.refresh(user)
    return _profile_payload(db, user)
