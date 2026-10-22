"""Tests for the Meeting Intelligence routes, worker, and summary aggregation.

Fully offline: the OpenAI key check is forced "configured", extraction is
mocked (no network), and audio transcription is monkeypatched. The in-memory
SQLite `db`/`org` fixtures come from conftest.py.
"""
from __future__ import annotations

import asyncio
import io

import pytest
from fastapi import HTTPException, UploadFile

from app.models import MeetingBatch, MeetingDocument, User
from app.routers import meetings as router
from app.services import meeting_worker as worker


def _user(db, org, email="rep@example.com") -> User:
    u = User(org_id=org.id, email=email, name="Rep", password_hash="x")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _other_org_user(db):
    from app.models import Organization

    o = Organization(name="Other Org", org_type="company")
    db.add(o)
    db.commit()
    db.refresh(o)
    return _user(db, o, email="other@example.com")


@pytest.fixture
def key_ok(monkeypatch):
    monkeypatch.setattr(router, "describe_openai_key_problem", lambda: None)


def _fake_extract(transcript, metadata):
    return {
        "document_json": {
            "executive_summary": "We agreed to ship.",
            "decisions_taken": ["Ship on Friday"],
            "discussion_points": ["Timeline review"],
            "risks": [],
            "pending_clarifications": [],
            "next_steps": ["Notify the team"],
            "action_items": [
                {"task": "Email the client", "owner": "Jane", "deadline": "Friday",
                 "status": "Open", "source_quote": "Jane: I'll email the client."},
            ],
            "evidence_quotes": {
                "decisions_taken": ["We decided to ship on Friday."],
                "discussion_points": ["Let's review the timeline."],
                "next_steps": ["We'll notify the team."],
            },
        },
        "document_markdown": "# Minutes\n\n## Decisions\n\n- Ship on Friday",
        "confidence_score": 0.9,
        "chunk_count": 1,
        "token_usage": {"total_tokens": 100},
        "meeting_title": "Sprint Sync",
    }


# --- single transcript ----------------------------------------------------

def test_process_requires_min_length(db, org, key_ok):
    user = _user(db, org)
    with pytest.raises(HTTPException) as ei:
        router.process_transcript(
            router.ProcessIn(transcript_text="too short", meeting_source="zoom"),
            db=db, user=user,
        )
    assert ei.value.status_code == 400


def test_process_enqueues_document(db, org, key_ok):
    user = _user(db, org)
    body = router.ProcessIn(
        transcript_text="This is a sufficiently long transcript for testing extraction.",
        meeting_source="zoom",
    )
    out = router.process_transcript(body, db=db, user=user)
    assert out["status"] == "queued"
    assert out["org_id"] if "org_id" in out else True
    doc = db.get(MeetingDocument, out["id"])
    assert doc is not None and doc.org_id == org.id and doc.user_id == user.id


def test_process_blocked_without_key(db, org, monkeypatch):
    monkeypatch.setattr(router, "describe_openai_key_problem", lambda: "OPENAI key missing")
    user = _user(db, org)
    with pytest.raises(HTTPException) as ei:
        router.process_transcript(
            router.ProcessIn(transcript_text="a" * 40, meeting_source="zoom"),
            db=db, user=user,
        )
    assert ei.value.status_code == 400


# --- tenancy --------------------------------------------------------------

def test_cross_org_get_returns_404(db, org, key_ok):
    owner = _user(db, org)
    out = router.process_transcript(
        router.ProcessIn(transcript_text="a" * 40, meeting_source="zoom"),
        db=db, user=owner,
    )
    intruder = _other_org_user(db)
    with pytest.raises(HTTPException) as ei:
        router.get_document(out["id"], db=db, user=intruder)
    assert ei.value.status_code == 404


# --- bulk JSON batch ------------------------------------------------------

def test_create_batch_skips_short_rows(db, org, key_ok):
    user = _user(db, org)
    body = router.BulkIn(transcripts=[
        router.BulkItem(transcript_text="a" * 40),
        router.BulkItem(transcript_text="short"),  # skipped
        router.BulkItem(transcript_text="b" * 40),
    ])
    out = router.create_batch(body, db=db, user=user)
    assert out["enqueued"] == 2
    batch = db.get(MeetingBatch, out["batch"]["id"])
    assert batch.total_count == 2 and batch.status == "running"


def test_create_batch_all_invalid_raises(db, org, key_ok):
    user = _user(db, org)
    body = router.BulkIn(transcripts=[router.BulkItem(transcript_text="x")])
    with pytest.raises(HTTPException) as ei:
        router.create_batch(body, db=db, user=user)
    assert ei.value.status_code == 400


# --- multipart upload (text + audio) --------------------------------------

def test_upload_batch_text_and_audio(db, org, key_ok, monkeypatch, tmp_path):
    from app.config import get_settings
    object.__setattr__(get_settings(), "audio_dir", str(tmp_path))

    user = _user(db, org)
    text_file = UploadFile(filename="notes.txt", file=io.BytesIO(b"a" * 60))
    audio_file = UploadFile(filename="call.mp3", file=io.BytesIO(b"FAKEAUDIO" * 100))

    out = asyncio.run(router.upload_batch(
        files=[text_file, audio_file],
        label="Batch A", project_name=None, department=None,
        meeting_source="upload", meeting_date=None,
        db=db, user=user,
    ))
    assert out["enqueued"] == 2
    docs = db.query(MeetingDocument).filter(MeetingDocument.batch_id == out["batch"]["id"]).all()
    kinds = sorted([bool(d.audio_path) for d in docs])
    assert kinds == [False, True]  # one text doc, one audio doc with a saved path


def test_upload_batch_no_usable_files(db, org, key_ok, tmp_path):
    from app.config import get_settings
    object.__setattr__(get_settings(), "audio_dir", str(tmp_path))
    user = _user(db, org)
    bad = UploadFile(filename="tiny.txt", file=io.BytesIO(b"x"))
    with pytest.raises(HTTPException) as ei:
        asyncio.run(router.upload_batch(
            files=[bad], label=None, project_name=None, department=None,
            meeting_source=None, meeting_date=None, db=db, user=user,
        ))
    assert ei.value.status_code == 400


def test_upload_batch_rejects_oversized_text(db, org, key_ok, tmp_path, monkeypatch):
    """A text file beyond the cap must be skipped without being read whole into
    memory — and since it's the only file, the request 400s."""
    from app.config import get_settings
    object.__setattr__(get_settings(), "audio_dir", str(tmp_path))
    monkeypatch.setattr(router, "TEXT_MAX_MB", 1)
    user = _user(db, org)
    big = UploadFile(filename="huge.txt", file=io.BytesIO(b"a" * (2 * 1024 * 1024)))
    with pytest.raises(HTTPException) as ei:
        asyncio.run(router.upload_batch(
            files=[big], label=None, project_name=None, department=None,
            meeting_source=None, meeting_date=None, db=db, user=user,
        ))
    assert ei.value.status_code == 400
    assert "exceeds" in ei.value.detail.lower()


def test_upload_batch_rejects_extensionless(db, org, key_ok, tmp_path):
    """Extensionless files are no longer read as text (avoids slurping binary
    blobs into memory); they're reported as unsupported."""
    from app.config import get_settings
    object.__setattr__(get_settings(), "audio_dir", str(tmp_path))
    user = _user(db, org)
    noext = UploadFile(filename="mysteryfile", file=io.BytesIO(b"a" * 60))
    with pytest.raises(HTTPException) as ei:
        asyncio.run(router.upload_batch(
            files=[noext], label=None, project_name=None, department=None,
            meeting_source=None, meeting_date=None, db=db, user=user,
        ))
    assert ei.value.status_code == 400


# --- worker + summary end-to-end ------------------------------------------

def test_worker_processes_and_summary_aggregates(db, org, key_ok, monkeypatch):
    """Two meetings sharing a decision -> the summary dedupes by lowercased
    text and reports a source count of 2, with evidence quotes attached."""
    monkeypatch.setattr(worker, "extract_document", _fake_extract)
    # Make the worker use OUR in-memory session, not a fresh SessionLocal.
    monkeypatch.setattr(worker, "SessionLocal", lambda: _NoCloseSession(db))

    user = _user(db, org)
    body = router.BulkIn(transcripts=[
        router.BulkItem(transcript_text="a" * 40),
        router.BulkItem(transcript_text="b" * 40),
    ])
    out = router.create_batch(body, db=db, user=user)
    batch_id = out["batch"]["id"]

    # Drain the queue.
    for _ in range(5):
        if not worker._process_next():
            break

    detail = router.get_batch(batch_id, db=db, user=user)
    assert detail["batch"]["status"] == "completed"
    assert detail["batch"]["completed_count"] == 2

    summary = router.batch_summary(batch_id, db=db, user=user)["summary"]
    assert summary["total_docs"] == 2
    decisions = summary["decisions_taken"]
    assert len(decisions) == 1                    # "Ship on Friday" deduped
    assert len(decisions[0]["sources"]) == 2      # from both meetings
    assert any(srcs.get("quote") for srcs in decisions[0]["sources"])
    actions = summary["action_items"]
    assert len(actions) == 1 and actions[0]["owner"] == "Jane"


def test_worker_marks_failed_on_extract_error(db, org, key_ok, monkeypatch):
    def _boom(transcript, metadata):
        raise RuntimeError("model exploded")
    monkeypatch.setattr(worker, "extract_document", _boom)
    monkeypatch.setattr(worker, "SessionLocal", lambda: _NoCloseSession(db))

    user = _user(db, org)
    out = router.create_batch(
        router.BulkIn(transcripts=[router.BulkItem(transcript_text="a" * 40)]),
        db=db, user=user,
    )
    worker._process_next()
    detail = router.get_batch(out["batch"]["id"], db=db, user=user)
    assert detail["batch"]["status"] == "failed"
    assert detail["documents"][0]["status"] == "failed"
    assert "model exploded" in (detail["documents"][0]["error_message"] or "")


class _NoCloseSession:
    """Wrap the test session so the worker's `with SessionLocal() as db`
    context manager doesn't close our shared in-memory session."""

    def __init__(self, session):
        self._s = session

    def __enter__(self):
        return self._s

    def __exit__(self, *exc):
        return False
