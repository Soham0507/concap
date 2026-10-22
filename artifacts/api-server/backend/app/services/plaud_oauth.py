"""Plaud OAuth — per-USER connections to Plaud's remote MCP server.

Unlike HubSpot (per-organization), each *user* connects their own Plaud
account: their voice recordings are personal, so access + refresh tokens are
stored encrypted on the User row. There is no shared/global account.

Plaud exposes an MCP server (https://mcp.plaud.ai/mcp) that speaks the MCP
authorization profile: OAuth 2.1 with PKCE, authorization-server metadata
discovery (RFC 8414 / RFC 9728), optional Dynamic Client Registration
(RFC 7591), and resource indicators (RFC 8707). This module owns:

  - building the authorize URL with a signed, user-bound CSRF ``state`` + PKCE
  - resolving the OAuth client (a configured static client, else DCR per user)
  - discovering the authorize/token endpoints from the MCP server
  - exchanging the authorization code for tokens (callback)
  - refreshing the access token on demand, serialized per-user
  - resolving a valid access token for the sync engine + disconnect

Token-endpoint calls here are unauthenticated at the HTTP layer (the client
credentials travel in the form body), mirroring hubspot_oauth.
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
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import User
from .crypto import DecryptError, decrypt, encrypt

logger = logging.getLogger("concap.plaud.oauth")

CALLBACK_PATH = "/api/plaud/oauth/callback"

# Refresh slightly before expiry so in-flight calls don't race the deadline.
_REFRESH_BUFFER = timedelta(minutes=5)
_STATE_TTL_SECONDS = 600
_HTTP_TIMEOUT = httpx.Timeout(20.0, connect=10.0)
# Cache discovered AS metadata in-process — it's stable and re-discovery is
# cheap, but caching avoids a round-trip on every refresh/connect.
_METADATA_TTL_SECONDS = 3600


class PlaudOAuthError(Exception):
    """User-surfaced OAuth/connection problem.

    ``transient`` distinguishes retryable failures (network blips, 5xx, rate
    limits) from definitive ones (invalid_grant / other 4xx). Only definitive
    failures should flip a user into needs-reconnect."""

    def __init__(self, message: str, *, transient: bool = False) -> None:
        super().__init__(message)
        self.transient = transient


# ---------------------------------------------------------------------------
# Signed CSRF state — binds the OAuth round-trip to the user that started it.
# HMAC-SHA256 over the auth secret (same trust root as the JWT).
# ---------------------------------------------------------------------------

def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _sign(message: str) -> str:
    secret = get_settings().resolved_auth_secret().encode("utf-8")
    return _b64url(hmac.new(secret, message.encode("ascii"), hashlib.sha256).digest())


def make_state(user_id: int, nonce: str) -> str:
    body = {
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
        raise PlaudOAuthError("Malformed OAuth state")
    if not hmac.compare_digest(_sign(raw), sig):
        raise PlaudOAuthError("Bad OAuth state signature")
    try:
        body = json.loads(_b64url_decode(raw))
    except (ValueError, json.JSONDecodeError):
        raise PlaudOAuthError("Bad OAuth state payload")
    if int(body.get("exp", 0)) < int(time.time()):
        raise PlaudOAuthError("OAuth state expired — please start connecting again")
    return body


# ---------------------------------------------------------------------------
# PKCE
# ---------------------------------------------------------------------------

def _make_pkce() -> tuple[str, str]:
    """Return (code_verifier, code_challenge) for the S256 PKCE method."""
    verifier = secrets.token_urlsafe(64)[:96]  # 43..128 chars per RFC 7636
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


# ---------------------------------------------------------------------------
# Authorization-server metadata discovery (+ config overrides)
# ---------------------------------------------------------------------------

_metadata_cache: dict | None = None
_metadata_fetched_at: float = 0.0


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, "", "", ""))


def _get_json(url: str) -> dict | None:
    try:
        resp = httpx.get(url, timeout=_HTTP_TIMEOUT, follow_redirects=True)
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    try:
        body = resp.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


def _discover_metadata(*, force: bool = False) -> dict:
    """Resolve the authorize/token/registration endpoints for Plaud.

    Config overrides (PLAUD_AUTHORIZE_URL / PLAUD_TOKEN_URL) short-circuit all
    network discovery. Otherwise we follow the MCP authorization profile:
    protected-resource metadata (RFC 9728) names the authorization server,
    whose metadata (RFC 8414) names the endpoints. Results are cached.
    """
    global _metadata_cache, _metadata_fetched_at
    s = get_settings()

    if s.plaud_authorize_url and s.plaud_token_url:
        return {
            "authorization_endpoint": s.plaud_authorize_url,
            "token_endpoint": s.plaud_token_url,
            "registration_endpoint": s.plaud_registration_url or None,
        }

    now = time.time()
    if not force and _metadata_cache and (now - _metadata_fetched_at) < _METADATA_TTL_SECONDS:
        return _metadata_cache

    mcp_origin = _origin(s.plaud_mcp_url)
    # 1) Find the authorization server via protected-resource metadata.
    as_base = mcp_origin
    pr = _get_json(f"{mcp_origin}/.well-known/oauth-protected-resource")
    if pr:
        servers = pr.get("authorization_servers")
        if isinstance(servers, list) and servers:
            as_base = str(servers[0]).rstrip("/")

    # 2) Fetch the authorization-server metadata. Try the RFC 8414 well-known
    #    path and the OpenID variant.
    meta = None
    for path in (
        "/.well-known/oauth-authorization-server",
        "/.well-known/openid-configuration",
    ):
        meta = _get_json(f"{as_base}{path}")
        if meta and meta.get("authorization_endpoint") and meta.get("token_endpoint"):
            break
        meta = None

    if not meta:
        raise PlaudOAuthError(
            "Could not discover Plaud's OAuth endpoints. Set PLAUD_AUTHORIZE_URL "
            "and PLAUD_TOKEN_URL to configure them explicitly.",
            transient=True,
        )

    resolved = {
        "authorization_endpoint": meta["authorization_endpoint"],
        "token_endpoint": meta["token_endpoint"],
        "registration_endpoint": s.plaud_registration_url or meta.get("registration_endpoint"),
    }
    _metadata_cache = resolved
    _metadata_fetched_at = now
    return resolved


# ---------------------------------------------------------------------------
# OAuth client resolution (static config, else Dynamic Client Registration)
# ---------------------------------------------------------------------------

def _register_client(registration_endpoint: str, redirect: str) -> dict:
    """Register a fresh OAuth client with the AS (RFC 7591). Returns the issued
    client metadata (client_id, optional client_secret)."""
    s = get_settings()
    payload = {
        "client_name": "Concap AI",
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "client_secret_post",
    }
    if s.plaud_scope_list:
        payload["scope"] = " ".join(s.plaud_scope_list)
    try:
        resp = httpx.post(registration_endpoint, json=payload, timeout=_HTTP_TIMEOUT)
    except httpx.HTTPError as exc:
        raise PlaudOAuthError(f"Plaud client registration network error: {exc}", transient=True) from exc
    if resp.status_code not in (200, 201):
        raise PlaudOAuthError(
            f"Plaud rejected dynamic client registration ({resp.status_code}): {resp.text[:300]}"
        )
    try:
        body = resp.json()
    except ValueError as exc:
        raise PlaudOAuthError("Plaud returned a non-JSON client-registration response") from exc
    if not body.get("client_id"):
        raise PlaudOAuthError("Plaud client registration did not return a client_id")
    return body


def _resolve_client(db: Session, user: User, metadata: dict) -> tuple[str, str | None]:
    """Return (client_id, client_secret) to use for this user's grant.

    Prefers a server-configured static client. Otherwise registers a client
    dynamically and persists it on the user row so the same client is reused
    for token refreshes later."""
    s = get_settings()
    if s.plaud_client_id:
        user.plaud_client_id = s.plaud_client_id
        user.plaud_client_secret_enc = encrypt(s.plaud_client_secret) if s.plaud_client_secret else None
        db.commit()
        return s.plaud_client_id, (s.plaud_client_secret or None)

    registration_endpoint = metadata.get("registration_endpoint")
    if not registration_endpoint:
        raise PlaudOAuthError(
            "Plaud requires a client but none is configured and the server does "
            "not support dynamic client registration. Set PLAUD_ACCOUNT_OAUTH_CLIENT_ID "
            "for a registered personal-account OAuth app (not an Embedded partner app)."
        )
    body = _register_client(registration_endpoint, redirect_uri())
    client_id = str(body["client_id"])
    client_secret = body.get("client_secret")
    user.plaud_client_id = client_id
    user.plaud_client_secret_enc = encrypt(client_secret) if client_secret else None
    db.commit()
    return client_id, client_secret


def _client_credentials(user: User) -> tuple[str, str | None]:
    """Read back the client this user connected with (for token refresh)."""
    if not user.plaud_client_id:
        raise PlaudOAuthError("No Plaud OAuth client on file — please reconnect")
    secret = None
    if user.plaud_client_secret_enc:
        try:
            secret = decrypt(user.plaud_client_secret_enc)
        except DecryptError as exc:
            raise PlaudOAuthError("Stored Plaud client secret could not be decrypted — please reconnect") from exc
    return user.plaud_client_id, secret


# ---------------------------------------------------------------------------
# Authorize URL
# ---------------------------------------------------------------------------

def redirect_uri() -> str:
    base = get_settings().resolved_public_base_url()
    if not base:
        raise PlaudOAuthError("PUBLIC_BASE_URL is not configured")
    return f"{base}{CALLBACK_PATH}"


def authorize_url(db: Session, user: User) -> str:
    s = get_settings()
    if not s.plaud_oauth_configured():
        raise PlaudOAuthError(
            "Plaud OAuth is not configured on this server. Set PUBLIC_BASE_URL "
            "(and optionally PLAUD_ACCOUNT_OAUTH_CLIENT_ID / PLAUD_ACCOUNT_OAUTH_CLIENT_SECRET "
            "for a pre-registered personal-account OAuth app)."
        )
    metadata = _discover_metadata()
    client_id, _ = _resolve_client(db, user, metadata)

    # Fresh single-use nonce + PKCE verifier; the callback matches + consumes
    # the nonce and uses the verifier. Starting over invalidates older state.
    nonce = secrets.token_urlsafe(16)
    verifier, challenge = _make_pkce()
    user.plaud_oauth_state = nonce
    user.plaud_code_verifier = verifier
    db.commit()

    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri(),
        "state": make_state(user.id, nonce),
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        # Resource indicator (RFC 8707) — bind the token to the MCP server.
        "resource": s.plaud_mcp_url,
    }
    if s.plaud_scope_list:
        params["scope"] = " ".join(s.plaud_scope_list)
    return f"{metadata['authorization_endpoint']}?{urlencode(params)}"


def consume_state(db: Session, user: User, payload: dict) -> None:
    """Verify the callback's nonce matches the one issued at /oauth/start and
    atomically clear it, so a valid signed state can't be replayed."""
    nonce = payload.get("n")
    expected = user.plaud_oauth_state
    if not expected or not nonce or not hmac.compare_digest(str(expected), str(nonce)):
        raise PlaudOAuthError("OAuth state already used or expired — please start connecting again")
    user.plaud_oauth_state = None
    db.commit()


# ---------------------------------------------------------------------------
# Token endpoint (unauthenticated form posts)
# ---------------------------------------------------------------------------

def _token_request(token_endpoint: str, data: dict) -> dict:
    try:
        resp = httpx.post(
            token_endpoint,
            data=data,
            timeout=_HTTP_TIMEOUT,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    except httpx.HTTPError as exc:
        raise PlaudOAuthError(f"Plaud token network error: {exc}", transient=True) from exc
    if resp.status_code != 200:
        try:
            body = resp.json()
            msg = body.get("error_description") or body.get("error") or resp.text
        except ValueError:
            msg = resp.text
        transient = resp.status_code >= 500 or resp.status_code == 429
        raise PlaudOAuthError(
            f"Plaud rejected the token request ({resp.status_code}): {msg}",
            transient=transient,
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise PlaudOAuthError("Plaud returned a non-JSON token response") from exc


def _client_auth_fields(client_id: str, client_secret: str | None) -> dict:
    fields = {"client_id": client_id}
    if client_secret:
        fields["client_secret"] = client_secret
    return fields


def exchange_code(db: Session, user: User, code: str) -> dict:
    s = get_settings()
    metadata = _discover_metadata()
    client_id, client_secret = _client_credentials(user)
    verifier = user.plaud_code_verifier
    if not verifier:
        raise PlaudOAuthError("Missing PKCE verifier — please start connecting again")
    data = {
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri(),
        "code": code,
        "code_verifier": verifier,
        "resource": s.plaud_mcp_url,
        **_client_auth_fields(client_id, client_secret),
    }
    body = _token_request(metadata["token_endpoint"], data)
    # PKCE verifier is single-use; clear it once consumed.
    user.plaud_code_verifier = None
    db.commit()
    return body


def _persist_tokens(db: Session, user: User, body: dict) -> str:
    access = body.get("access_token")
    if not access:
        raise PlaudOAuthError("Plaud did not return an access token")
    user.plaud_access_token_enc = encrypt(access)
    refresh = body.get("refresh_token")
    if refresh:
        user.plaud_refresh_token_enc = encrypt(refresh)
    expires_in = int(body.get("expires_in") or 3600)
    user.plaud_token_expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
    user.plaud_needs_reconnect = False
    db.commit()
    return access


def complete_connection(db: Session, user: User, code: str) -> dict:
    """Callback handler: exchange the code, store tokens, and best-effort
    capture the Plaud account email/name for display in the UI."""
    body = exchange_code(db, user, code)
    access = _persist_tokens(db, user, body)
    user.plaud_connected_at = datetime.now(timezone.utc)

    try:
        # Lazy import avoids importing the MCP stack unless we connect.
        from .plaud_mcp import get_current_user

        info = get_current_user(access) or {}
        user.plaud_account_email = (info.get("email") or None)
        user.plaud_account_name = (info.get("name") or info.get("display_name") or None)
    except Exception as exc:  # noqa: BLE001 — account info is a nicety
        logger.warning("Could not fetch Plaud account info after connect: %s", type(exc).__name__)
    db.commit()
    return {"email": user.plaud_account_email, "name": user.plaud_account_name}


# ---------------------------------------------------------------------------
# Token resolution + refresh (per-user serialized)
# ---------------------------------------------------------------------------

_locks_guard = threading.Lock()
_user_locks: dict[int, threading.Lock] = {}


def _lock_for(user_id: int) -> threading.Lock:
    with _locks_guard:
        lock = _user_locks.get(user_id)
        if lock is None:
            lock = threading.Lock()
            _user_locks[user_id] = lock
        return lock


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def user_connected(user: User | None) -> bool:
    return bool(user and user.plaud_access_token_enc and not user.plaud_needs_reconnect)


def get_valid_access_token(db: Session, user: User) -> str:
    """Return a non-expired access token for the user, refreshing if needed.

    Raises PlaudOAuthError when the user isn't connected or the refresh token
    is dead (after marking the user needs_reconnect)."""
    if user is None or not user.plaud_access_token_enc:
        raise PlaudOAuthError("You have not connected Plaud")
    if user.plaud_needs_reconnect:
        raise PlaudOAuthError("Plaud connection expired — please reconnect")

    now = datetime.now(timezone.utc)
    expires_at = _aware(user.plaud_token_expires_at)
    if expires_at and expires_at - _REFRESH_BUFFER > now:
        try:
            return decrypt(user.plaud_access_token_enc)
        except DecryptError:
            _mark_needs_reconnect(db, user)
            raise PlaudOAuthError("Stored Plaud token could not be decrypted — please reconnect")

    with _lock_for(user.id):
        db.refresh(user)
        if user.plaud_needs_reconnect:
            raise PlaudOAuthError("Plaud connection expired — please reconnect")
        expires_at = _aware(user.plaud_token_expires_at)
        if expires_at and expires_at - _REFRESH_BUFFER > now and user.plaud_access_token_enc:
            try:
                return decrypt(user.plaud_access_token_enc)
            except DecryptError:
                pass  # fall through to a refresh
        return _refresh(db, user)


def _refresh(db: Session, user: User) -> str:
    if not user.plaud_refresh_token_enc:
        _mark_needs_reconnect(db, user)
        raise PlaudOAuthError("No Plaud refresh token on file — please reconnect")
    try:
        refresh_token = decrypt(user.plaud_refresh_token_enc)
    except DecryptError:
        _mark_needs_reconnect(db, user)
        raise PlaudOAuthError("Stored Plaud token could not be decrypted — please reconnect")

    s = get_settings()
    try:
        metadata = _discover_metadata()
        client_id, client_secret = _client_credentials(user)
        body = _token_request(metadata["token_endpoint"], {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "resource": s.plaud_mcp_url,
            **_client_auth_fields(client_id, client_secret),
        })
    except PlaudOAuthError as exc:
        # Only a definitive failure (invalid_grant / 4xx) kills the grant.
        if not exc.transient:
            _mark_needs_reconnect(db, user)
        raise
    logger.info("Refreshed Plaud access token for user #%s", user.id)
    return _persist_tokens(db, user, body)


def _mark_needs_reconnect(db: Session, user: User) -> None:
    user.plaud_needs_reconnect = True
    db.commit()


# ---------------------------------------------------------------------------
# Disconnect
# ---------------------------------------------------------------------------

def disconnect(db: Session, user: User) -> None:
    """Clear stored Plaud tokens + client for the user."""
    user.plaud_access_token_enc = None
    user.plaud_refresh_token_enc = None
    user.plaud_token_expires_at = None
    user.plaud_needs_reconnect = False
    user.plaud_connected_at = None
    user.plaud_oauth_state = None
    user.plaud_code_verifier = None
    user.plaud_client_id = None
    user.plaud_client_secret_enc = None
    user.plaud_account_email = None
    user.plaud_account_name = None
    db.commit()
