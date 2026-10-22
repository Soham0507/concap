"""Tests for the Google Meet create-meeting + calendar-browse endpoints.

These run fully offline: the org is marked connected by writing an encrypted
access token directly, and the Calendar REST calls are mocked. They assert
tenancy/connection gating, the happy path, the Meet-link extraction, and the
403→"reconnect to grant calendar access" mapping.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.routers import imported_meetings as router
from app.services import email_sender
from app.services import meeting_oauth as oauth
from app.services import meeting_providers

from tests.helpers import FakeResponse


class _OkSMTP:
    """A configured, no-op SMTP transport so invitation sends succeed offline."""

    def __init__(self, host, port, timeout=None):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def ehlo(self):
        pass

    def starttls(self, context=None):
        pass

    def login(self, user, password):
        pass

    def sendmail(self, from_addr, to_addrs, msg):
        pass


class _MailCfg:
    smtp_host = "smtp.test"
    smtp_port = 587
    smtp_username = ""
    smtp_password = ""
    smtp_use_tls = False
    smtp_use_ssl = False
    smtp_from_email = "invites@concap.ai"
    smtp_from_name = "Concap AI"

    def email_configured(self):
        return True

    def resolved_from_email(self):
        return self.smtp_from_email


def _stub_email(monkeypatch) -> None:
    monkeypatch.setattr(email_sender, "get_settings", lambda: _MailCfg())
    monkeypatch.setattr(email_sender.smtplib, "SMTP", _OkSMTP)


def _connect_google_meet(db, org) -> None:
    """Mark the org connected to Google Meet with a non-expiring token so
    get_valid_access_token returns it without hitting the refresh path."""
    oauth._set_attr(org, "google_meet", "access_token_enc", oauth.encrypt("access-token"))
    oauth._set_attr(org, "google_meet", "token_expires_at", datetime.now(timezone.utc) + timedelta(hours=1))
    oauth._set_attr(org, "google_meet", "needs_reconnect", False)
    db.commit()


# --- connection gating ----------------------------------------------------


def test_create_meeting_requires_connection(db, user):
    with pytest.raises(HTTPException) as exc:
        router.create_google_meeting(
            payload=router.CreateMeetingIn(title="x"), db=db, user=user
        )
    assert exc.value.status_code == 400


def test_calendar_requires_connection(db, user):
    with pytest.raises(HTTPException) as exc:
        router.google_meet_calendar(past_days=7, upcoming_days=21, db=db, user=user)
    assert exc.value.status_code == 400


# --- create meeting -------------------------------------------------------


def test_create_meeting_returns_join_link(db, org, user, monkeypatch):
    _connect_google_meet(db, org)
    captured = {}

    def fake_post(url, *a, **k):
        # The same patched httpx.post also serves the Gmail invitation send;
        # only capture the Calendar event-create body here.
        if "calendar" in url:
            captured["url"] = url
            captured["json"] = k.get("json")
        return FakeResponse(200, {
            "id": "evt-1",
            "summary": "Acme intro",
            "hangoutLink": "https://meet.google.com/abc-defg-hij",
            "htmlLink": "https://calendar.google.com/event?eid=1",
            "start": {"dateTime": "2026-06-20T15:00:00Z"},
        })

    monkeypatch.setattr(meeting_providers.httpx, "post", fake_post)
    result = router.create_google_meeting(
        payload=router.CreateMeetingIn(title="Acme intro", attendees=["a@acme.com"]),
        db=db, user=user,
    )
    assert result["join_url"] == "https://meet.google.com/abc-defg-hij"
    assert result["meeting_id"] == "evt-1"
    # Conference create request + attendee must be in the outbound event body.
    assert captured["json"]["conferenceData"]["createRequest"]["conferenceSolutionKey"]["type"] == "hangoutsMeet"
    assert captured["json"]["attendees"] == [{"email": "a@acme.com"}]


def test_create_meeting_403_asks_to_reconnect(db, org, user, monkeypatch):
    _connect_google_meet(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "post",
        lambda url, *a, **k: FakeResponse(403, {"error": {"message": "Insufficient Permission"}}),
    )
    with pytest.raises(HTTPException) as exc:
        router.create_google_meeting(
            payload=router.CreateMeetingIn(title="x"), db=db, user=user
        )
    assert exc.value.status_code == 502
    assert "Reconnect Google Meet" in exc.value.detail


# --- Zoom create meeting --------------------------------------------------


def _connect_zoom(db, org) -> None:
    oauth._set_attr(org, "zoom", "access_token_enc", oauth.encrypt("access-token"))
    oauth._set_attr(org, "zoom", "token_expires_at", datetime.now(timezone.utc) + timedelta(hours=1))
    oauth._set_attr(org, "zoom", "needs_reconnect", False)
    db.commit()


def test_zoom_create_meeting_requires_connection(db, user):
    with pytest.raises(HTTPException) as exc:
        router.create_zoom_meeting(
            payload=router.CreateMeetingIn(title="x"), db=db, user=user
        )
    assert exc.value.status_code == 400


def test_zoom_create_meeting_returns_join_link(db, org, user, monkeypatch):
    _connect_zoom(db, org)
    captured = {}

    def fake_post(url, *a, **k):
        captured["url"] = url
        captured["json"] = k.get("json")
        return FakeResponse(200, {
            "id": 987654321,
            "topic": "Acme intro",
            "join_url": "https://zoom.us/j/987654321",
            "start_time": "2026-06-20T15:00:00Z",
            "duration": 30,
        })

    monkeypatch.setattr(meeting_providers.httpx, "post", fake_post)
    result = router.create_zoom_meeting(
        payload=router.CreateMeetingIn(title="Acme intro"), db=db, user=user
    )
    assert result["join_url"] == "https://zoom.us/j/987654321"
    assert result["meeting_id"] == "987654321"
    assert captured["url"].endswith("/users/me/meetings")
    assert captured["json"]["type"] == 2


def test_zoom_create_meeting_403_asks_to_reconnect(db, org, user, monkeypatch):
    _connect_zoom(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "post",
        lambda url, *a, **k: FakeResponse(403, {"message": "Invalid access token"}),
    )
    with pytest.raises(HTTPException) as exc:
        router.create_zoom_meeting(
            payload=router.CreateMeetingIn(title="x"), db=db, user=user
        )
    assert exc.value.status_code == 502
    assert "meeting:write" in exc.value.detail


# --- OAuth refresh scope behavior (regression for Google 400) -------------


def _refresh_capture(db, org, provider, monkeypatch) -> dict:
    oauth._set_attr(org, provider, "refresh_token_enc", oauth.encrypt("refresh-token"))
    db.commit()
    captured = {}

    def fake_token_request(prov, data):
        captured["data"] = data
        return {"access_token": "new-token", "expires_in": 3600}

    monkeypatch.setattr(oauth, "_token_request", fake_token_request)
    oauth._refresh(db, org, provider)
    return captured["data"]


def test_google_refresh_omits_scope(db, org, user, monkeypatch):
    data = _refresh_capture(db, org, "google_meet", monkeypatch)
    assert "scope" not in data  # Google rejects scope on refresh (400)


def test_ms_teams_refresh_includes_scope(db, org, user, monkeypatch):
    data = _refresh_capture(db, org, "ms_teams", monkeypatch)
    assert "scope" in data


# --- calendar browse ------------------------------------------------------


def test_calendar_lists_only_meet_events(db, org, user, monkeypatch):
    _connect_google_meet(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "get",
        lambda url, *a, **k: FakeResponse(200, {"items": [
            {
                "id": "e1", "summary": "Has Meet",
                "hangoutLink": "https://meet.google.com/aaa-bbbb-ccc",
                "start": {"dateTime": "2026-06-20T15:00:00Z"},
                "attendees": [{"email": "x@y.com"}, {"email": "z@y.com"}],
            },
            {
                "id": "e2", "summary": "No conference",
                "start": {"dateTime": "2026-06-21T15:00:00Z"},
            },
            {
                "id": "e3", "summary": "Entry-point Meet",
                "conferenceData": {"entryPoints": [
                    {"entryPointType": "video", "uri": "https://meet.google.com/ddd-eeee-fff"}
                ]},
                "start": {"dateTime": "2026-06-22T15:00:00Z"},
            },
        ]}),
    )
    out = router.google_meet_calendar(past_days=7, upcoming_days=21, db=db, user=user)
    ids = [e["event_id"] for e in out["events"]]
    assert ids == ["e1", "e3"]  # the no-conference event is dropped
    first = out["events"][0]
    assert first["join_url"] == "https://meet.google.com/aaa-bbbb-ccc"
    assert first["attendees"] == ["x@y.com", "z@y.com"]


def test_calendar_403_asks_to_reconnect(db, org, user, monkeypatch):
    _connect_google_meet(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "get",
        lambda url, *a, **k: FakeResponse(403, {"error": {"message": "Insufficient Permission"}}),
    )
    with pytest.raises(HTTPException) as exc:
        router.google_meet_calendar(past_days=7, upcoming_days=21, db=db, user=user)
    assert exc.value.status_code == 502
    assert "Reconnect Google Meet" in exc.value.detail


# --- pull recordings (conferenceRecords) ----------------------------------


def test_pull_recordings_403_is_permanent_and_actionable(db, org, user, monkeypatch):
    """A 403 on conferenceRecords must map to a clear, non-transient error that
    points the user at enabling the Meet API / reconnecting — NOT a retryable
    'conference list failed' message."""
    _connect_google_meet(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "get",
        lambda url, *a, **k: FakeResponse(403, {"error": {"message": "Insufficient Permission"}}),
    )
    with pytest.raises(oauth.MeetingOAuthError) as exc:
        meeting_providers.fetch_google_meet(db, org)
    assert exc.value.transient is False
    assert "Google Meet" in str(exc.value)
    assert "Insufficient Permission" in str(exc.value)


def test_sync_endpoint_403_returns_502_actionable(db, org, user, monkeypatch):
    """The user-facing 'Pull recordings' path (/providers/google_meet/sync)
    must surface the 403 as HTTP 502 with the actionable, non-retry message."""
    _connect_google_meet(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "get",
        lambda url, *a, **k: FakeResponse(403, {"error": {"message": "Insufficient Permission"}}),
    )
    with pytest.raises(HTTPException) as exc:
        router.provider_sync(provider="google_meet", since_days=30, limit=20, db=db, user=user)
    assert exc.value.status_code == 502
    assert "Insufficient Permission" in exc.value.detail


# --- Zoom pull recordings -------------------------------------------------


def test_zoom_recordings_400_paid_account_is_permanent_and_actionable(db, org, user, monkeypatch):
    """Zoom returns HTTP 400 + code 200 'Only available for Paid account' for
    Basic plans. That opaque 400 must become a clear, non-transient message about
    needing a paid plan — not a retryable 'recordings list failed'."""
    _connect_zoom(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "get",
        lambda url, *a, **k: FakeResponse(
            400, {"code": 200, "message": "Only available for Paid account: abc123"}
        ),
    )
    with pytest.raises(oauth.MeetingOAuthError) as exc:
        meeting_providers.fetch_zoom(db, org)
    assert exc.value.transient is False
    assert "paid Zoom plan" in str(exc.value)


def test_zoom_recordings_query_uses_bounded_window(db, org, user, monkeypatch):
    """Even when asked for a long history, the Zoom query must stay within Zoom's
    one-month limit and always send an explicit 'to' date."""
    _connect_zoom(db, org)
    captured = {}

    def fake_get(url, *a, **k):
        captured["params"] = k.get("params")
        return FakeResponse(200, {"meetings": []})

    monkeypatch.setattr(meeting_providers.httpx, "get", fake_get)
    meeting_providers.fetch_zoom(db, org, since_days=365)
    params = captured["params"]
    assert "to" in params and params["to"]
    frm = datetime.strptime(params["from"], "%Y-%m-%d")
    to = datetime.strptime(params["to"], "%Y-%m-%d")
    assert (to - frm).days <= 31


def test_zoom_recordings_403_points_at_scope(db, org, user, monkeypatch):
    """A 401/403 on the recordings list means the connected app lacks the
    cloud_recording:read scope; surface that, non-transient."""
    _connect_zoom(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "get",
        lambda url, *a, **k: FakeResponse(403, {"message": "Invalid access token, does not contain scopes"}),
    )
    with pytest.raises(oauth.MeetingOAuthError) as exc:
        meeting_providers.fetch_zoom(db, org)
    assert exc.value.transient is False
    assert "cloud_recording:read" in str(exc.value)


# --- Meet-link extraction -------------------------------------------------


def test_meet_link_extracted_from_non_video_entry_point():
    """A Meet URL carried under a conferenceData entry point that Google does not
    tag as 'video' must still be detected via its meet.google.com URI."""
    ev = {
        "conferenceData": {
            "entryPoints": [
                {"entryPointType": "more", "uri": "https://meet.google.com/lookup/xyz"},
            ]
        }
    }
    assert meeting_providers._meet_link_from_event(ev) == "https://meet.google.com/lookup/xyz"


def test_meet_link_none_when_no_meet_present():
    ev = {"conferenceData": {"entryPoints": [{"entryPointType": "phone", "uri": "tel:+1-555"}]}}
    assert meeting_providers._meet_link_from_event(ev) is None


# --- created-meeting persistence + connection gating ----------------------


def test_created_meeting_persists_and_lists_while_connected(db, org, user, monkeypatch):
    _connect_google_meet(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "post",
        lambda url, *a, **k: FakeResponse(200, {
            "id": "evt-1",
            "summary": "Acme intro",
            "hangoutLink": "https://meet.google.com/abc-defg-hij",
            "start": {"dateTime": "2026-06-20T15:00:00Z"},
        }),
    )
    router.create_google_meeting(
        payload=router.CreateMeetingIn(title="Acme intro", attendees=["a@acme.com"]),
        db=db, user=user,
    )
    out = router.list_created_meetings(db=db, user=user)
    assert len(out["meetings"]) == 1
    m = out["meetings"][0]
    assert m["provider"] == "google_meet"
    assert m["join_url"] == "https://meet.google.com/abc-defg-hij"
    assert m["attendees"] == ["a@acme.com"]


def test_update_created_meeting_edits_fields(db, org, user, monkeypatch):
    _connect_google_meet(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "post",
        lambda url, *a, **k: FakeResponse(200, {
            "id": "evt-1", "summary": "Old title",
            "hangoutLink": "https://meet.google.com/abc-defg-hij",
        }),
    )
    # Google Meet edits are pushed to Google Calendar (PATCH, sendUpdates=all),
    # which notifies attendees — the backend sends NO email here.
    patched = {}
    def fake_patch(url, *a, **k):
        patched["url"] = url
        patched["params"] = k.get("params")
        return FakeResponse(200, {"id": "evt-1"})
    monkeypatch.setattr(meeting_providers.httpx, "patch", fake_patch)
    router.create_google_meeting(
        payload=router.CreateMeetingIn(title="Old title", attendees=["a@acme.com"]),
        db=db, user=user,
    )
    created_id = router.list_created_meetings(db=db, user=user)["meetings"][0]["id"]
    out = router.update_created_meeting(
        created_id=created_id,
        payload=router.UpdateCreatedMeetingIn(
            title="New title", duration_minutes=45, attendees=["b@acme.com", "c@acme.com"]
        ),
        db=db, user=user,
    )
    assert out["title"] == "New title"
    assert out["duration_minutes"] == 45
    assert out["attendees"] == ["b@acme.com", "c@acme.com"]
    # Persisted: a fresh list reflects the edit.
    row = router.list_created_meetings(db=db, user=user)["meetings"][0]
    assert row["title"] == "New title"


def test_update_created_meeting_unknown_id_404(db, org, user):
    _connect_google_meet(db, org)
    with pytest.raises(HTTPException) as exc:
        router.update_created_meeting(
            created_id=99999,
            payload=router.UpdateCreatedMeetingIn(title="x"),
            db=db, user=user,
        )
    assert exc.value.status_code == 404


def test_created_meeting_hidden_when_provider_disconnected(db, org, user, monkeypatch):
    _connect_google_meet(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "post",
        lambda url, *a, **k: FakeResponse(200, {
            "id": "evt-1", "summary": "x",
            "hangoutLink": "https://meet.google.com/abc-defg-hij",
        }),
    )
    router.create_google_meeting(
        payload=router.CreateMeetingIn(title="x"), db=db, user=user
    )
    assert len(router.list_created_meetings(db=db, user=user)["meetings"]) == 1
    # Disconnect Google Meet — its created meetings must no longer show.
    oauth.disconnect(db, org, "google_meet")
    assert router.list_created_meetings(db=db, user=user)["meetings"] == []


def test_created_meetings_scoped_per_provider_connection(db, org, user, monkeypatch):
    _connect_google_meet(db, org)
    _connect_zoom(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "post",
        lambda url, *a, **k: FakeResponse(200, {
            "id": "z1", "topic": "Zoom call",
            "join_url": "https://zoom.us/j/1",
        }) if "zoom" in url else FakeResponse(200, {
            "id": "g1", "summary": "Meet call",
            "hangoutLink": "https://meet.google.com/aaa-bbbb-ccc",
        }),
    )
    router.create_google_meeting(payload=router.CreateMeetingIn(title="Meet call"), db=db, user=user)
    router.create_zoom_meeting(payload=router.CreateMeetingIn(title="Zoom call"), db=db, user=user)
    assert len(router.list_created_meetings(db=db, user=user)["meetings"]) == 2
    # Disconnecting only Zoom leaves the Meet one visible.
    oauth.disconnect(db, org, "zoom")
    rows = router.list_created_meetings(db=db, user=user)["meetings"]
    assert [r["provider"] for r in rows] == ["google_meet"]


# --- Zoom "Import Meetings" (metadata only) -------------------------------


def _zoom_meetings_get(host=None, previous=None, scheduled=None):
    """Build a fake httpx.get for the Zoom meeting-import flow. Routes the
    host lookup, the previous_meetings list, and the scheduled list by URL/params."""
    host = host or {"first_name": "Dana", "last_name": "Lee", "email": "dana@acme.com"}
    previous = previous if previous is not None else []
    scheduled = scheduled if scheduled is not None else []

    def fake_get(url, *a, **k):
        if url.endswith("/users/me/meetings"):
            mtype = (k.get("params") or {}).get("type")
            return FakeResponse(200, {"meetings": previous if mtype == "previous_meetings" else scheduled})
        if url.endswith("/users/me"):
            return FakeResponse(200, host)
        return FakeResponse(404, {"message": "not found"})

    return fake_get


def test_import_meetings_requires_connection(db, user):
    with pytest.raises(HTTPException) as exc:
        router.import_provider_meetings(provider="zoom", since_days=30, limit=50, db=db, user=user)
    assert exc.value.status_code == 400


def test_import_meetings_only_available_for_zoom(db, org, user):
    _connect_google_meet(db, org)
    with pytest.raises(HTTPException) as exc:
        router.import_provider_meetings(provider="google_meet", db=db, user=user)
    assert exc.value.status_code == 400
    assert "only available for zoom" in str(exc.value.detail).lower()


def test_import_meetings_persists_metadata_and_lists(db, org, user, monkeypatch):
    _connect_zoom(db, org)
    monkeypatch.setattr(meeting_providers.httpx, "get", _zoom_meetings_get(
        previous=[{"uuid": "u-1", "topic": "Past sync", "start_time": "2026-06-20T15:00:00Z", "duration": 45, "join_url": "https://zoom.us/j/1"}],
        scheduled=[{"uuid": "u-2", "topic": "Future sync", "start_time": "2026-07-01T10:00:00Z", "duration": 30, "join_url": "https://zoom.us/j/2"}],
    ))
    res = router.import_provider_meetings(provider="zoom", since_days=30, limit=50, db=db, user=user)
    assert res["imported"] == 2 and res["fetched"] == 2

    rows = router.list_provider_meetings(provider="zoom", db=db, user=user)["meetings"]
    assert {r["status"] for r in rows} == {"completed", "scheduled"}
    past = next(r for r in rows if r["external_id"] == "u-1")
    assert past["title"] == "Past sync"
    assert past["host_name"] == "Dana Lee" and past["host_email"] == "dana@acme.com"
    assert past["duration_minutes"] == 45
    # end_at is derived from start + duration (metadata only — no transcript).
    assert past["end_at"].startswith("2026-06-20T15:45:00")


def test_import_meetings_dedupes_and_updates_on_reimport(db, org, user, monkeypatch):
    _connect_zoom(db, org)
    monkeypatch.setattr(meeting_providers.httpx, "get", _zoom_meetings_get(
        previous=[{"uuid": "u-1", "topic": "Old title", "start_time": "2026-06-20T15:00:00Z", "duration": 30}],
    ))
    first = router.import_provider_meetings(provider="zoom", since_days=30, limit=50, db=db, user=user)
    assert first["imported"] == 1

    monkeypatch.setattr(meeting_providers.httpx, "get", _zoom_meetings_get(
        previous=[{"uuid": "u-1", "topic": "New title", "start_time": "2026-06-20T15:00:00Z", "duration": 60}],
    ))
    second = router.import_provider_meetings(provider="zoom", since_days=30, limit=50, db=db, user=user)
    assert second["imported"] == 0 and second["updated"] == 1

    rows = router.list_provider_meetings(provider="zoom", db=db, user=user)["meetings"]
    assert len(rows) == 1 and rows[0]["title"] == "New title" and rows[0]["duration_minutes"] == 60


def test_import_meetings_scope_error_returns_502(db, org, user, monkeypatch):
    _connect_zoom(db, org)

    def fake_get(url, *a, **k):
        if url.endswith("/users/me/meetings"):
            return FakeResponse(403, {"message": "Invalid access token, does not contain scopes:[meeting:read]"})
        return FakeResponse(200, {"first_name": "Dana", "email": "dana@acme.com"})

    monkeypatch.setattr(meeting_providers.httpx, "get", fake_get)
    with pytest.raises(HTTPException) as exc:
        router.import_provider_meetings(provider="zoom", since_days=30, limit=50, db=db, user=user)
    assert exc.value.status_code == 502
    assert "meeting:read" in str(exc.value.detail)


def test_import_meetings_empty_returns_zero(db, org, user, monkeypatch):
    _connect_zoom(db, org)
    monkeypatch.setattr(meeting_providers.httpx, "get", _zoom_meetings_get(previous=[], scheduled=[]))
    res = router.import_provider_meetings(provider="zoom", since_days=30, limit=50, db=db, user=user)
    assert res == {"imported": 0, "updated": 0, "fetched": 0}


def test_zoom_meetings_error_403_is_permanent():
    err = meeting_providers._zoom_meetings_error(
        Exception("boom"), FakeResponse(403, {"message": "missing scope"})
    )
    assert err.transient is False
    assert "meeting:read" in str(err)


def test_import_meetings_filters_completed_outside_window(db, org, user, monkeypatch):
    _connect_zoom(db, org)
    recent = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
    old = (datetime.now(timezone.utc) - timedelta(days=120)).strftime("%Y-%m-%dT%H:%M:%SZ")
    monkeypatch.setattr(meeting_providers.httpx, "get", _zoom_meetings_get(
        previous=[
            {"uuid": "recent", "topic": "Recent", "start_time": recent, "duration": 30},
            {"uuid": "old", "topic": "Old", "start_time": old, "duration": 30},
        ],
    ))
    res = router.import_provider_meetings(provider="zoom", since_days=30, limit=50, db=db, user=user)
    assert res["imported"] == 1
    rows = router.list_provider_meetings(provider="zoom", db=db, user=user)["meetings"]
    assert [r["external_id"] for r in rows] == ["recent"]


# --- provider-specific invitations (native vs backend email) --------------


def _connect_ms_teams(db, org) -> None:
    oauth._set_attr(org, "ms_teams", "access_token_enc", oauth.encrypt("access-token"))
    oauth._set_attr(org, "ms_teams", "token_expires_at", datetime.now(timezone.utc) + timedelta(hours=1))
    oauth._set_attr(org, "ms_teams", "needs_reconnect", False)
    db.commit()


def test_google_create_records_invites_without_backend_email(db, org, user, monkeypatch):
    """Google Calendar emails attendees via sendUpdates=all at create time, so
    the backend must NOT send its own invitation email."""
    _connect_google_meet(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "post",
        lambda url, *a, **k: FakeResponse(200, {
            "id": "evt-1", "summary": "Sync",
            "hangoutLink": "https://meet.google.com/abc-defg-hij",
        }),
    )
    sent = []
    monkeypatch.setattr(router, "_send_invites", lambda *a, **k: sent.append(a) or {"sent": 0, "error": None})
    out = router.create_google_meeting(
        payload=router.CreateMeetingIn(title="Sync", attendees=["a@acme.com", "b@acme.com"]),
        db=db, user=user,
    )
    assert out["invite"]["sent"] == 2
    assert out["attendee_count"] == 2
    assert sent == []  # backend never emailed — Google Calendar did


def test_teams_create_requires_connection(db, user):
    with pytest.raises(HTTPException) as exc:
        router.create_teams_meeting(payload=router.CreateMeetingIn(title="x"), db=db, user=user)
    assert exc.value.status_code == 400


def test_teams_create_returns_join_link_without_backend_email(db, org, user, monkeypatch):
    _connect_ms_teams(db, org)
    captured = {}

    def fake_post(url, *a, **k):
        captured["url"] = url
        captured["json"] = k.get("json")
        return FakeResponse(200, {
            "id": "ev-t1", "subject": "Sync",
            "onlineMeeting": {"joinUrl": "https://teams.microsoft.com/l/meetup/x"},
            "webLink": "https://outlook.office.com/x",
        })

    monkeypatch.setattr(meeting_providers.httpx, "post", fake_post)
    sent = []
    monkeypatch.setattr(router, "_send_invites", lambda *a, **k: sent.append(a) or {"sent": 0, "error": None})
    out = router.create_teams_meeting(
        payload=router.CreateMeetingIn(title="Sync", attendees=["a@acme.com"]),
        db=db, user=user,
    )
    assert out["provider"] == "ms_teams"
    assert out["join_url"] == "https://teams.microsoft.com/l/meetup/x"
    assert out["invite"]["sent"] == 1
    assert captured["url"].endswith("/me/events")
    assert captured["json"]["isOnlineMeeting"] is True
    assert captured["json"]["onlineMeetingProvider"] == "teamsForBusiness"
    assert sent == []  # Outlook emails attendees, not the backend


def test_teams_create_403_asks_to_reconnect(db, org, user, monkeypatch):
    _connect_ms_teams(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "post",
        lambda url, *a, **k: FakeResponse(403, {"error": "Forbidden"}),
    )
    with pytest.raises(HTTPException) as exc:
        router.create_teams_meeting(payload=router.CreateMeetingIn(title="x"), db=db, user=user)
    assert exc.value.status_code == 502
    assert "Calendars.ReadWrite" in exc.value.detail


def test_teams_invite_pushes_provider_not_backend_email(db, org, user, monkeypatch):
    _connect_ms_teams(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "post",
        lambda url, *a, **k: FakeResponse(200, {
            "id": "ev-t2", "subject": "x",
            "onlineMeeting": {"joinUrl": "https://teams.microsoft.com/l/x"},
        }),
    )
    patched = {}
    monkeypatch.setattr(
        meeting_providers.httpx, "patch",
        lambda url, *a, **k: patched.update(url=url, json=k.get("json")) or FakeResponse(200, {"id": "ev-t2"}),
    )
    sent = []
    monkeypatch.setattr(router, "_send_invites", lambda *a, **k: sent.append(a) or {"sent": 0, "error": None})
    created = router.create_teams_meeting(payload=router.CreateMeetingIn(title="x"), db=db, user=user)
    out = router.invite_participants(
        created_id=created["id"], payload=router.InviteIn(emails=["a@acme.com"]), db=db, user=user
    )
    assert out["invite"]["sent"] == 1
    assert out["attendee_count"] == 1
    assert patched.get("url", "").endswith("/me/events/ev-t2")  # provider re-notified
    assert sent == []  # no backend email for Teams


def test_teams_appears_in_connected_meetings_list(db, org, user, monkeypatch):
    _connect_ms_teams(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "post",
        lambda url, *a, **k: FakeResponse(200, {
            "id": "ev-t3", "subject": "x",
            "onlineMeeting": {"joinUrl": "https://teams.microsoft.com/l/x"},
        }),
    )
    router.create_teams_meeting(payload=router.CreateMeetingIn(title="x"), db=db, user=user)
    rows = router.list_created_meetings(db=db, user=user)["meetings"]
    assert len(rows) == 1 and rows[0]["provider"] == "ms_teams"
    # Disconnecting Teams hides its created meetings.
    oauth.disconnect(db, org, "ms_teams")
    assert router.list_created_meetings(db=db, user=user)["meetings"] == []


def test_native_subset_resend_renotifies_all(db, org, user, monkeypatch):
    """A SUBSET resend on a native provider (Teams) can't be honored — the calendar
    re-notifies EVERY attendee (sendUpdates=all / Outlook auto-send), so the router
    re-pushes the full list and reports sent == total invited, not the subset."""
    _connect_ms_teams(db, org)
    monkeypatch.setattr(
        meeting_providers.httpx, "post",
        lambda url, *a, **k: FakeResponse(200, {
            "id": "ev-t4", "subject": "x",
            "onlineMeeting": {"joinUrl": "https://teams.microsoft.com/l/x"},
        }),
    )
    patched = {}
    monkeypatch.setattr(
        meeting_providers.httpx, "patch",
        lambda url, *a, **k: patched.update(json=k.get("json")) or FakeResponse(200, {"id": "ev-t4"}),
    )
    sent = []
    monkeypatch.setattr(router, "_send_invites", lambda *a, **k: sent.append(a) or {"sent": 0, "error": None})
    created = router.create_teams_meeting(payload=router.CreateMeetingIn(title="x"), db=db, user=user)
    router.invite_participants(
        created_id=created["id"], payload=router.InviteIn(emails=["a@acme.com", "b@acme.com"]),
        db=db, user=user,
    )
    # Resend to just ONE of the two invited attendees.
    out = router.resend_invitations(
        created_id=created["id"], payload=router.ResendIn(emails=["a@acme.com"]), db=db, user=user
    )
    assert out["resend"]["sent"] == 2  # both re-notified, not the requested subset of 1
    pushed = {(a.get("emailAddress") or {}).get("address", "").lower()
              for a in (patched.get("json") or {}).get("attendees", [])}
    assert pushed == {"a@acme.com", "b@acme.com"}  # full list re-pushed to the calendar
    assert sent == []  # no backend email for Teams
