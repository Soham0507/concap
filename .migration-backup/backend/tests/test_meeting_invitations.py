"""Tests for meeting-management: invitations, resend, status, serialization and
the provider-independent backend email path.

Invitations are sent from the application's OWN backend email account over SMTP
(NOT the organizer's connected Google/Zoom account), so these tests stub the
SMTP transport rather than the Gmail API. We assert that invitations are
recorded only when the email actually sends, that a transport failure surfaces a
provider-independent error and persists nothing, that a missing email config is
reported clearly, that an RFC-5545 .ics invite is attached, and that status is
derived correctly from the schedule.
"""
from __future__ import annotations

import smtplib
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import CreatedMeeting
from app.routers import imported_meetings as router
from app.services import email_sender
from app.services import meeting_oauth as oauth


def _connect_google_meet(db, org, label="organizer@acme.com") -> None:
    oauth._set_attr(org, "google_meet", "access_token_enc", oauth.encrypt("access-token"))
    oauth._set_attr(org, "google_meet", "token_expires_at", datetime.now(timezone.utc) + timedelta(hours=1))
    oauth._set_attr(org, "google_meet", "needs_reconnect", False)
    oauth._set_attr(org, "google_meet", "account_label", label)
    db.commit()


def _make_meeting(db, org, user, **kw) -> CreatedMeeting:
    row = CreatedMeeting(
        org_id=org.id,
        created_by_user_id=user.id,
        provider=kw.get("provider", "zoom"),
        external_id=kw.get("external_id", "987"),
        title=kw.get("title", "Acme intro"),
        join_url=kw.get("join_url", "https://zoom.us/j/987"),
        start_at=kw.get("start_at"),
        duration_minutes=kw.get("duration_minutes", 30),
        passcode=kw.get("passcode"),
        attendees=[],
        invitations=[],
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


class _Cfg:
    """A configured, deterministic SMTP settings stub (no .env interference)."""

    smtp_host = "smtp.test"
    smtp_port = 587
    smtp_username = ""
    smtp_password = ""
    smtp_use_tls = False
    smtp_use_ssl = False
    smtp_from_email = "invites@concap.ai"
    smtp_from_name = "Concap AI"

    def email_configured(self) -> bool:
        return True

    def resolved_from_email(self) -> str:
        return self.smtp_from_email


class _FakeSMTP:
    """Records every sendmail call into the shared recorder list."""

    recorder: list = []
    fail: bool = False

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
        if _FakeSMTP.fail:
            raise smtplib.SMTPException("boom")
        _FakeSMTP.recorder.append({"from": from_addr, "to": to_addrs, "raw": msg})


def _smtp_ok(monkeypatch, *, fail: bool = False) -> list:
    """Configure SMTP and stub the transport. Returns the sendmail recorder."""
    _FakeSMTP.recorder = []
    _FakeSMTP.fail = fail
    monkeypatch.setattr(email_sender, "get_settings", lambda: _Cfg())
    monkeypatch.setattr(email_sender.smtplib, "SMTP", _FakeSMTP)
    return _FakeSMTP.recorder


# --- status / can_join / serialize ----------------------------------------


def test_status_scheduled_ongoing_completed(db, org, user):
    now = datetime.now(timezone.utc)
    future = _make_meeting(db, org, user, start_at=now + timedelta(hours=1))
    ongoing = _make_meeting(db, org, user, start_at=now - timedelta(minutes=5), duration_minutes=30)
    past = _make_meeting(db, org, user, start_at=now - timedelta(hours=2), duration_minutes=30)
    assert router._created_status(future) == "Scheduled"
    assert router._created_status(ongoing) == "Ongoing"
    assert router._created_status(past) == "Completed"


def test_serialize_exposes_management_fields(db, org, user):
    row = _make_meeting(db, org, user, start_at=datetime.now(timezone.utc) + timedelta(hours=1),
                        passcode="pass123")
    row.invitations = [{"email": "a@x.com", "status": "invited", "invited_at": "t", "last_sent_at": "t"}]
    db.commit()
    data = router._serialize_created_meeting(row, db)
    assert data["status"] == "Scheduled"
    assert data["passcode"] == "pass123"
    assert data["meeting_id"] == "987"
    assert data["attendee_count"] == 1
    assert data["organizer_name"] == user.email
    assert data["can_join"] is False  # an hour out


def test_can_join_true_near_start(db, org, user):
    row = _make_meeting(db, org, user, start_at=datetime.now(timezone.utc) + timedelta(minutes=2))
    assert router._can_join(row) is True


# --- invite ---------------------------------------------------------------


def test_invite_sends_and_records(db, org, user, monkeypatch):
    rec = _smtp_ok(monkeypatch)
    row = _make_meeting(db, org, user, passcode="zz",
                        start_at=datetime.now(timezone.utc) + timedelta(hours=1))
    out = router.invite_participants(
        created_id=row.id,
        payload=router.InviteIn(emails=["alex@acme.com", "JORDAN@acme.com"]),
        db=db, user=user,
    )
    assert out["invite"]["sent"] == 2
    assert len(rec) == 1  # single email with both recipients
    assert set(rec[0]["to"]) == {"alex@acme.com", "JORDAN@acme.com"}
    assert out["attendee_count"] == 2
    emails = {i["email"] for i in out["invitations"]}
    assert emails == {"alex@acme.com", "JORDAN@acme.com"}
    assert all(i["status"] == "invited" and i["last_sent_at"] for i in out["invitations"])


def test_invite_attaches_ics_calendar(db, org, user, monkeypatch):
    rec = _smtp_ok(monkeypatch)
    row = _make_meeting(db, org, user, start_at=datetime.now(timezone.utc) + timedelta(hours=2))
    router.invite_participants(created_id=row.id, payload=router.InviteIn(emails=["a@x.com"]), db=db, user=user)
    raw = rec[0]["raw"]
    assert "text/calendar" in raw
    assert 'method="REQUEST"' in raw or "method=REQUEST" in raw
    assert "invite.ics" in raw


def test_invite_dedupes(db, org, user, monkeypatch):
    _smtp_ok(monkeypatch)
    row = _make_meeting(db, org, user)
    router.invite_participants(created_id=row.id, payload=router.InviteIn(emails=["a@x.com"]), db=db, user=user)
    out = router.invite_participants(created_id=row.id, payload=router.InviteIn(emails=["A@x.com"]), db=db, user=user)
    assert out["attendee_count"] == 1


def test_invite_rejects_empty(db, org, user, monkeypatch):
    _smtp_ok(monkeypatch)
    row = _make_meeting(db, org, user)
    with pytest.raises(HTTPException) as exc:
        router.invite_participants(created_id=row.id, payload=router.InviteIn(emails=["nope"]), db=db, user=user)
    assert exc.value.status_code == 400


def test_invite_send_failure_persists_nothing(db, org, user, monkeypatch):
    """A transport failure surfaces a provider-independent 502 and records
    nothing — the invitation truth only reflects emails that actually sent."""
    _smtp_ok(monkeypatch, fail=True)
    row = _make_meeting(db, org, user)
    with pytest.raises(HTTPException) as exc:
        router.invite_participants(created_id=row.id, payload=router.InviteIn(emails=["a@x.com"]), db=db, user=user)
    assert exc.value.status_code == 502
    assert "invitation email failed" in exc.value.detail.lower()
    db.refresh(row)
    assert (row.invitations or []) == []


def test_invite_unconfigured_email_clear_error(db, org, user, monkeypatch):
    """With no SMTP configured the error is a clear, non-provider-specific
    'email isn't configured' message — never 'reconnect Google'."""
    class _Unconfigured:
        def email_configured(self):
            return False

    monkeypatch.setattr(email_sender, "get_settings", lambda: _Unconfigured())
    row = _make_meeting(db, org, user)
    with pytest.raises(HTTPException) as exc:
        router.invite_participants(created_id=row.id, payload=router.InviteIn(emails=["a@x.com"]), db=db, user=user)
    assert exc.value.status_code == 502
    assert "configured" in exc.value.detail.lower()
    assert "google" not in exc.value.detail.lower()


def test_create_failed_invite_shows_no_participants(db, org, user, monkeypatch):
    """If the auto-invite email fails on create, the meeting is still created but
    no participants are claimed (attendee_count derives from invitations only).
    Only Zoom uses the backend email path — Google/Teams invite natively."""
    oauth._set_attr(org, "zoom", "access_token_enc", oauth.encrypt("access-token"))
    oauth._set_attr(org, "zoom", "token_expires_at", datetime.now(timezone.utc) + timedelta(hours=1))
    oauth._set_attr(org, "zoom", "needs_reconnect", False)
    db.commit()
    _smtp_ok(monkeypatch, fail=True)  # email transport down

    class FakeResponseZoom:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {"id": 987, "topic": "x", "join_url": "https://zoom.us/j/987", "duration": 30}

    monkeypatch.setattr(router.meeting_providers.httpx, "post", lambda url, *a, **k: FakeResponseZoom())
    out = router.create_zoom_meeting(
        payload=router.CreateMeetingIn(title="x", attendees=["a@acme.com"]),
        db=db, user=user,
    )
    assert out["invite"]["error"]  # send failed
    assert out["attendee_count"] == 0
    assert out["invitations"] == []


def test_invite_tenancy_404(db, org, user, monkeypatch):
    _smtp_ok(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        router.invite_participants(created_id=99999, payload=router.InviteIn(emails=["a@x.com"]), db=db, user=user)
    assert exc.value.status_code == 404


# --- resend ---------------------------------------------------------------


def test_resend_all_updates_timestamp(db, org, user, monkeypatch):
    _smtp_ok(monkeypatch)
    row = _make_meeting(db, org, user)
    router.invite_participants(created_id=row.id, payload=router.InviteIn(emails=["a@x.com", "b@x.com"]), db=db, user=user)
    out = router.resend_invitations(created_id=row.id, payload=router.ResendIn(), db=db, user=user)
    assert out["resend"]["sent"] == 2


def test_resend_subset(db, org, user, monkeypatch):
    rec = _smtp_ok(monkeypatch)
    row = _make_meeting(db, org, user)
    router.invite_participants(created_id=row.id, payload=router.InviteIn(emails=["a@x.com", "b@x.com"]), db=db, user=user)
    rec.clear()
    out = router.resend_invitations(created_id=row.id, payload=router.ResendIn(emails=["a@x.com"]), db=db, user=user)
    assert out["resend"]["sent"] == 1
    assert len(rec) == 1


def test_resend_no_invites(db, org, user, monkeypatch):
    _smtp_ok(monkeypatch)
    row = _make_meeting(db, org, user)
    with pytest.raises(HTTPException) as exc:
        router.resend_invitations(created_id=row.id, payload=router.ResendIn(), db=db, user=user)
    assert exc.value.status_code == 400


# --- edit notify ----------------------------------------------------------


def test_edit_notifies_invited_on_schedule_change(db, org, user, monkeypatch):
    rec = _smtp_ok(monkeypatch)
    # The Zoom schedule is pushed to Zoom's API; Zoom does not email attendees,
    # so the backend still sends the 'updated' email itself.
    monkeypatch.setattr(router.meeting_providers, "update_zoom_meeting", lambda *a, **k: None)
    row = _make_meeting(db, org, user, start_at=datetime.now(timezone.utc) + timedelta(hours=1))
    router.invite_participants(created_id=row.id, payload=router.InviteIn(emails=["a@x.com"]), db=db, user=user)
    rec.clear()
    out = router.update_created_meeting(
        created_id=row.id,
        payload=router.UpdateCreatedMeetingIn(title="New title"),
        db=db, user=user,
    )
    assert out["notify"]["sent"] == 1
    assert len(rec) == 1


def test_edit_no_notify_when_no_invites(db, org, user, monkeypatch):
    _smtp_ok(monkeypatch)
    monkeypatch.setattr(router.meeting_providers, "update_zoom_meeting", lambda *a, **k: None)
    row = _make_meeting(db, org, user)
    out = router.update_created_meeting(
        created_id=row.id, payload=router.UpdateCreatedMeetingIn(title="Renamed"), db=db, user=user
    )
    assert out["notify"]["sent"] == 0


def test_zoom_edit_added_attendee_not_persisted_when_email_fails(db, org, user, monkeypatch):
    """Adding a Zoom attendee whose invitation email fails must NOT record a
    phantom participant — the edit raises 502 and persists no new invitee."""
    monkeypatch.setattr(router.meeting_providers, "update_zoom_meeting", lambda *a, **k: None)
    row = _make_meeting(db, org, user)
    # First, successfully invite one attendee.
    _smtp_ok(monkeypatch)
    router.invite_participants(created_id=row.id, payload=router.InviteIn(emails=["a@x.com"]), db=db, user=user)
    # Now the transport goes down; adding b@x.com via edit must fail cleanly.
    _smtp_ok(monkeypatch, fail=True)
    with pytest.raises(HTTPException) as exc:
        router.update_created_meeting(
            created_id=row.id,
            payload=router.UpdateCreatedMeetingIn(attendees=["a@x.com", "b@x.com"]),
            db=db, user=user,
        )
    assert exc.value.status_code == 502
    db.refresh(row)
    emails = [i["email"] for i in (row.invitations or [])]
    assert emails == ["a@x.com"]  # b@x.com never recorded


# --- email builder --------------------------------------------------------


def test_build_invitation_email_includes_details():
    subject, html, text = email_sender.build_invitation_email(
        title="Acme intro",
        when=datetime(2026, 6, 30, 15, 0, tzinfo=timezone.utc),
        duration_minutes=30,
        join_url="https://zoom.us/j/1",
        meeting_id="123",
        passcode="secret",
        organizer="Pat",
        kind="invite",
        platform="Zoom",
        company_name="Acme Corp",
        primary_color="#ff0000",
    )
    assert subject == "Invitation: Acme intro"
    assert "https://zoom.us/j/1" in html and "https://zoom.us/j/1" in text
    assert "123" in html and "secret" in html and "Pat" in html
    assert "Join Meeting" in html
    assert "Zoom" in html and "Acme Corp" in html


def test_build_update_email_subject():
    subject, _html, _text = email_sender.build_invitation_email(
        title="Acme", when=None, duration_minutes=None, join_url=None,
        meeting_id=None, passcode=None, organizer=None, kind="update",
    )
    assert subject == "Updated: Acme"


def test_build_ics_is_valid_rfc5545():
    ics = email_sender.build_ics(
        uid="concap-created-1@concap.ai",
        title="Acme intro; demo, part 2",
        start=datetime(2026, 6, 30, 15, 0, tzinfo=timezone.utc),
        duration_minutes=45,
        join_url="https://zoom.us/j/1",
        organizer_email="pat@acme.com",
        organizer_name="Pat",
        attendees=["a@x.com", "b@x.com"],
    )
    assert ics.startswith("BEGIN:VCALENDAR")
    assert "END:VCALENDAR" in ics
    assert "VERSION:2.0" in ics
    assert "METHOD:REQUEST" in ics
    assert "DTSTART:20260630T150000Z" in ics
    assert "DTEND:20260630T154500Z" in ics
    # Commas and semicolons in TEXT values are escaped.
    assert "SUMMARY:Acme intro\\; demo\\, part 2" in ics
    assert "ORGANIZER;CN=Pat:mailto:pat@acme.com" in ics
    assert ics.count("ATTENDEE") == 2
    # Lines are CRLF-terminated per spec.
    assert "\r\n" in ics


def test_send_invitation_requires_config(monkeypatch):
    class _Unconfigured:
        def email_configured(self):
            return False

    monkeypatch.setattr(email_sender, "get_settings", lambda: _Unconfigured())
    with pytest.raises(email_sender.EmailNotConfigured):
        email_sender.send_invitation(to=["a@x.com"], subject="s", html="h", text="t")
