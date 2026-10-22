"""End-to-end tests for the OAuth callback: a replayed/tampered `state` must
produce an error redirect, never a connection."""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from app.routers import hubspot as router
from app.services import hubspot_oauth as oauth

from tests.helpers import FakeResponse, make_post, state_from_authorize_url


def _redirect_params(resp) -> dict:
    location = resp.headers["location"]
    return parse_qs(urlparse(location).query)


@pytest.fixture
def mock_token_endpoint(monkeypatch):
    """Make the code-exchange succeed and skip the portal-info network call."""
    monkeypatch.setattr(
        oauth.httpx,
        "post",
        make_post(response=FakeResponse(200, {
            "access_token": "access-token",
            "refresh_token": "refresh-token",
            "expires_in": 1800,
        })),
    )
    # complete_connection best-effort fetches portal info; keep it offline.
    import app.services.hubspot as hs
    monkeypatch.setattr(hs, "get_account_info", lambda: {"portal_id": "98765"})


def test_callback_connects_then_rejects_replay(db, org, mock_token_endpoint):
    url = oauth.authorize_url(db, org, user_id=5)
    state = state_from_authorize_url(url)

    # First callback connects the org.
    resp1 = router.hubspot_oauth_callback(db=db, code="auth-code", state=state, error=None)
    assert resp1.status_code == 302
    assert "hubspot=connected" in resp1.headers["location"]
    db.refresh(org)
    assert org.hubspot_access_token_enc is not None
    assert org.hubspot_oauth_state is None  # nonce consumed

    # Replaying the same state must NOT reconnect — error redirect instead.
    resp2 = router.hubspot_oauth_callback(db=db, code="auth-code", state=state, error=None)
    assert resp2.status_code == 302
    assert "hubspot_error" in _redirect_params(resp2)


def test_callback_rejects_tampered_state(db, org, mock_token_endpoint):
    url = oauth.authorize_url(db, org, user_id=5)
    state = state_from_authorize_url(url)
    raw, _sig = state.split(".")
    forged = f"{raw}.{'A' * 43}"

    resp = router.hubspot_oauth_callback(db=db, code="auth-code", state=forged, error=None)
    assert resp.status_code == 302
    assert "hubspot_error" in _redirect_params(resp)
    db.refresh(org)
    assert org.hubspot_access_token_enc is None  # never connected


def test_callback_with_provider_error_redirects(db, org):
    resp = router.hubspot_oauth_callback(db=db, code=None, state=None, error="access_denied")
    assert resp.status_code == 302
    assert "hubspot_error" in _redirect_params(resp)


def test_callback_missing_code_redirects(db, org):
    url = oauth.authorize_url(db, org, user_id=5)
    state = state_from_authorize_url(url)
    resp = router.hubspot_oauth_callback(db=db, code=None, state=state, error=None)
    assert resp.status_code == 302
    assert "hubspot_error" in _redirect_params(resp)
