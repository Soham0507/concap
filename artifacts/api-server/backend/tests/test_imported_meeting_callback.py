"""End-to-end tests for the Imported Meetings provider OAuth callback: a
successful callback connects the org and redirects back to /imported-meetings;
a replayed/tampered `state` must produce an error redirect, never a connection.
"""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from app.routers import imported_meetings as router
from app.services import meeting_oauth as oauth

from tests.helpers import FakeResponse, state_from_authorize_url


def _redirect_params(resp) -> dict:
    return parse_qs(urlparse(resp.headers["location"]).query)


@pytest.fixture
def mock_provider_http(monkeypatch):
    """Make the code-exchange (POST) succeed and the account-label lookup (GET)
    return an email — both offline."""
    monkeypatch.setattr(
        oauth.httpx, "post",
        lambda url, *a, **k: FakeResponse(200, {
            "access_token": "access-token",
            "refresh_token": "refresh-token",
            "expires_in": 3600,
        }),
    )
    monkeypatch.setattr(
        oauth.httpx, "get",
        lambda url, *a, **k: FakeResponse(200, {"email": "user@example.com"}),
    )


@pytest.fixture(autouse=True)
def configure_provider(settings):
    """Provider OAuth must look configured (client id/secret + base url)."""
    object.__setattr__(settings, "zoom_client_id", "zoom-id")
    object.__setattr__(settings, "zoom_client_secret", "zoom-secret")
    object.__setattr__(settings, "public_base_url", "https://app.example.com")


def test_callback_connects_then_rejects_replay(db, org, mock_provider_http):
    url = oauth.authorize_url(db, org, user_id=5, provider="zoom")
    state = state_from_authorize_url(url)

    resp1 = router.provider_oauth_callback(
        provider="zoom", db=db, code="auth-code", state=state, error=None
    )
    assert resp1.status_code == 302
    assert resp1.headers["location"].startswith("/imported-meetings")
    assert _redirect_params(resp1).get("meeting") == ["connected"]
    db.refresh(org)
    assert org.zoom_access_token_enc is not None
    assert org.zoom_account_label == "user@example.com"
    assert org.zoom_oauth_state is None  # nonce consumed

    # Replaying the same state must NOT reconnect — error redirect instead.
    resp2 = router.provider_oauth_callback(
        provider="zoom", db=db, code="auth-code", state=state, error=None
    )
    assert resp2.status_code == 302
    assert "meeting_error" in _redirect_params(resp2)


def test_callback_rejects_provider_mismatch(db, org, mock_provider_http):
    # State minted for zoom must not be accepted on the google_meet callback.
    url = oauth.authorize_url(db, org, user_id=5, provider="zoom")
    state = state_from_authorize_url(url)
    resp = router.provider_oauth_callback(
        provider="google_meet", db=db, code="auth-code", state=state, error=None
    )
    assert resp.status_code == 302
    assert "meeting_error" in _redirect_params(resp)
    db.refresh(org)
    assert org.zoom_access_token_enc is None
