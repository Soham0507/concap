"""Tests for the "All Meetings" aggregation endpoint (``GET /api/meetings/all``).

Fully offline: the in-memory SQLite ``db``/``org``/``user`` fixtures come from
conftest.py and provider-connection state is stubbed by monkeypatching
``all_meetings.oauth.org_connected`` (no real OAuth tokens or network).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.models import (
    CreatedMeeting,
    ImportedMeeting,
    MeetingDocument,
    Organization,
    User,
)
from app.routers import all_meetings as router


def _call(db, user, **kw):
    params = dict(source=None, q=None, limit=50, offset=0, db=db, user=user)
    params.update(kw)
    return router.list_all_meetings(**params)


def _doc(db, org, title, created_at, **kw):
    d = MeetingDocument(
        org_id=org.id,
        transcript_id=f"TRX-{title}",
        meeting_title=title,
        meeting_source=kw.get("meeting_source", "text"),
        status=kw.get("status", "completed"),
        participants=kw.get("participants"),
        created_at=created_at,
    )
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


def _imported(db, org, title, started_at, provider="manual", **kw):
    m = ImportedMeeting(
        org_id=org.id,
        provider=provider,
        title=title,
        started_at=started_at,
        status=kw.get("status", "completed"),
        participants=kw.get("participants"),
        speakers=kw.get("speakers"),
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


def _created(db, org, title, start_at, provider="zoom", **kw):
    r = CreatedMeeting(
        org_id=org.id,
        provider=provider,
        title=title,
        start_at=start_at,
        attendees=kw.get("attendees"),
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


@pytest.fixture
def all_connected(monkeypatch):
    monkeypatch.setattr(router.oauth, "org_connected", lambda org, provider: True)


@pytest.fixture
def none_connected(monkeypatch):
    monkeypatch.setattr(router.oauth, "org_connected", lambda org, provider: False)


def test_merges_all_sources_newest_first(db, org, user, all_connected):
    now = datetime(2026, 1, 3, 12, 0, tzinfo=timezone.utc)
    _doc(db, org, "Intel doc", now - timedelta(days=2))
    _imported(db, org, "Imported call", now - timedelta(days=1), provider="discord")
    _created(db, org, "Zoom sync", now, provider="zoom")

    out = _call(db, user)
    assert out["total"] == 3
    titles = [m["title"] for m in out["meetings"]]
    # Newest first: created (now) > imported (now-1d) > intel (now-2d)
    assert titles == ["Zoom sync", "Imported call", "Intel doc"]
    sources = [m["source"] for m in out["meetings"]]
    assert sources == ["zoom", "imported", "intelligence"]
    # _sort is stripped from the serialized payload
    assert all("_sort" not in m for m in out["meetings"])


def test_ms_teams_provider_normalized(db, org, user, all_connected):
    now = datetime(2026, 2, 1, 9, 0, tzinfo=timezone.utc)
    _created(db, org, "Teams standup", now, provider="ms_teams")
    out = _call(db, user)
    assert out["total"] == 1
    assert out["meetings"][0]["source"] == "microsoft_teams"
    assert out["meetings"][0]["provider"] == "ms_teams"


def test_org_scoped_no_cross_org_leak(db, org, user, all_connected):
    other = Organization(name="Other Org", org_type="company")
    db.add(other)
    db.commit()
    db.refresh(other)
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    _doc(db, org, "Mine", now)
    _doc(db, other, "Theirs", now)
    _imported(db, other, "Theirs imported", now)

    out = _call(db, user)
    assert out["total"] == 1
    assert out["meetings"][0]["title"] == "Mine"


def test_source_filter(db, org, user, all_connected):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    _doc(db, org, "Intel doc", now)
    _imported(db, org, "Imported call", now)
    _created(db, org, "Zoom sync", now, provider="zoom")

    intel = _call(db, user, source="intelligence")
    assert [m["source"] for m in intel["meetings"]] == ["intelligence"]

    imported = _call(db, user, source="imported")
    assert [m["source"] for m in imported["meetings"]] == ["imported"]

    zoom = _call(db, user, source="zoom")
    assert [m["source"] for m in zoom["meetings"]] == ["zoom"]


def test_invalid_source_falls_back_to_all(db, org, user, all_connected):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    _doc(db, org, "Intel doc", now)
    _imported(db, org, "Imported call", now)
    out = _call(db, user, source="bogus")
    assert out["total"] == 2


def test_search_matches_title_only(db, org, user, all_connected):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    _doc(db, org, "Acme kickoff", now)
    _imported(db, org, "Weekly standup", now)
    out = _call(db, user, q="acme")
    assert out["total"] == 1
    assert out["meetings"][0]["title"] == "Acme kickoff"


def test_created_meetings_hidden_when_provider_disconnected(db, org, user, none_connected):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    _doc(db, org, "Intel doc", now)
    _created(db, org, "Zoom sync", now, provider="zoom")
    out = _call(db, user)
    # Intelligence doc shows, but the provider-created meeting is hidden.
    assert out["total"] == 1
    assert out["meetings"][0]["source"] == "intelligence"


def test_created_status_scheduled_vs_completed(db, org, user, all_connected):
    now = datetime.now(timezone.utc)
    _created(db, org, "Past meeting", now - timedelta(days=1), provider="zoom")
    _created(db, org, "Future meeting", now + timedelta(days=1), provider="google_meet")
    out = _call(db, user)
    by_title = {m["title"]: m for m in out["meetings"]}
    assert by_title["Past meeting"]["status"] == "completed"
    assert by_title["Future meeting"]["status"] == "scheduled"


def test_pagination(db, org, user, all_connected):
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for i in range(5):
        _imported(db, org, f"M{i}", base + timedelta(days=i))
    page = _call(db, user, limit=2, offset=0)
    assert page["total"] == 5
    assert page["limit"] == 2
    assert len(page["meetings"]) == 2
    # Newest first -> M4, M3
    assert [m["title"] for m in page["meetings"]] == ["M4", "M3"]

    page2 = _call(db, user, limit=2, offset=2)
    assert [m["title"] for m in page2["meetings"]] == ["M2", "M1"]


def test_participant_count(db, org, user, all_connected):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    _doc(db, org, "Doc", now, participants=["a", "b", "c"])
    out = _call(db, user)
    assert out["meetings"][0]["participants"] == 3
