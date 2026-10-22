"""Salesforce OAuth (connected app) — per-organization connections.

Mirrors ``hubspot_oauth`` exactly in shape: each Organization stores its own
encrypted access + refresh tokens, so a multi-tenant deployment talks to many
Salesforce orgs instead of sharing a single token. This module owns:

  - building the authorize URL with a signed, org-bound CSRF ``state``
  - exchanging the authorization code for tokens (callback)
  - refreshing the access token on demand, serialized per-org
  - resolving a valid access token (+ instance URL) for the sync engine
  - per-org toggles + disconnect/revoke

Salesforce specifics worth noting:
  - The authorize/token/revoke endpoints live under the login host
    (``login.salesforce.com``, or ``test.salesforce.com`` for sandboxes).
  - The token response returns an ``instance_url`` that is the REST API base
    for every subsequent call, plus an ``id`` identity URL we parse for the
    org id. It does NOT return ``expires_in`` — the session lifetime is an org
    setting — so we assume a configurable lifetime and refresh proactively.
  - Refreshes return a new access token (and instance_url) but usually NOT a
    new refresh token, which is long-lived.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Organization
from .crypto import DecryptError, decrypt, encrypt

logger = logging.getLogger("concap.salesforce.oauth")

CALLBACK_PATH = "/api/salesforce/oauth/callback"

# Scopes requested from the connecting org. `api` grants REST access and
# `refresh_token` (a.k.a. offline access) is required to receive a refresh
# token for unattended syncing.
SCOPES = [
    "api",
    "refresh_token",
]

# Refresh slightly before expiry so in-flight calls don't race the deadline.
_REFRESH_BUFFER = timedelta(minutes=5)
_STATE_TTL_SECONDS = 600
_HTTP_TIMEOUT = httpx.Timeout(20.0, connect=10.0)


class SalesforceOAuthError(Exception):
    """User-surfaced OAuth/connection problem (bad state, dead refresh
    token, not configured, ...).

    `transient` distinguishes retryable failures (network blips, Salesforce
    5xx, rate limits) from definitive ones (invalid_grant / 4xx). Only
    definitive failures should flip an org into needs-reconnect."""

    def __init__(self, message: str, *, transient: bool = False) -> None:
        super().__init__(message)
        self.transient = transient


# ---------------------------------------------------------------------------
# Endpoint helpers (login host is configurable for sandboxes)
# ---------------------------------------------------------------------------

def _login_base() -> str:
    return get_settings().salesforce_login_url.rstrip("/")


def authorize_endpoint() -> str:
    return f"{_login_base()}/services/oauth2/authorize"


def token_endpoint() -> str:
    return f"{_login_base()}/services/oauth2/token"


def revoke_endpoint() -> str:
    return f"{_login_base()}/services/oauth2/revoke"


# ---------------------------------------------------------------------------
# Signed CSRF state — binds the OAuth round-trip to the org + user that
# started it. HMAC-SHA256 over the auth secret (same trust root as the JWT).
# ---------------------------------------------------------------------------

def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _sign(message: str) -> str:
    secret = get_settings().resolved_auth_secret().encode("utf-8")
    return _b64url(hmac.new(secret, message.encode("ascii"), hashlib.sha256).digest())


def make_state(org_id: int, user_id: int, nonce: str) -> str:
    body = {
        "org": org_id,
        "uid": user_id,
        "n": nonce,
        "exp": int(time.time()) + _STATE_TTL_SECONDS,
    }
    raw = _b64url(json.dumps(body, separators=(",", ":")).encode("utf-8"))
    return f"{raw}.{_sign(raw)}"


def verify_state(state: str) -> dict:
    try:
        raw, sig = state.split(".")
    except (ValueError, AttributeError):
        raise SalesforceOAuthError("Malformed OAuth state")
    if not hmac.compare_digest(_sign(raw), sig):
        raise SalesforceOAuthError("Bad OAuth state signature")
    try:
        body = json.loads(_b64url_decode(raw))
    except (ValueError, json.JSONDecodeError):
        raise SalesforceOAuthError("Bad OAuth state payload")
    if int(body.get("exp", 0)) < int(time.time()):
        raise SalesforceOAuthError("OAuth state expired — please start connecting again")
    return body


# ---------------------------------------------------------------------------
# Authorize URL
# ---------------------------------------------------------------------------

def redirect_uri() -> str:
    base = get_settings().resolved_public_base_url()
    if not base:
        raise SalesforceOAuthError("PUBLIC_BASE_URL is not configured")
    return f"{base}{CALLBACK_PATH}"


def authorize_url(db: Session, org: Organization, user_id: int) -> str:
    s = get_settings()
    if not s.salesforce_oauth_configured():
        raise SalesforceOAuthError(
            "Salesforce OAuth is not configured on this server. "
            "Set SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET and PUBLIC_BASE_URL."
        )
    # Persist a fresh single-use nonce; the callback must match + consume it.
    # Starting a new connection invalidates any older in-flight state.
    nonce = secrets.token_urlsafe(16)
    org.salesforce_oauth_state = nonce
    db.commit()
    params = {
        "response_type": "code",
        "client_id": s.salesforce_client_id,
        "redirect_uri": redirect_uri(),
        "scope": " ".join(SCOPES),
        "state": make_state(org.id, user_id, nonce),
    }
    return f"{authorize_endpoint()}?{urlencode(params)}"


def consume_state(db: Session, org: Organization, payload: dict) -> None:
    """Verify the callback's nonce matches the one issued at /oauth/start and
    atomically clear it, so a valid signed state can't be replayed."""
    nonce = payload.get("n")
    expected = org.salesforce_oauth_state
    if not expected or not nonce or not hmac.compare_digest(str(expected), str(nonce)):
        raise SalesforceOAuthError("OAuth state already used or expired — please start connecting again")
    org.salesforce_oauth_state = None
    db.commit()


# ---------------------------------------------------------------------------
# Token endpoint (unauthenticated form posts)
# ---------------------------------------------------------------------------

def _token_request(data: dict) -> dict:
    try:
        resp = httpx.post(
            token_endpoint(),
            data=data,
            timeout=_HTTP_TIMEOUT,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    except httpx.HTTPError as exc:
        # Network error / timeout — retryable, don't treat as a dead grant.
        raise SalesforceOAuthError(f"Salesforce token network error: {exc}", transient=True) from exc
    if resp.status_code != 200:
        try:
            body = resp.json()
            msg = body.get("error_description") or body.get("error") or resp.text
        except ValueError:
            msg = resp.text
        # 5xx and 429 are transient (Salesforce-side / rate limit); a 4xx
        # (e.g. invalid_grant) means the grant is genuinely dead.
        transient = resp.status_code >= 500 or resp.status_code == 429
        raise SalesforceOAuthError(
            f"Salesforce rejected the token request ({resp.status_code}): {msg}",
            transient=transient,
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise SalesforceOAuthError("Salesforce returned a non-JSON token response") from exc


def exchange_code(code: str) -> dict:
    s = get_settings()
    return _token_request({
        "grant_type": "authorization_code",
        "client_id": s.salesforce_client_id,
        "client_secret": s.salesforce_client_secret,
        "redirect_uri": redirect_uri(),
        "code": code,
    })


def _org_id_from_identity(identity_url: str | None) -> str | None:
    """Salesforce's identity URL looks like
    ``https://login.salesforce.com/id/{orgId}/{userId}``. Pull the org id for
    display in the UI."""
    if not identity_url:
        return None
    parts = [p for p in identity_url.split("/") if p]
    # .../id/{orgId}/{userId} -> orgId is second from the end.
    if len(parts) >= 2:
        return parts[-2]
    return None


def _persist_tokens(db: Session, org: Organization, body: dict) -> str:
    access = body.get("access_token")
    if not access:
        raise SalesforceOAuthError("Salesforce did not return an access token")
    org.salesforce_access_token_enc = encrypt(access)
    refresh = body.get("refresh_token")
    if refresh:
        # Salesforce refresh tokens are long-lived and not re-issued on every
        # refresh; only overwrite when a new one is actually returned.
        org.salesforce_refresh_token_enc = encrypt(refresh)
    instance_url = body.get("instance_url")
    if instance_url:
        org.salesforce_instance_url = instance_url.rstrip("/")
    # No expires_in from Salesforce — assume the configured session lifetime.
    lifetime = int(get_settings().salesforce_session_lifetime_seconds or 7200)
    org.salesforce_token_expires_at = datetime.now(timezone.utc) + timedelta(seconds=lifetime)
    org.salesforce_needs_reconnect = False
    org.salesforce_disabled = False
    db.commit()
    return access


def complete_connection(db: Session, org: Organization, code: str) -> dict:
    """Callback handler: exchange the code and store tokens, instance URL, and
    (best-effort) the Salesforce org id for display."""
    body = exchange_code(code)
    _persist_tokens(db, org, body)
    org.salesforce_connected_at = datetime.now(timezone.utc)
    org_id = _org_id_from_identity(body.get("id"))
    if org_id:
        org.salesforce_org_id = org_id
    db.commit()
    return {"instance_url": org.salesforce_instance_url, "org_id": org.salesforce_org_id}


# ---------------------------------------------------------------------------
# Token resolution + refresh (per-org serialized)
# ---------------------------------------------------------------------------

_locks_guard = threading.Lock()
_org_locks: dict[int, threading.Lock] = {}


def _lock_for(org_id: int) -> threading.Lock:
    with _locks_guard:
        lock = _org_locks.get(org_id)
        if lock is None:
            lock = threading.Lock()
            _org_locks[org_id] = lock
        return lock


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def org_connected(org: Organization | None) -> bool:
    return bool(org and org.salesforce_access_token_enc and not org.salesforce_needs_reconnect)


def get_valid_access_token(db: Session, org: Organization) -> str:
    """Return a non-expired access token for the org, refreshing if needed.

    Raises SalesforceOAuthError when the org isn't connected or the refresh
    token is dead (after marking the org needs_reconnect)."""
    if org is None or not org.salesforce_access_token_enc:
        raise SalesforceOAuthError("This workspace has not connected Salesforce")
    if org.salesforce_needs_reconnect:
        raise SalesforceOAuthError("Salesforce connection expired — please reconnect")

    now = datetime.now(timezone.utc)
    expires_at = _aware(org.salesforce_token_expires_at)
    if expires_at and expires_at - _REFRESH_BUFFER > now:
        try:
            return decrypt(org.salesforce_access_token_enc)
        except DecryptError:
            _mark_needs_reconnect(db, org)
            raise SalesforceOAuthError("Stored Salesforce token could not be decrypted — please reconnect")

    # Needs refresh — serialize per org so concurrent syncs don't stampede.
    with _lock_for(org.id):
        db.refresh(org)
        if org.salesforce_needs_reconnect:
            raise SalesforceOAuthError("Salesforce connection expired — please reconnect")
        expires_at = _aware(org.salesforce_token_expires_at)
        if expires_at and expires_at - _REFRESH_BUFFER > now and org.salesforce_access_token_enc:
            try:
                return decrypt(org.salesforce_access_token_enc)
            except DecryptError:
                pass  # fall through to a refresh
        return _refresh(db, org)


def _refresh(db: Session, org: Organization) -> str:
    if not org.salesforce_refresh_token_enc:
        _mark_needs_reconnect(db, org)
        raise SalesforceOAuthError("No Salesforce refresh token on file — please reconnect")
    try:
        refresh_token = decrypt(org.salesforce_refresh_token_enc)
    except DecryptError:
        _mark_needs_reconnect(db, org)
        raise SalesforceOAuthError("Stored Salesforce token could not be decrypted — please reconnect")

    s = get_settings()
    try:
        body = _token_request({
            "grant_type": "refresh_token",
            "client_id": s.salesforce_client_id,
            "client_secret": s.salesforce_client_secret,
            "refresh_token": refresh_token,
        })
    except SalesforceOAuthError as exc:
        # Only a definitive failure (invalid_grant / 4xx) means the refresh
        # token is dead. Transient errors (network, 5xx, 429) are re-raised
        # without forcing the org to reconnect, so a Salesforce blip doesn't
        # lock everyone out — the next sync retries.
        if not exc.transient:
            _mark_needs_reconnect(db, org)
        raise
    logger.info("Refreshed Salesforce access token for org #%s", org.id)
    return _persist_tokens(db, org, body)


def _mark_needs_reconnect(db: Session, org: Organization) -> None:
    org.salesforce_needs_reconnect = True
    db.commit()


# ---------------------------------------------------------------------------
# Disconnect + per-org toggles
# ---------------------------------------------------------------------------

def disconnect(db: Session, org: Organization) -> None:
    """Clear stored tokens for the org. Best-effort revoke at Salesforce first
    so the grant disappears from the user's connected-apps list."""
    refresh_enc = org.salesforce_refresh_token_enc
    org.salesforce_access_token_enc = None
    org.salesforce_refresh_token_enc = None
    org.salesforce_token_expires_at = None
    org.salesforce_needs_reconnect = False
    org.salesforce_connected_at = None
    org.salesforce_instance_url = None
    org.salesforce_org_id = None
    org.salesforce_oauth_state = None
    org.salesforce_disabled = True
    db.commit()
    if refresh_enc:
        try:
            token = decrypt(refresh_enc)
            httpx.post(
                revoke_endpoint(),
                data={"token": token},
                timeout=_HTTP_TIMEOUT,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        except Exception as exc:  # noqa: BLE001 — revoke is best-effort
            # Never log the exception text in case it embeds the token; log
            # only the static reason + exception type.
            logger.warning(
                "Salesforce token revoke failed for org #%s (ignored): %s",
                org.id, type(exc).__name__,
            )


def auto_sync_enabled(org: Organization | None) -> bool:
    """Per-org auto-sync toggle. None (legacy/unmigrated row) reads as on."""
    if org is None or org.salesforce_auto_sync is None:
        return True
    return bool(org.salesforce_auto_sync)


def create_opportunities_enabled(org: Organization | None) -> bool:
    """Per-org create-opportunities toggle. None reads as on."""
    if org is None or org.salesforce_create_opportunities is None:
        return True
    return bool(org.salesforce_create_opportunities)
