"""Signed single-use OAuth state for the per-user Plaud connection."""
from __future__ import annotations

import time

import pytest

from app.services import plaud_oauth as oauth


def test_verify_state_round_trip():
    state = oauth.make_state(user_id=3, nonce="nonce-abc")
    body = oauth.verify_state(state)
    assert body["uid"] == 3
    assert body["n"] == "nonce-abc"


def test_verify_state_rejects_tampered_signature():
    state = oauth.make_state(user_id=3, nonce="nonce-abc")
    raw, _sig = state.split(".")
    with pytest.raises(oauth.PlaudOAuthError):
        oauth.verify_state(f"{raw}.{'A' * 43}")


def test_verify_state_rejects_malformed():
    with pytest.raises(oauth.PlaudOAuthError):
        oauth.verify_state("not-a-valid-state")


def test_verify_state_rejects_expired(monkeypatch):
    state = oauth.make_state(user_id=3, nonce="nonce-abc")
    # Jump well past the TTL so the embedded exp is in the past. Capture the
    # real now first so the lambda doesn't recurse into the patched time.
    future = time.time() + oauth._STATE_TTL_SECONDS + 10
    monkeypatch.setattr(oauth.time, "time", lambda: future)
    with pytest.raises(oauth.PlaudOAuthError):
        oauth.verify_state(state)


def test_authorize_url_persists_nonce_and_pkce(db, user):
    url = oauth.authorize_url(db, user)
    db.refresh(user)
    assert user.plaud_oauth_state is not None
    assert user.plaud_code_verifier is not None
    assert "code_challenge=" in url
    assert "code_challenge_method=S256" in url
    assert "client_id=test-plaud-client-id" in url


def test_consume_state_is_single_use(db, user):
    oauth.authorize_url(db, user)
    db.refresh(user)
    nonce = user.plaud_oauth_state
    oauth.consume_state(db, user, {"n": nonce})
    db.refresh(user)
    assert user.plaud_oauth_state is None
    # Replaying the same nonce now fails.
    with pytest.raises(oauth.PlaudOAuthError):
        oauth.consume_state(db, user, {"n": nonce})
