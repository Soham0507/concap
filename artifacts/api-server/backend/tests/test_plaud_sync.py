"""Plaud sync: pull recordings, dedupe on recording id, and create both a
queued meeting doc and a standard Concap Conversation (with backfill)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks

from app.models import Conversation, MeetingDocument, PlaudRecording, Visitor
from app.routers import plaud as router
from app.services import plaud_mcp
from app.services import plaud_oauth as oauth
from app.services.crypto import encrypt


@pytest.fixture
def connected_user(db, user):
    user.plaud_access_token_enc = encrypt("access-token")
    user.plaud_refresh_token_enc = encrypt("refresh-token")
    user.plaud_token_expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
    user.plaud_needs_reconnect = False
    user.plaud_client_id = "test-plaud-client-id"
    db.commit()
    return user


def _mock_mcp(monkeypatch, recordings, *, transcripts=None, notes=None):
    transcripts = transcripts or {}
    notes = notes or {}
    monkeypatch.setattr(plaud_mcp, "list_files", lambda token: recordings)
    monkeypatch.setattr(
        plaud_mcp, "get_transcript",
        lambda token, fid: transcripts.get(fid, ""),
    )
    monkeypatch.setattr(
        plaud_mcp, "get_note",
        lambda token, fid: notes.get(fid, {"text": "", "json": None}),
    )


def test_sync_imports_new_and_dedupes(db, connected_user, monkeypatch):
    recs = [
        {"id": "r1", "title": "Standup"},
        {"id": "r2", "title": "Roadmap"},
    ]
    _mock_mcp(monkeypatch, recs, transcripts={
        "r1": "This is a sufficiently long transcript for standup notes today.",
        "r2": "Roadmap discussion transcript that is also long enough to extract.",
    }, notes={
        "r1": {"text": "Plaud summary one", "json": {"k": 1}},
    })

    out = router.plaud_sync(background=BackgroundTasks(), db=db, user=connected_user)
    assert out["imported"] == 2
    assert out["skipped_existing"] == 0

    docs = db.query(MeetingDocument).filter(MeetingDocument.user_id == connected_user.id).all()
    assert len(docs) == 2
    assert all(d.meeting_source == "plaud" and d.status == "queued" for d in docs)
    r1 = next(d for d in docs if d.external_id == "r1")
    assert r1.source_summary == "Plaud summary one"
    assert r1.source_summary_json == {"k": 1}
    assert db.query(PlaudRecording).count() == 2

    # Re-running imports nothing new (dedup on plaud_file_id).
    out2 = router.plaud_sync(background=BackgroundTasks(), db=db, user=connected_user)
    assert out2["imported"] == 0
    assert out2["skipped_existing"] == 2
    assert db.query(MeetingDocument).count() == 2


def test_sync_falls_back_to_summary_when_no_transcript(db, connected_user, monkeypatch):
    recs = [{"id": "r9", "title": "Voice memo"}]
    _mock_mcp(monkeypatch, recs, transcripts={"r9": ""}, notes={
        "r9": {"text": "A summary long enough to serve as the document body here.", "json": None},
    })
    out = router.plaud_sync(background=BackgroundTasks(), db=db, user=connected_user)
    assert out["imported"] == 1
    doc = db.query(MeetingDocument).filter(MeetingDocument.external_id == "r9").one()
    assert "summary long enough" in doc.transcript_text


def test_sync_skips_empty_recordings(db, connected_user, monkeypatch):
    recs = [{"id": "r0", "title": "Empty"}]
    _mock_mcp(monkeypatch, recs, transcripts={"r0": "too short"}, notes={"r0": {"text": "", "json": None}})
    out = router.plaud_sync(background=BackgroundTasks(), db=db, user=connected_user)
    assert out["imported"] == 0
    assert out["skipped_empty"] == 1
    assert db.query(MeetingDocument).count() == 0


def test_sync_auth_error_flips_reconnect(db, connected_user, monkeypatch):
    def _boom(token):
        raise plaud_mcp.PlaudMCPAuthError("401 unauthorized")
    monkeypatch.setattr(plaud_mcp, "list_files", _boom)

    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        router.plaud_sync(background=BackgroundTasks(), db=db, user=connected_user)
    assert exc_info.value.status_code == 400
    db.refresh(connected_user)
    assert connected_user.plaud_needs_reconnect is True


def test_sync_requires_connection(db, user):
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        router.plaud_sync(background=BackgroundTasks(), db=db, user=user)


def test_sync_creates_conversations_for_new_recordings(db, connected_user, monkeypatch):
    recs = [{"id": "c1", "title": "Discovery call"}]
    _mock_mcp(monkeypatch, recs, transcripts={
        "c1": "A discovery call transcript long enough for the pipeline to run.",
    })

    out = router.plaud_sync(background=BackgroundTasks(), db=db, user=connected_user)
    assert out["imported"] == 1
    assert out["conversations_created"] == 1

    convs = db.query(Conversation).filter(Conversation.org_id == connected_user.org_id).all()
    assert len(convs) == 1
    conv = convs[0]
    assert conv.client_capture_id == f"plaud:{connected_user.org_id}:c1"
    assert conv.event_name == "Plaud"
    assert conv.transcript and len(conv.transcript) >= 20
    assert conv.visitor_id is not None
    visitor = db.get(Visitor, conv.visitor_id)
    assert visitor.source == "plaud"
    assert visitor.name == "Discovery call"

    rec = db.query(PlaudRecording).filter(PlaudRecording.plaud_file_id == "c1").one()
    assert rec.conversation_id == conv.id

    # Re-running creates no duplicate conversation.
    out2 = router.plaud_sync(background=BackgroundTasks(), db=db, user=connected_user)
    assert out2["conversations_created"] == 0
    assert db.query(Conversation).count() == 1


def test_sync_backfills_conversation_for_legacy_recording(db, connected_user, monkeypatch):
    """A recording imported before the conversation bridge (no conversation_id)
    gets a Conversation on the next sync, reusing the meeting doc's transcript
    without re-fetching Plaud."""
    doc = MeetingDocument(
        org_id=connected_user.org_id,
        user_id=connected_user.id,
        transcript_id="t-legacy",
        meeting_source="plaud",
        meeting_title="Legacy meeting",
        participants=[],
        transcript_text="Legacy transcript that is comfortably long enough to analyze.",
        external_id="legacy1",
        status="done",
    )
    db.add(doc)
    db.flush()
    db.add(PlaudRecording(
        org_id=connected_user.org_id,
        user_id=connected_user.id,
        plaud_file_id="legacy1",
        title="Legacy meeting",
        document_id=doc.id,
        conversation_id=None,
    ))
    db.commit()

    recs = [{"id": "legacy1", "title": "Legacy meeting"}]
    _mock_mcp(monkeypatch, recs)

    out = router.plaud_sync(background=BackgroundTasks(), db=db, user=connected_user)
    assert out["imported"] == 0
    assert out["skipped_existing"] == 1
    assert out["conversations_created"] == 1

    rec = db.query(PlaudRecording).filter(PlaudRecording.plaud_file_id == "legacy1").one()
    assert rec.conversation_id is not None
    conv = db.get(Conversation, rec.conversation_id)
    assert conv.client_capture_id == f"plaud:{connected_user.org_id}:legacy1"
    assert conv.transcript == doc.transcript_text
