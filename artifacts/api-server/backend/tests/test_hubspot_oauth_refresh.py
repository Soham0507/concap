"""Tests that token-refresh failures are classified transient vs permanent.

Only a definitive 4xx (invalid_grant) may flip an org to needs_reconnect; a
network blip / 5xx / 429 must leave the org connected so the next sync retries.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.services import hubspot_oauth as oauth
from app.services.crypto import encrypt

from tests.helpers import FakeResponse, make_post


def _connect_org(db, org, *, expires_in_minutes: int = -1):
    """Give the org encrypted tokens with an (by default already-expired)
    access token so get_valid_access_token / _refresh take the refresh path."""
    org.hubspot_access_token_enc = encrypt("old-access-token")
    org.hubspot_refresh_token_enc = encrypt("the-refresh-token")
    org.hubspot_token_expires_at = datetime.now(timezone.utc) + timedelta(minutes=expires_in_minutes)
    org.hubspot_needs_reconnect = False
    db.commit()


@pytest.mark.parametrize(
    "fake",
    [
        pytest.param(("exc", httpx.ConnectError("boom")), id="network-error"),
        pytest.param(("resp", FakeResponse(500, {"message": "server error"})), id="http-500"),
        pytest.param(("resp", FakeResponse(502, {"message": "bad gateway"})), id="http-502"),
        pytest.param(("resp", FakeResponse(429, {"message": "rate limited"})), id="http-429"),
    ],
)
def test_transient_refresh_failure_does_not_flip_reconnect(db, org, monkeypatch, fake):
    _connect_org(db, org)
    kind, value = fake
    if kind == "exc":
        monkeypatch.setattr(oauth.httpx, "post", make_post(exc=value))
    else:
        monkeypatch.setattr(oauth.httpx, "post", make_post(response=value))

    with pytest.raises(oauth.HubSpotOAuthError) as exc_info:
        oauth._refresh(db, org)

    assert exc_info.value.transient is True
    db.refresh(org)
    assert org.hubspot_needs_reconnect is False


@pytest.mark.parametrize("status", [400, 401, 403])
def test_permanent_refresh_failure_flips_reconnect(db, org, monkeypatch, status):
    _connect_org(db, org)
    monkeypatch.setattr(
        oauth.httpx,
        "post",
        make_post(response=FakeResponse(status, {"error": "invalid_grant"})),
    )

    with pytest.raises(oauth.HubSpotOAuthError) as exc_info:
        oauth._refresh(db, org)

    assert exc_info.value.transient is False
    db.refresh(org)
    assert org.hubspot_needs_reconnect is True


def test_successful_refresh_persists_new_token(db, org, monkeypatch):
    _connect_org(db, org)
    recorder: list = []
    monkeypatch.setattr(
        oauth.httpx,
        "post",
        make_post(
            response=FakeResponse(200, {
                "access_token": "fresh-access-token",
                "refresh_token": "fresh-refresh-token",
                "expires_in": 1800,
            }),
            recorder=recorder,
        ),
    )

    token = oauth._refresh(db, org)

    assert token == "fresh-access-token"
    # The grant_type sent must be a refresh, carrying the stored refresh token.
    sent = recorder[0]["data"]
    assert sent["grant_type"] == "refresh_token"
    assert sent["refresh_token"] == "the-refresh-token"
    db.refresh(org)
    assert org.hubspot_needs_reconnect is False
    # Stored token is re-encrypted (not stored in plaintext).
    assert org.hubspot_access_token_enc != "fresh-access-token"


def test_refresh_without_refresh_token_flips_reconnect(db, org):
    org.hubspot_access_token_enc = encrypt("old-access-token")
    org.hubspot_refresh_token_enc = None
    db.commit()

    with pytest.raises(oauth.HubSpotOAuthError):
        oauth._refresh(db, org)
    db.refresh(org)
    assert org.hubspot_needs_reconnect is True
