"""Plaud OAuth callback: a replayed/tampered `state` must error, never connect."""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from app.routers import plaud as router
from app.services import plaud_oauth as oauth

from tests.helpers import FakeResponse, make_post, state_from_authorize_url


def _redirect_params(resp) -> dict:
    return parse_qs(urlparse(resp.headers["location"]).query)


@pytest.fixture
def mock_token_endpoint(monkeypatch):
    """Make the code-exchange succeed and skip the account-info MCP call."""
    monkeypatch.setattr(
        oauth.httpx, "post",
        make_post(response=FakeResponse(200, {
            "access_token": "access-token",
            "refresh_token": "refresh-token",
            "expires_in": 3600,
        })),
    )
    import app.services.plaud_mcp as mcp
    monkeypatch.setattr(mcp, "get_current_user", lambda token: {"email": "me@plaud.ai", "name": "Me"})


def test_callback_connects_then_rejects_replay(db, user, mock_token_endpoint):
    url = oauth.authorize_url(db, user)
    state = state_from_authorize_url(url)

    resp1 = router.plaud_oauth_callback(db=db, code="auth-code", state=state, error=None)
    assert resp1.status_code == 302
    assert "plaud=connected" in resp1.headers["location"]
    db.refresh(user)
    assert user.plaud_access_token_enc is not None
    assert user.plaud_account_email == "me@plaud.ai"
    assert user.plaud_oauth_state is None  # nonce consumed
    assert user.plaud_code_verifier is None  # PKCE verifier consumed

    resp2 = router.plaud_oauth_callback(db=db, code="auth-code", state=state, error=None)
    assert resp2.status_code == 302
    assert "plaud_error" in _redirect_params(resp2)


def test_callback_rejects_tampered_state(db, user, mock_token_endpoint):
    url = oauth.authorize_url(db, user)
    state = state_from_authorize_url(url)
    raw, _sig = state.split(".")
    forged = f"{raw}.{'A' * 43}"

    resp = router.plaud_oauth_callback(db=db, code="auth-code", state=forged, error=None)
    assert resp.status_code == 302
    assert "plaud_error" in _redirect_params(resp)
    db.refresh(user)
    assert user.plaud_access_token_enc is None


def test_callback_with_provider_error_redirects(db, user):
    resp = router.plaud_oauth_callback(db=db, code=None, state=None, error="access_denied")
    assert resp.status_code == 302
    assert "plaud_error" in _redirect_params(resp)
