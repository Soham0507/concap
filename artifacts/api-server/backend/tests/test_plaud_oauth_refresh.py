"""Plaud token-refresh failures classified transient vs permanent (per-user).

Mirrors the HubSpot refresh tests: only a definitive 4xx may flip a user to
needs_reconnect; a network blip / 5xx / 429 leaves them connected to retry.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.services import plaud_oauth as oauth
from app.services.crypto import encrypt

from tests.helpers import FakeResponse, make_post


def _connect_user(db, user, *, expires_in_minutes: int = -1):
    user.plaud_access_token_enc = encrypt("old-access-token")
    user.plaud_refresh_token_enc = encrypt("the-refresh-token")
    user.plaud_token_expires_at = datetime.now(timezone.utc) + timedelta(minutes=expires_in_minutes)
    user.plaud_needs_reconnect = False
    user.plaud_client_id = "test-plaud-client-id"
    user.plaud_client_secret_enc = encrypt("test-plaud-client-secret")
    db.commit()


@pytest.mark.parametrize(
    "fake",
    [
        pytest.param(("exc", httpx.ConnectError("boom")), id="network-error"),
        pytest.param(("resp", FakeResponse(500, {"error": "server_error"})), id="http-500"),
        pytest.param(("resp", FakeResponse(429, {"error": "rate_limited"})), id="http-429"),
    ],
)
def test_transient_refresh_failure_does_not_flip_reconnect(db, user, monkeypatch, fake):
    _connect_user(db, user)
    kind, value = fake
    if kind == "exc":
        monkeypatch.setattr(oauth.httpx, "post", make_post(exc=value))
    else:
        monkeypatch.setattr(oauth.httpx, "post", make_post(response=value))

    with pytest.raises(oauth.PlaudOAuthError) as exc_info:
        oauth._refresh(db, user)

    assert exc_info.value.transient is True
    db.refresh(user)
    assert user.plaud_needs_reconnect is False


@pytest.mark.parametrize("status", [400, 401, 403])
def test_permanent_refresh_failure_flips_reconnect(db, user, monkeypatch, status):
    _connect_user(db, user)
    monkeypatch.setattr(
        oauth.httpx, "post",
        make_post(response=FakeResponse(status, {"error": "invalid_grant"})),
    )
    with pytest.raises(oauth.PlaudOAuthError) as exc_info:
        oauth._refresh(db, user)

    assert exc_info.value.transient is False
    db.refresh(user)
    assert user.plaud_needs_reconnect is True


def test_successful_refresh_persists_new_token(db, user, monkeypatch):
    _connect_user(db, user)
    recorder: list = []
    monkeypatch.setattr(
        oauth.httpx, "post",
        make_post(
            response=FakeResponse(200, {
                "access_token": "fresh-access-token",
                "refresh_token": "fresh-refresh-token",
                "expires_in": 3600,
            }),
            recorder=recorder,
        ),
    )
    token = oauth._refresh(db, user)

    assert token == "fresh-access-token"
    sent = recorder[0]["data"]
    assert sent["grant_type"] == "refresh_token"
    assert sent["refresh_token"] == "the-refresh-token"
    assert sent["client_id"] == "test-plaud-client-id"
    db.refresh(user)
    assert user.plaud_needs_reconnect is False
    assert user.plaud_access_token_enc != "fresh-access-token"


def test_refresh_without_refresh_token_flips_reconnect(db, user):
    user.plaud_access_token_enc = encrypt("old-access-token")
    user.plaud_refresh_token_enc = None
    db.commit()
    with pytest.raises(oauth.PlaudOAuthError):
        oauth._refresh(db, user)
    db.refresh(user)
    assert user.plaud_needs_reconnect is True
