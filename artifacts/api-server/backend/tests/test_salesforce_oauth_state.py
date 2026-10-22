"""Tests for the single-use, signed OAuth `state` (CSRF + replay protection)."""
from __future__ import annotations

import pytest

from app.services import salesforce_oauth as oauth

from tests.helpers import state_from_authorize_url


def test_verify_state_round_trip():
    state = oauth.make_state(org_id=7, user_id=3, nonce="nonce-abc")
    body = oauth.verify_state(state)
    assert body["org"] == 7
    assert body["uid"] == 3
    assert body["n"] == "nonce-abc"


def test_verify_state_rejects_tampered_signature():
    state = oauth.make_state(org_id=7, user_id=3, nonce="nonce-abc")
    raw, _sig = state.split(".")
    forged = f"{raw}.{'A' * 43}"
    with pytest.raises(oauth.SalesforceOAuthError):
        oauth.verify_state(forged)


def test_verify_state_rejects_tampered_payload():
    state = oauth.make_state(org_id=7, user_id=3, nonce="nonce-abc")
    _raw, sig = state.split(".")
    # Re-encode a payload claiming a different org but keep the old signature.
    forged_raw = oauth._b64url(b'{"org":999,"uid":3,"n":"nonce-abc","exp":9999999999}')
    with pytest.raises(oauth.SalesforceOAuthError):
        oauth.verify_state(f"{forged_raw}.{sig}")


def test_verify_state_rejects_malformed():
    with pytest.raises(oauth.SalesforceOAuthError):
        oauth.verify_state("no-dot-here")


def test_verify_state_rejects_expired(monkeypatch):
    state = oauth.make_state(org_id=1, user_id=1, nonce="n")
    # Jump past the TTL so the exp check fails.
    real_time = oauth.time.time()
    monkeypatch.setattr(oauth.time, "time", lambda: real_time + oauth._STATE_TTL_SECONDS + 1)
    with pytest.raises(oauth.SalesforceOAuthError):
        oauth.verify_state(state)


def test_consume_state_is_single_use(db, org):
    # authorize_url persists a fresh nonce on the org.
    url = oauth.authorize_url(db, org, user_id=42)
    state = state_from_authorize_url(url)
    payload = oauth.verify_state(state)
    assert org.salesforce_oauth_state  # nonce persisted

    # First consume succeeds and clears the nonce.
    oauth.consume_state(db, org, payload)
    assert org.salesforce_oauth_state is None

    # Replaying the very same (still validly signed) state must be rejected.
    with pytest.raises(oauth.SalesforceOAuthError):
        oauth.consume_state(db, org, payload)


def test_consume_state_rejects_mismatched_nonce(db, org):
    oauth.authorize_url(db, org, user_id=42)
    with pytest.raises(oauth.SalesforceOAuthError):
        oauth.consume_state(db, org, {"n": "some-other-nonce"})


def test_starting_again_invalidates_old_state(db, org):
    url1 = oauth.authorize_url(db, org, user_id=1)
    payload1 = oauth.verify_state(state_from_authorize_url(url1))

    # Starting a second connection overwrites the stored nonce.
    oauth.authorize_url(db, org, user_id=1)

    # The first (now-stale) state can no longer be consumed.
    with pytest.raises(oauth.SalesforceOAuthError):
        oauth.consume_state(db, org, payload1)
