"""HubSpot OAuth (public app) — per-organization connections.

Each Organization stores its own encrypted access + refresh tokens, so a
multi-tenant deployment talks to many HubSpot portals instead of sharing a
single global Private App token. This module owns:

  - building the authorize URL with a signed, org-bound CSRF `state`
  - exchanging the authorization code for tokens (callback)
  - refreshing the access token on demand, serialized per-org
  - resolving a valid access token for the sync engine
  - per-org toggles + disconnect/revoke

Token-endpoint calls here are unauthenticated (client_id/secret travel in
the form body), so they bypass the authenticated `_request` in hubspot.py.
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

logger = logging.getLogger("concap.hubspot.oauth")

AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize"
TOKEN_URL = "https://api.hubapi.com/oauth/v1/token"
REVOKE_URL = "https://api.hubapi.com/oauth/v1/refresh-tokens"
CALLBACK_PATH = "/api/hubspot/oauth/callback"

# Scopes requested from the connecting portal. Mirror the list shown to the
# user on the integrations page.
SCOPES = [
    "oauth",
    "crm.objects.contacts.read",
    "crm.objects.contacts.write",
    "crm.objects.companies.read",
    "crm.objects.companies.write",
    "crm.objects.deals.read",
    "crm.objects.deals.write",
    "crm.schemas.contacts.read",
    "crm.schemas.companies.read",
    "crm.schemas.deals.read",
    "crm.objects.owners.read",
]

# Refresh slightly before expiry so in-flight calls don't race the deadline.
_REFRESH_BUFFER = timedelta(minutes=5)
_STATE_TTL_SECONDS = 600
_HTTP_TIMEOUT = httpx.Timeout(20.0, connect=10.0)


class HubSpotOAuthError(Exception):
    """User-surfaced OAuth/connection problem (bad state, dead refresh
    token, not configured, ...).

    `transient` distinguishes retryable failures (network blips, HubSpot 5xx,
    rate limits) from definitive ones (invalid_grant / 4xx). Only definitive
    failures should flip an org into needs-reconnect."""

    def __init__(self, message: str, *, transient: bool = False) -> None:
        super().__init__(message)
        self.transient = transient


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
        raise HubSpotOAuthError("Malformed OAuth state")
    if not hmac.compare_digest(_sign(raw), sig):
        raise HubSpotOAuthError("Bad OAuth state signature")
    try:
        body = json.loads(_b64url_decode(raw))
    except (ValueError, json.JSONDecodeError):
        raise HubSpotOAuthError("Bad OAuth state payload")
    if int(body.get("exp", 0)) < int(time.time()):
        raise HubSpotOAuthError("OAuth state expired — please start connecting again")
    return body


# ---------------------------------------------------------------------------
# Authorize URL
# ---------------------------------------------------------------------------

def redirect_uri() -> str:
    base = get_settings().resolved_public_base_url()
    if not base:
        raise HubSpotOAuthError("PUBLIC_BASE_URL is not configured")
    return f"{base}{CALLBACK_PATH}"


def authorize_url(db: Session, org: Organization, user_id: int) -> str:
    s = get_settings()
    if not s.hubspot_oauth_configured():
        raise HubSpotOAuthError(
            "HubSpot OAuth is not configured on this server. "
            "Set HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET and PUBLIC_BASE_URL."
        )
    # Persist a fresh single-use nonce; the callback must match + consume it.
    # Starting a new connection invalidates any older in-flight state.
    nonce = secrets.token_urlsafe(16)
    org.hubspot_oauth_state = nonce
    db.commit()
    params = {
        "client_id": s.hubspot_client_id,
        "redirect_uri": redirect_uri(),
        "scope": " ".join(SCOPES),
        "state": make_state(org.id, user_id, nonce),
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


def consume_state(db: Session, org: Organization, payload: dict) -> None:
    """Verify the callback's nonce matches the one issued at /oauth/start and
    atomically clear it, so a valid signed state can't be replayed."""
    nonce = payload.get("n")
    expected = org.hubspot_oauth_state
    if not expected or not nonce or not hmac.compare_digest(str(expected), str(nonce)):
        raise HubSpotOAuthError("OAuth state already used or expired — please start connecting again")
    org.hubspot_oauth_state = None
    db.commit()


# ---------------------------------------------------------------------------
# Token endpoint (unauthenticated form posts)
# ---------------------------------------------------------------------------

def _token_request(data: dict) -> dict:
    try:
        resp = httpx.post(
            TOKEN_URL,
            data=data,
            timeout=_HTTP_TIMEOUT,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    except httpx.HTTPError as exc:
        # Network error / timeout — retryable, don't treat as a dead grant.
        raise HubSpotOAuthError(f"HubSpot token network error: {exc}", transient=True) from exc
    if resp.status_code != 200:
        try:
            body = resp.json()
            msg = body.get("message") or body.get("error_description") or body.get("error") or resp.text
        except ValueError:
            msg = resp.text
        # 5xx and 429 are transient (HubSpot-side / rate limit); a 4xx
        # (e.g. invalid_grant) means the grant is genuinely dead.
        transient = resp.status_code >= 500 or resp.status_code == 429
        raise HubSpotOAuthError(
            f"HubSpot rejected the token request ({resp.status_code}): {msg}",
            transient=transient,
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise HubSpotOAuthError("HubSpot returned a non-JSON token response") from exc


def exchange_code(code: str) -> dict:
    s = get_settings()
    return _token_request({
        "grant_type": "authorization_code",
        "client_id": s.hubspot_client_id,
        "client_secret": s.hubspot_client_secret,
        "redirect_uri": redirect_uri(),
        "code": code,
    })


def _persist_tokens(db: Session, org: Organization, body: dict) -> str:
    access = body.get("access_token")
    if not access:
        raise HubSpotOAuthError("HubSpot did not return an access token")
    org.hubspot_access_token_enc = encrypt(access)
    refresh = body.get("refresh_token")
    if refresh:
        org.hubspot_refresh_token_enc = encrypt(refresh)
    expires_in = int(body.get("expires_in") or 1800)
    org.hubspot_token_expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
    org.hubspot_needs_reconnect = False
    org.hubspot_disabled = False
    db.commit()
    return access


def complete_connection(db: Session, org: Organization, code: str) -> dict:
    """Callback handler: exchange the code, store tokens, and best-effort
    capture the portal id for clickable links in the UI."""
    body = exchange_code(code)
    access = _persist_tokens(db, org, body)
    org.hubspot_connected_at = datetime.now(timezone.utc)

    portal_id = None
    try:
        # Lazy import avoids a circular dependency (hubspot.py imports us).
        from .hubspot import get_account_info, use_org_context

        with use_org_context(access, None):
            info = get_account_info() or {}
        portal_id = info.get("portal_id")
    except Exception as exc:  # noqa: BLE001 — portal id is a nicety, not required
        logger.warning("Could not fetch HubSpot portal info after connect: %s", exc)
    if portal_id is not None:
        org.hubspot_portal_id = str(portal_id)
    db.commit()
    return {"portal_id": org.hubspot_portal_id}


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
    return bool(org and org.hubspot_access_token_enc and not org.hubspot_needs_reconnect)


def get_valid_access_token(db: Session, org: Organization) -> str:
    """Return a non-expired access token for the org, refreshing if needed.

    Raises HubSpotOAuthError when the org isn't connected or the refresh
    token is dead (after marking the org needs_reconnect)."""
    if org is None or not org.hubspot_access_token_enc:
        raise HubSpotOAuthError("This workspace has not connected HubSpot")
    if org.hubspot_needs_reconnect:
        raise HubSpotOAuthError("HubSpot connection expired — please reconnect")

    now = datetime.now(timezone.utc)
    expires_at = _aware(org.hubspot_token_expires_at)
    if expires_at and expires_at - _REFRESH_BUFFER > now:
        try:
            return decrypt(org.hubspot_access_token_enc)
        except DecryptError:
            _mark_needs_reconnect(db, org)
            raise HubSpotOAuthError("Stored HubSpot token could not be decrypted — please reconnect")

    # Needs refresh — serialize per org so concurrent syncs don't stampede.
    with _lock_for(org.id):
        db.refresh(org)
        if org.hubspot_needs_reconnect:
            raise HubSpotOAuthError("HubSpot connection expired — please reconnect")
        expires_at = _aware(org.hubspot_token_expires_at)
        if expires_at and expires_at - _REFRESH_BUFFER > now and org.hubspot_access_token_enc:
            try:
                return decrypt(org.hubspot_access_token_enc)
            except DecryptError:
                pass  # fall through to a refresh
        return _refresh(db, org)


def _refresh(db: Session, org: Organization) -> str:
    if not org.hubspot_refresh_token_enc:
        _mark_needs_reconnect(db, org)
        raise HubSpotOAuthError("No HubSpot refresh token on file — please reconnect")
    try:
        refresh_token = decrypt(org.hubspot_refresh_token_enc)
    except DecryptError:
        _mark_needs_reconnect(db, org)
        raise HubSpotOAuthError("Stored HubSpot token could not be decrypted — please reconnect")

    s = get_settings()
    try:
        body = _token_request({
            "grant_type": "refresh_token",
            "client_id": s.hubspot_client_id,
            "client_secret": s.hubspot_client_secret,
            "refresh_token": refresh_token,
        })
    except HubSpotOAuthError as exc:
        # Only a definitive failure (invalid_grant / 4xx) means the refresh
        # token is dead. Transient errors (network, 5xx, 429) are re-raised
        # without forcing the org to reconnect, so a HubSpot blip doesn't lock
        # everyone out — the next sync retries.
        if not exc.transient:
            _mark_needs_reconnect(db, org)
        raise
    logger.info("Refreshed HubSpot access token for org #%s", org.id)
    return _persist_tokens(db, org, body)


def _mark_needs_reconnect(db: Session, org: Organization) -> None:
    org.hubspot_needs_reconnect = True
    db.commit()


# ---------------------------------------------------------------------------
# Disconnect + per-org toggles
# ---------------------------------------------------------------------------

def disconnect(db: Session, org: Organization) -> None:
    """Clear stored tokens for the org. Best-effort revoke at HubSpot first
    so the grant disappears from the user's connected-apps list."""
    refresh_enc = org.hubspot_refresh_token_enc
    org.hubspot_access_token_enc = None
    org.hubspot_refresh_token_enc = None
    org.hubspot_token_expires_at = None
    org.hubspot_needs_reconnect = False
    org.hubspot_connected_at = None
    org.hubspot_portal_id = None
    org.hubspot_oauth_state = None
    # Mark as deliberately disconnected so the org does NOT silently fall back
    # to the shared legacy global token after disconnecting.
    org.hubspot_disabled = True
    db.commit()
    if refresh_enc:
        try:
            token = decrypt(refresh_enc)
            httpx.delete(f"{REVOKE_URL}/{token}", timeout=_HTTP_TIMEOUT)
        except Exception as exc:  # noqa: BLE001 — revoke is best-effort
            # Never log the exception text: the revoke URL embeds the plaintext
            # refresh token, and many httpx errors include the request URL. Log
            # only the static reason + exception type so the token can't leak.
            logger.warning(
                "HubSpot token revoke failed for org #%s (ignored): %s",
                org.id, type(exc).__name__,
            )


def auto_sync_enabled(org: Organization | None) -> bool:
    """Per-org auto-sync toggle. None (legacy/unmigrated row) reads as on."""
    if org is None or org.hubspot_auto_sync is None:
        return True
    return bool(org.hubspot_auto_sync)


def create_deals_enabled(org: Organization | None) -> bool:
    """Per-org create-deals toggle. None reads as on."""
    if org is None or org.hubspot_create_deals is None:
        return True
    return bool(org.hubspot_create_deals)


def _granular_toggle(org: Organization | None, attr: str) -> bool:
    """Read one of the granular per-org sync toggles. A missing/None value
    (legacy/unmigrated row) reads as on so existing orgs keep full sync."""
    if org is None:
        return True
    val = getattr(org, attr, None)
    if val is None:
        return True
    return bool(val)


def sync_contacts_enabled(org: Organization | None) -> bool:
    """Whether to upsert the contact during sync. None reads as on."""
    return _granular_toggle(org, "hubspot_sync_contacts")


def sync_companies_enabled(org: Organization | None) -> bool:
    """Whether to upsert the company during sync. None reads as on."""
    return _granular_toggle(org, "hubspot_sync_companies")


def sync_notes_enabled(org: Organization | None) -> bool:
    """Whether to create/update the timeline note during sync. None reads as on."""
    return _granular_toggle(org, "hubspot_sync_notes")


def sync_transcript_enabled(org: Organization | None) -> bool:
    """Whether to include the full transcript in the note body. None reads as on."""
    return _granular_toggle(org, "hubspot_sync_transcript")


def sync_tasks_enabled(org: Organization | None) -> bool:
    """Whether to create HubSpot Tasks from action items. None reads as on."""
    return _granular_toggle(org, "hubspot_sync_tasks")


def sync_insights_enabled(org: Organization | None) -> bool:
    """Whether to write AI insights to custom contact properties. None reads as on."""
    return _granular_toggle(org, "hubspot_sync_insights")


def default_owner_id(org: Organization | None) -> str | None:
    """The HubSpot owner id that synced Tasks are assigned to, or None when no
    owner is configured (tasks are still created, just left unassigned)."""
    if org is None:
        return None
    val = getattr(org, "hubspot_default_owner_id", None)
    return str(val) if val else None
