"""Google Sign-In (login/signup) — a stateless, user-less OAuth flow distinct
from the per-org Meet integration in ``meeting_oauth.py``. There is no user
or organization yet when the round-trip starts (it may *be* a signup), so the
CSRF state here is a self-contained signed+expiring token rather than one
matched against a value persisted on an Organization row. No tokens are
stored at rest — we exchange the code once for the caller's verified
email/name and discard everything else.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from urllib.parse import urlencode

import httpx

from ..config import get_settings

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
CALLBACK_PATH = "/api/auth/google/callback"
SCOPES = ["openid", "email", "profile"]

_STATE_TTL_SECONDS = 600
_HTTP_TIMEOUT = httpx.Timeout(20.0, connect=10.0)


class GoogleLoginError(Exception):
    """User-surfaced sign-in problem — rendered on the login page."""


# --------------------------------------------------------------------------- #
# Signed, stateless CSRF state. HMAC-SHA256 over the same trust root as the
# session JWT. No server-side persistence: the authorization `code` itself is
# single-use at Google's end, so signature + expiry is sufficient here.
# --------------------------------------------------------------------------- #

def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _sign(message: str) -> str:
    secret = get_settings().resolved_auth_secret().encode("utf-8")
    return _b64url(hmac.new(secret, message.encode("ascii"), hashlib.sha256).digest())


def _make_state() -> str:
    body = {"n": secrets.token_urlsafe(12), "exp": int(time.time()) + _STATE_TTL_SECONDS}
    raw = _b64url(json.dumps(body, separators=(",", ":")).encode("utf-8"))
    return f"{raw}.{_sign(raw)}"


def _verify_state(state: str) -> None:
    try:
        raw, sig = state.split(".")
    except (ValueError, AttributeError):
        raise GoogleLoginError("Malformed sign-in link — please try again")
    if not hmac.compare_digest(_sign(raw), sig):
        raise GoogleLoginError("Invalid sign-in link — please try again")
    try:
        body = json.loads(_b64url_decode(raw))
    except (ValueError, json.JSONDecodeError):
        raise GoogleLoginError("Invalid sign-in link — please try again")
    if int(body.get("exp", 0)) < int(time.time()):
        raise GoogleLoginError("Sign-in link expired — please try again")


# --------------------------------------------------------------------------- #
# Authorize URL + code exchange
# --------------------------------------------------------------------------- #

def redirect_uri() -> str:
    base = get_settings().resolved_public_base_url()
    if not base:
        raise GoogleLoginError("Google sign-in is not configured on this server.")
    return f"{base}{CALLBACK_PATH}"


def authorize_url() -> str:
    s = get_settings()
    if not s.google_login_oauth_configured():
        raise GoogleLoginError("Google sign-in is not configured on this server.")
    params = {
        "client_id": s.resolved_google_login_client_id(),
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "state": _make_state(),
        "access_type": "online",
        "prompt": "select_account",
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


def exchange_code(code: str, state: str) -> dict:
    """Verify ``state``, exchange the authorization code, and return the
    caller's verified profile: ``{"email", "name"}``."""
    _verify_state(state)
    s = get_settings()
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
            resp = client.post(TOKEN_URL, data={
                "code": code,
                "client_id": s.resolved_google_login_client_id(),
                "client_secret": s.resolved_google_login_client_secret(),
                "redirect_uri": redirect_uri(),
                "grant_type": "authorization_code",
            })
            if resp.status_code >= 400:
                raise GoogleLoginError(f"Google rejected the sign-in (HTTP {resp.status_code})")
            tokens = resp.json()
            access_token = tokens.get("access_token")
            if not access_token:
                raise GoogleLoginError("Google did not return an access token")

            info_resp = client.get(USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
            if info_resp.status_code >= 400:
                raise GoogleLoginError("Couldn't read your Google profile")
            info = info_resp.json()
    except httpx.HTTPError as exc:
        raise GoogleLoginError(f"Couldn't reach Google: {exc}") from exc

    email = (info.get("email") or "").strip().lower()
    if not email:
        raise GoogleLoginError("Your Google account has no email on file")
    if not info.get("verified_email", True):
        raise GoogleLoginError("Your Google email address isn't verified")
    return {"email": email, "name": (info.get("name") or "").strip() or None}
