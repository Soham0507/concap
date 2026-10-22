"""Tests for get_valid_access_token: cache before expiry, refresh in buffer."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.services import hubspot_oauth as oauth
from app.services.crypto import encrypt

from tests.helpers import FakeResponse, make_post


def _boom_post(*args, **kwargs):
    raise AssertionError("token endpoint must not be called")


def test_returns_cached_token_before_expiry(db, org, monkeypatch):
    org.hubspot_access_token_enc = encrypt("cached-access-token")
    org.hubspot_refresh_token_enc = encrypt("refresh-token")
    # Comfortably beyond the 5-minute refresh buffer.
    org.hubspot_token_expires_at = datetime.now(timezone.utc) + timedelta(minutes=30)
    db.commit()

    # Any refresh attempt would hit the token endpoint — assert it doesn't.
    monkeypatch.setattr(oauth.httpx, "post", _boom_post)

    assert oauth.get_valid_access_token(db, org) == "cached-access-token"


def test_refreshes_within_buffer(db, org, monkeypatch):
    org.hubspot_access_token_enc = encrypt("stale-access-token")
    org.hubspot_refresh_token_enc = encrypt("refresh-token")
    # Inside the 5-minute buffer → must refresh even though not yet expired.
    org.hubspot_token_expires_at = datetime.now(timezone.utc) + timedelta(minutes=2)
    db.commit()

    monkeypatch.setattr(
        oauth.httpx,
        "post",
        make_post(response=FakeResponse(200, {
            "access_token": "refreshed-access-token",
            "refresh_token": "rotated-refresh-token",
            "expires_in": 1800,
        })),
    )

    assert oauth.get_valid_access_token(db, org) == "refreshed-access-token"


def test_refreshes_when_already_expired(db, org, monkeypatch):
    org.hubspot_access_token_enc = encrypt("expired-access-token")
    org.hubspot_refresh_token_enc = encrypt("refresh-token")
    org.hubspot_token_expires_at = datetime.now(timezone.utc) - timedelta(minutes=10)
    db.commit()

    monkeypatch.setattr(
        oauth.httpx,
        "post",
        make_post(response=FakeResponse(200, {
            "access_token": "new-token",
            "expires_in": 1800,
        })),
    )

    assert oauth.get_valid_access_token(db, org) == "new-token"


def test_raises_when_not_connected(db, org, monkeypatch):
    monkeypatch.setattr(oauth.httpx, "post", _boom_post)
    with pytest.raises(oauth.HubSpotOAuthError):
        oauth.get_valid_access_token(db, org)


def test_raises_when_needs_reconnect(db, org, monkeypatch):
    org.hubspot_access_token_enc = encrypt("tok")
    org.hubspot_needs_reconnect = True
    db.commit()
    monkeypatch.setattr(oauth.httpx, "post", _boom_post)
    with pytest.raises(oauth.HubSpotOAuthError):
        oauth.get_valid_access_token(db, org)
