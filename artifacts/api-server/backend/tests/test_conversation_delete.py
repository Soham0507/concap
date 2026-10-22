"""Deleting a conversation via the router.

Calls the router function directly (the suite's established pattern). Focus:
the conversation row is removed, its on-disk recording is cleaned up, and a
conversation from another org is invisible (404) so a tenant can never delete
another tenant's data.
"""
from __future__ import annotations

from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.config import get_settings
from app.database import Base
from app.models import (
    ActionItem,
    Conversation,
    Organization,
    PlaudRecording,
    Quote,
    User,
    Visitor,
)
from app.routers.conversations import delete_conversation


@pytest.fixture
def fk_db():
    """An in-memory SQLite session with foreign-key enforcement ON.

    The shared `db` fixture mirrors dev (Postgres), where the app never
    registers SQLite's FK pragma, so DB-level CASCADE/SET NULL don't fire
    there. Deploy runs on SQLite *with* the pragma, so this fixture proves the
    declared FK side-effects behave as documented on that engine.
    """
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        future=True,
    )

    @event.listens_for(engine, "connect")
    def _fk_on(dbapi_connection, _record):  # noqa: ANN001
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _org(db, name="Org"):
    o = Organization(name=name, org_type="company")
    db.add(o)
    db.commit()
    db.refresh(o)
    return o


def _user(db, org):
    u = User(org_id=org.id, email=f"rep@{org.id}.example", name="Rep", password_hash="x")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _visitor(db, org, name="Person"):
    v = Visitor(org_id=org.id, name=name, source="manual", contact_type="lead",
                created_at=datetime(2026, 1, 1))
    db.add(v)
    db.commit()
    db.refresh(v)
    return v


def _conversation(db, org, visitor, **extra):
    conv = Conversation(org_id=org.id, visitor_id=visitor.id, status="analyzed",
                        created_at=datetime(2026, 1, 2), **extra)
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return conv


def test_delete_removes_conversation(db):
    org = _org(db)
    user = _user(db, org)
    conv = _conversation(db, org, _visitor(db, org))

    resp = delete_conversation(conv.id, db=db, user=user)

    assert resp.status_code == 204
    assert db.get(Conversation, conv.id) is None


def test_delete_removes_audio_file(db, tmp_path):
    org = _org(db)
    user = _user(db, org)
    # Point the audio dir at a temp location and drop a file there.
    settings = get_settings()
    object.__setattr__(settings, "audio_dir", str(tmp_path))
    audio_file = tmp_path / "rec.webm"
    audio_file.write_bytes(b"fake-audio")
    conv = _conversation(db, org, _visitor(db, org), audio_filename=str(audio_file))

    delete_conversation(conv.id, db=db, user=user)

    assert not audio_file.exists()
    assert db.get(Conversation, conv.id) is None


def test_delete_missing_audio_file_still_deletes(db, tmp_path):
    org = _org(db)
    user = _user(db, org)
    settings = get_settings()
    object.__setattr__(settings, "audio_dir", str(tmp_path))
    # Reference a file that was never written — deletion must not blow up.
    conv = _conversation(db, org, _visitor(db, org),
                         audio_filename=str(tmp_path / "gone.webm"))

    resp = delete_conversation(conv.id, db=db, user=user)
    assert resp.status_code == 204
    assert db.get(Conversation, conv.id) is None


def test_delete_rejects_cross_tenant_conversation(db):
    org_a = _org(db, "A")
    org_b = _org(db, "B")
    user_b = _user(db, org_b)
    conv = _conversation(db, org_a, _visitor(db, org_a, "Mine"))

    with pytest.raises(HTTPException) as exc:
        delete_conversation(conv.id, db=db, user=user_b)
    assert exc.value.status_code == 404
    # The row is untouched.
    assert db.get(Conversation, conv.id) is not None


def test_delete_unknown_id_returns_404(db):
    org = _org(db)
    user = _user(db, org)
    with pytest.raises(HTTPException) as exc:
        delete_conversation(999999, db=db, user=user)
    assert exc.value.status_code == 404


def test_delete_leaves_audio_outside_audio_dir_untouched(db, tmp_path):
    # A tampered/legacy audio_filename pointing outside the configured audio
    # dir must never be unlinked, yet the conversation still deletes.
    org = _org(db)
    user = _user(db, org)
    settings = get_settings()
    object.__setattr__(settings, "audio_dir", str(tmp_path / "audio"))
    outside = tmp_path / "outside.webm"
    outside.write_bytes(b"do-not-touch")
    conv = _conversation(db, org, _visitor(db, org), audio_filename=str(outside))

    resp = delete_conversation(conv.id, db=db, user=user)

    assert resp.status_code == 204
    assert db.get(Conversation, conv.id) is None
    assert outside.exists()  # file outside audio_dir survives


def test_delete_cascades_and_nulls_related_rows(fk_db):
    # Proves the declared FKs on the SQLite (deploy) engine: action items
    # cascade-delete, while Plaud recordings and quotes keep their rows but
    # have the conversation link set to NULL.
    db = fk_db
    org = _org(db)
    user = _user(db, org)
    conv = _conversation(db, org, _visitor(db, org))

    action = ActionItem(org_id=org.id, conversation_id=conv.id, task="Follow up")
    rec = PlaudRecording(org_id=org.id, user_id=user.id, plaud_file_id="f1",
                         conversation_id=conv.id)
    quote = Quote(org_id=org.id, user_id=user.id, title="Q1",
                  source_conversation_id=conv.id)
    db.add_all([action, rec, quote])
    db.commit()
    action_id, rec_id, quote_id = action.id, rec.id, quote.id

    delete_conversation(conv.id, db=db, user=user)
    db.expire_all()

    assert db.get(ActionItem, action_id) is None              # CASCADE
    assert db.get(PlaudRecording, rec_id).conversation_id is None  # SET NULL
    assert db.get(Quote, quote_id).source_conversation_id is None  # SET NULL
