"""Tests for the Primary User Voice Profile.

Fully offline: routes are called directly (the suite's convention) and audio
transcription is monkeypatched so no Deepgram/Whisper call runs. Covers identity
update + consent, sample enrollment (create + merge), test-recognition, delete,
the native-pipeline relabeling that replaces "Speaker N" with the user's name,
and that imported-meeting matching picks up the primary voiceprint.
"""
from __future__ import annotations

import asyncio
import io

import pytest
from fastapi import HTTPException
from starlette.datastructures import Headers, UploadFile

from app.models import Conversation, Organization, SpeakerVoiceprint, User, Visitor
from app.routers import voice_profile as vpr
from app.services import voice_identity, voiceprints


# --- helpers --------------------------------------------------------------

DISTINCTIVE = (
    "Honestly, basically, I literally think we should totally ship this, you know, like "
    "right now, I mean obviously it's definitely ready, anyway, yeah, let's just do it folks. "
    "So, like, really, we should definitely move on this today, honestly."
)


def _upload(filename: str, data: bytes = b"x") -> UploadFile:
    return UploadFile(
        file=io.BytesIO(data),
        filename=filename,
        headers=Headers({"content-type": "application/octet-stream"}),
    )


@pytest.fixture
def fake_stt(monkeypatch):
    """Patch transcription so any uploaded sample yields a chosen transcript."""
    box = {"text": DISTINCTIVE}
    monkeypatch.setattr(vpr, "transcribe_audio", lambda path: {"text": box["text"]})
    return box


def _consent(db, user):
    vpr.update_profile(
        vpr.ProfileIn(display_name="Mateen", job_title="Consultant", consent=True),
        user=user,
        db=db,
    )


# --- identity + consent ---------------------------------------------------

def test_update_profile_sets_identity_and_consent(db, user):
    out = vpr.update_profile(
        vpr.ProfileIn(display_name="Mateen", job_title="Consultant",
                      company_name="ABC Consulting", department="Advisory", consent=True),
        user=user, db=db,
    )
    assert out["display_name"] == "Mateen"
    assert out["effective_name"] == "Mateen"
    assert out["consent"] is True
    assert out["consent_at"]
    assert out["voice"]["status"] == "not_enrolled"


def test_effective_name_falls_back_to_name_then_email(db, org):
    u = User(org_id=org.id, email="jane@x.com", name="Jane Roe", password_hash="x", role="owner")
    db.add(u); db.commit(); db.refresh(u)
    assert voice_identity.primary_name(u) == "Jane Roe"
    u.name = None
    assert voice_identity.primary_name(u) == "jane"


# --- enrollment -----------------------------------------------------------

def test_sample_requires_consent(db, user, fake_stt):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(vpr.enroll_voice_sample(file=_upload("s.webm"), user=user, db=db))
    assert exc.value.status_code == 403


def test_enroll_creates_primary_voiceprint(db, user, fake_stt):
    _consent(db, user)
    out = asyncio.run(vpr.enroll_voice_sample(file=_upload("s.webm"), user=user, db=db))
    assert out["voice"]["enrolled"] is True
    assert out["voice"]["status"] == "active"
    assert out["voice"]["sample_count"] == 1

    vp = voice_identity.primary_for_user(db, user)
    assert vp is not None and vp.is_primary is True
    assert vp.user_id == user.id
    assert vp.canonical_name == "Mateen"
    assert len(vp.embedding) == voiceprints.VOICEPRINT_DIM


def test_enroll_merges_and_increments_sample_count(db, user, fake_stt):
    _consent(db, user)
    asyncio.run(vpr.enroll_voice_sample(file=_upload("s.webm"), user=user, db=db))
    out = asyncio.run(vpr.enroll_voice_sample(file=_upload("s2.webm"), user=user, db=db))
    assert out["voice"]["sample_count"] == 2


def test_enroll_rejects_unsupported_type(db, user, fake_stt):
    _consent(db, user)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(vpr.enroll_voice_sample(file=_upload("s.txt"), user=user, db=db))
    assert exc.value.status_code == 415


def test_enroll_rejects_too_short_sample(db, user, fake_stt):
    _consent(db, user)
    fake_stt["text"] = "hi"
    with pytest.raises(HTTPException) as exc:
        asyncio.run(vpr.enroll_voice_sample(file=_upload("s.webm"), user=user, db=db))
    assert exc.value.status_code == 422


# --- test recognition + delete -------------------------------------------

def test_test_recognition_matches_self(db, user, fake_stt):
    _consent(db, user)
    asyncio.run(vpr.enroll_voice_sample(file=_upload("s.webm"), user=user, db=db))
    res = asyncio.run(vpr.test_voice_recognition(file=_upload("s.webm"), user=user, db=db))
    assert res["enrolled"] is True
    assert res["recognized"] is True
    assert res["similarity"] >= 0.9


def test_test_recognition_404_without_profile(db, user, fake_stt):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(vpr.test_voice_recognition(file=_upload("s.webm"), user=user, db=db))
    assert exc.value.status_code == 404


def test_withdrawing_consent_removes_voiceprint(db, user, fake_stt):
    _consent(db, user)
    asyncio.run(vpr.enroll_voice_sample(file=_upload("s.webm"), user=user, db=db))
    assert voice_identity.primary_for_user(db, user) is not None
    out = vpr.update_profile(
        vpr.ProfileIn(display_name="Mateen", consent=False), user=user, db=db,
    )
    assert out["consent"] is False
    assert out["voice"]["enrolled"] is False
    assert voice_identity.primary_for_user(db, user) is None


def test_delete_removes_voiceprint_and_consent(db, user, fake_stt):
    _consent(db, user)
    asyncio.run(vpr.enroll_voice_sample(file=_upload("s.webm"), user=user, db=db))
    out = vpr.delete_voice_profile(user=user, db=db)
    assert out["voice"]["enrolled"] is False
    assert out["consent"] is False
    assert voice_identity.primary_for_user(db, user) is None


# --- speaker identification -----------------------------------------------

def test_identify_speakers_maps_primary_user(db, user, fake_stt):
    _consent(db, user)
    asyncio.run(vpr.enroll_voice_sample(file=_upload("s.webm"), user=user, db=db))
    utterances = [
        {"speaker": "Speaker 0", "text": DISTINCTIVE, "start": 0, "end": 30000},
        {"speaker": "Speaker 1", "text": "The quarterly report shows revenue declined.", "start": 30000, "end": 45000},
    ]
    name_map = voice_identity.identify_speakers(db, user.org_id, utterances)
    assert name_map.get("Speaker 0") == "Mateen"
    assert "Speaker 1" not in name_map


def test_pipeline_relabels_native_transcript(db, user, fake_stt, monkeypatch):
    """The native pipeline should replace the primary speaker's label with the
    user's display name in the stored transcript."""
    _consent(db, user)
    asyncio.run(vpr.enroll_voice_sample(file=_upload("s.webm"), user=user, db=db))

    visitor = Visitor(org_id=user.org_id, name="Customer", company="Acme")
    db.add(visitor); db.commit(); db.refresh(visitor)
    conv = Conversation(org_id=user.org_id, visitor_id=visitor.id, status="uploaded",
                        audio_filename="/tmp/does-not-matter.webm")
    db.add(conv); db.commit(); db.refresh(conv)

    from app.services import pipeline

    monkeypatch.setattr(pipeline.Path, "exists", lambda self: True)
    monkeypatch.setattr(pipeline, "transcribe_audio", lambda path: {
        "text": DISTINCTIVE,
        "diarized": True,
        "speaker_count": 2,
        "provider": "deepgram",
        "speakers": [
            {"speaker": "Speaker 0", "text": DISTINCTIVE, "start": 0, "end": 30000},
            {"speaker": "Speaker 1", "text": "Sounds good, send it over.", "start": 30000, "end": 33000},
        ],
    })
    monkeypatch.setattr(pipeline, "analyze_transcript", lambda text, visitor_context=None: {
        "summary": "ok", "action_items": [], "lead_score": 50, "lead_temperature": "warm",
        "topic": "demo",
    })
    monkeypatch.setattr(pipeline, "embed_text", lambda blob: None)

    pipeline.process_conversation(db, conv.id)
    db.refresh(conv)
    assert "Mateen:" in conv.transcript
    assert "Speaker 0" not in conv.transcript


def test_imported_meeting_registry_includes_primary(db, user, fake_stt):
    _consent(db, user)
    asyncio.run(vpr.enroll_voice_sample(file=_upload("s.webm"), user=user, db=db))
    reg = voice_identity.registry_for_org(db, user.org_id)
    assert any(r["canonical_name"] == "Mateen" for r in reg)


def test_tenancy_primary_is_per_user(db, user, fake_stt):
    _consent(db, user)
    asyncio.run(vpr.enroll_voice_sample(file=_upload("s.webm"), user=user, db=db))
    other_org = Organization(name="Other", org_type="company")
    db.add(other_org); db.commit(); db.refresh(other_org)
    other = User(org_id=other_org.id, email="z@z.com", password_hash="x", role="owner")
    db.add(other); db.commit(); db.refresh(other)
    assert voice_identity.primary_for_user(db, other) is None
    assert voice_identity.registry_for_org(db, other_org.id) == []
