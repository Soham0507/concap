"""Per-organization OAuth for the meeting-import providers (Zoom, Google Meet,
Microsoft Teams).

A single generic implementation parameterized by ``PROVIDERS`` config, mirroring
``salesforce_oauth`` / ``hubspot_oauth`` in shape: each Organization stores its
own encrypted access + refresh tokens (columns prefixed ``zoom_`` / ``gmeet_`` /
``teams_``), so a multi-tenant deployment talks to many provider accounts rather
than sharing one. This module owns:

  - building the authorize URL with a signed, org-bound CSRF ``state``
  - exchanging the authorization code for tokens (callback)
  - refreshing the access token on demand, serialized per-(org, provider)
  - resolving a valid access token for the transcript fetchers
  - disconnect

Provider quirks handled here:
  - Zoom authenticates the token endpoint with HTTP Basic (client:secret) and
    rotates the refresh token on every refresh.
  - Google needs ``access_type=offline`` + ``prompt=consent`` to return a
    refresh token, and usually does NOT re-issue it on refresh.
  - Microsoft puts the tenant in the endpoint path and needs ``offline_access``.
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

logger = logging.getLogger("concap.meeting.oauth")

_REFRESH_BUFFER = timedelta(minutes=5)
_STATE_TTL_SECONDS = 600
_HTTP_TIMEOUT = httpx.Timeout(20.0, connect=10.0)


class MeetingOAuthError(Exception):
    """User-surfaced OAuth/connection problem. ``transient`` distinguishes
    retryable failures (network, 5xx, 429) from definitive ones (invalid_grant
    / 4xx); only definitive failures flip an org into needs-reconnect."""

    def __init__(self, message: str, *, transient: bool = False) -> None:
        super().__init__(message)
        self.transient = transient


# --------------------------------------------------------------------------- #
# Provider registry
# --------------------------------------------------------------------------- #


def _ms_tenant_segment() -> str:
    # An empty/unset tenant builds an authority like
    # `https://login.microsoftonline.com//oauth2/...` which Microsoft rejects
    # with AADSTS90019 ("No tenant-identifying information"). Fall back to the
    # multi-tenant "organizations" endpoint (work/school accounts) so a missing
    # MS_TENANT can never produce a broken authority URL.
    # ms_tenant_override (a plain env var) wins when set, since the MS_TENANT
    # secret value can be hard to change in the UI.
    s = get_settings()
    return (s.ms_tenant_override or "").strip() or (s.ms_tenant or "").strip() or "organizations"


def _ms_authorize() -> str:
    return f"https://login.microsoftonline.com/{_ms_tenant_segment()}/oauth2/v2.0/authorize"


def _ms_token() -> str:
    return f"https://login.microsoftonline.com/{_ms_tenant_segment()}/oauth2/v2.0/token"


PROVIDERS: dict[str, dict] = {
    "zoom": {
        "label": "Zoom",
        "prefix": "zoom",
        "authorize": lambda: "https://zoom.us/oauth/authorize",
        "token": lambda: "https://zoom.us/oauth/token",
        # Zoom user-level OAuth apps carry their scopes in the app config; we
        # leave the authorize scope empty so the app's configured scopes apply.
        "scopes": [],
        "auth_style": "basic",
        "extra_authorize": {},
        "client_id_attr": "zoom_client_id",
        "client_secret_attr": "zoom_client_secret",
        "userinfo": "https://api.zoom.us/v2/users/me",
        "userinfo_field": "email",
    },
    "google_meet": {
        "label": "Google Meet",
        "prefix": "gmeet",
        "authorize": lambda: "https://accounts.google.com/o/oauth2/v2/auth",
        "token": lambda: "https://oauth2.googleapis.com/token",
        "scopes": [
            "https://www.googleapis.com/auth/meetings.space.readonly",
            "https://www.googleapis.com/auth/drive.readonly",
            # calendar.events lets us create/patch events AND have Google email
            # attendees natively (sendUpdates=all) — no Gmail-send scope needed.
            "https://www.googleapis.com/auth/calendar.events",
            "https://www.googleapis.com/auth/userinfo.email",
        ],
        "auth_style": "body",
        # Google's refresh endpoint rejects a `scope` that isn't an exact subset
        # of what was originally granted (400 Bad Request). Omit it on refresh —
        # Google returns the originally-granted scopes regardless.
        "refresh_send_scope": False,
        "extra_authorize": {"access_type": "offline", "prompt": "consent"},
        "client_id_attr": "google_client_id",
        "client_secret_attr": "google_client_secret",
        "userinfo": "https://www.googleapis.com/oauth2/v2/userinfo",
        "userinfo_field": "email",
    },
    "ms_teams": {
        "label": "Microsoft Teams",
        "prefix": "teams",
        "authorize": _ms_authorize,
        "token": _ms_token,
        "scopes": [
            "offline_access",
            "OnlineMeetings.Read",
            "OnlineMeetingTranscript.Read.All",
            # Required to list calendar meetings via GET /me/events AND to
            # create/update Teams online-meeting events via POST/PATCH /me/events
            # (ReadWrite supersedes Read). Without it Graph returns 403 Forbidden.
            "Calendars.ReadWrite",
            "User.Read",
        ],
        "auth_style": "body",
        "extra_authorize": {},
        "client_id_attr": "ms_client_id",
        "client_secret_attr": "ms_client_secret",
        "userinfo": "https://graph.microsoft.com/v1.0/me",
        "userinfo_field": "userPrincipalName",
    },
}


def provider_config(provider: str) -> dict:
    cfg = PROVIDERS.get(provider)
    if not cfg:
        raise MeetingOAuthError(f"Unknown meeting provider: {provider}")
    return cfg


def _client_creds(provider: str) -> tuple[str, str]:
    cfg = provider_config(provider)
    s = get_settings()
    return getattr(s, cfg["client_id_attr"], ""), getattr(s, cfg["client_secret_attr"], "")


def oauth_configured(provider: str) -> bool:
    cid, csecret = _client_creds(provider)
    return bool(cid and csecret and get_settings().resolved_public_base_url())


def _attr(org: Organization, provider: str, field: str):
    return getattr(org, f"{provider_config(provider)['prefix']}_{field}")


def _set_attr(org: Organization, provider: str, field: str, value) -> None:
    setattr(org, f"{provider_config(provider)['prefix']}_{field}", value)


# --------------------------------------------------------------------------- #
# Signed CSRF state (HMAC-SHA256 over the auth secret, same as the JWT)
# --------------------------------------------------------------------------- #


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _sign(message: str) -> str:
    secret = get_settings().resolved_auth_secret().encode("utf-8")
    return _b64url(hmac.new(secret, message.encode("ascii"), hashlib.sha256).digest())


def make_state(org_id: int, user_id: int, provider: str, nonce: str) -> str:
    body = {
        "org": org_id,
        "uid": user_id,
        "p": provider,
        "n": nonce,
        "exp": int(time.time()) + _STATE_TTL_SECONDS,
    }
    raw = _b64url(json.dumps(body, separators=(",", ":")).encode("utf-8"))
    return f"{raw}.{_sign(raw)}"


def verify_state(state: str) -> dict:
    try:
        raw, sig = state.split(".")
    except (ValueError, AttributeError):
        raise MeetingOAuthError("Malformed OAuth state")
    if not hmac.compare_digest(_sign(raw), sig):
        raise MeetingOAuthError("Bad OAuth state signature")
    try:
        body = json.loads(_b64url_decode(raw))
    except (ValueError, json.JSONDecodeError):
        raise MeetingOAuthError("Bad OAuth state payload")
    if int(body.get("exp", 0)) < int(time.time()):
        raise MeetingOAuthError("OAuth state expired — please start connecting again")
    return body


# --------------------------------------------------------------------------- #
# Authorize URL
# --------------------------------------------------------------------------- #

CALLBACK_PREFIX = "/api/imported-meetings/providers"


def redirect_uri(provider: str) -> str:
    base = get_settings().resolved_public_base_url()
    if not base:
        raise MeetingOAuthError("PUBLIC_BASE_URL is not configured")
    return f"{base}{CALLBACK_PREFIX}/{provider}/oauth/callback"


def authorize_url(db: Session, org: Organization, user_id: int, provider: str) -> str:
    cfg = provider_config(provider)
    if not oauth_configured(provider):
        raise MeetingOAuthError(
            f"{cfg['label']} OAuth is not configured on this server. "
            f"Set the provider client id/secret and PUBLIC_BASE_URL."
        )
    cid, _ = _client_creds(provider)
    nonce = secrets.token_urlsafe(16)
    _set_attr(org, provider, "oauth_state", nonce)
    db.commit()
    params = {
        "response_type": "code",
        "client_id": cid,
        "redirect_uri": redirect_uri(provider),
        "state": make_state(org.id, user_id, provider, nonce),
    }
    if cfg["scopes"]:
        params["scope"] = " ".join(cfg["scopes"])
    params.update(cfg.get("extra_authorize") or {})
    authorize_base = cfg["authorize"]()
    # Diagnostic (no secrets/state): lets us confirm the exact authority a
    # running instance builds — e.g. catch an empty Microsoft tenant segment.
    logger.info(
        "OAuth authorize for %s: base=%s redirect_uri=%s",
        provider,
        authorize_base,
        params["redirect_uri"],
    )
    return f"{authorize_base}?{urlencode(params)}"


def consume_state(db: Session, org: Organization, provider: str, payload: dict) -> None:
    nonce = payload.get("n")
    expected = _attr(org, provider, "oauth_state")
    if not expected or not nonce or not hmac.compare_digest(str(expected), str(nonce)):
        raise MeetingOAuthError("OAuth state already used or expired — please start connecting again")
    _set_attr(org, provider, "oauth_state", None)
    db.commit()


# --------------------------------------------------------------------------- #
# Token endpoint
# --------------------------------------------------------------------------- #


def _token_request(provider: str, data: dict) -> dict:
    cfg = provider_config(provider)
    cid, csecret = _client_creds(provider)
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    if cfg["auth_style"] == "basic":
        token = base64.b64encode(f"{cid}:{csecret}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"
    else:
        data = {**data, "client_id": cid, "client_secret": csecret}
    try:
        resp = httpx.post(cfg["token"](), data=data, timeout=_HTTP_TIMEOUT, headers=headers)
    except httpx.HTTPError as exc:
        raise MeetingOAuthError(f"{cfg['label']} token network error: {exc}", transient=True) from exc
    if resp.status_code != 200:
        try:
            body = resp.json()
            msg = body.get("error_description") or body.get("error") or resp.text
        except ValueError:
            msg = resp.text
        transient = resp.status_code >= 500 or resp.status_code == 429
        raise MeetingOAuthError(
            f"{cfg['label']} rejected the token request ({resp.status_code}): {msg}",
            transient=transient,
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise MeetingOAuthError(f"{cfg['label']} returned a non-JSON token response") from exc


def exchange_code(provider: str, code: str) -> dict:
    return _token_request(provider, {
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri(provider),
        "code": code,
    })


def _fetch_account_label(provider: str, access_token: str) -> str | None:
    cfg = provider_config(provider)
    url = cfg.get("userinfo")
    if not url:
        return None
    try:
        resp = httpx.get(url, headers={"Authorization": f"Bearer {access_token}"}, timeout=_HTTP_TIMEOUT)
        if resp.status_code != 200:
            return None
        body = resp.json()
        return body.get(cfg["userinfo_field"]) or body.get("mail") or body.get("email")
    except (httpx.HTTPError, ValueError):
        return None


def _persist_tokens(db: Session, org: Organization, provider: str, body: dict) -> str:
    access = body.get("access_token")
    if not access:
        raise MeetingOAuthError(f"{provider_config(provider)['label']} did not return an access token")
    _set_attr(org, provider, "access_token_enc", encrypt(access))
    refresh = body.get("refresh_token")
    if refresh:
        _set_attr(org, provider, "refresh_token_enc", encrypt(refresh))
    expires_in = body.get("expires_in")
    try:
        lifetime = int(expires_in) if expires_in else int(get_settings().meeting_token_lifetime_seconds)
    except (ValueError, TypeError):
        lifetime = int(get_settings().meeting_token_lifetime_seconds)
    _set_attr(org, provider, "token_expires_at", datetime.now(timezone.utc) + timedelta(seconds=lifetime))
    _set_attr(org, provider, "needs_reconnect", False)
    _set_attr(org, provider, "disabled", False)
    db.commit()
    return access


def complete_connection(db: Session, org: Organization, provider: str, code: str) -> dict:
    body = exchange_code(provider, code)
    access = _persist_tokens(db, org, provider, body)
    _set_attr(org, provider, "connected_at", datetime.now(timezone.utc))
    label = _fetch_account_label(provider, access)
    if label:
        _set_attr(org, provider, "account_label", label)
    db.commit()
    return {"account_label": _attr(org, provider, "account_label")}


_label_backfill_guard = threading.Lock()
_label_backfill_attempts: dict[tuple[int, str], datetime] = {}
_LABEL_BACKFILL_RETRY = timedelta(minutes=30)


def _should_attempt_label_backfill(org_id: int, provider: str) -> bool:
    """Throttle backfill so a permanently-unfetchable label (e.g. a Zoom app
    without the user:read scope) doesn't trigger a userinfo call on every
    status poll. Only one attempt per (org, provider) per retry window."""
    key = (org_id, provider)
    now = datetime.now(timezone.utc)
    with _label_backfill_guard:
        last = _label_backfill_attempts.get(key)
        if last and now - last < _LABEL_BACKFILL_RETRY:
            return False
        _label_backfill_attempts[key] = now
        return True


def ensure_account_label(db: Session, org: Organization | None, provider: str) -> None:
    """Best-effort backfill of the connected account label/email.

    The label is captured at connect time, but connections made before that
    behaviour existed (or where the connect-time fetch failed) have no label.
    This lazily fetches it on status reads so the connected email shows up
    without forcing a reconnect. Failures are swallowed — a missing label is
    never worth surfacing an error to the caller.
    """
    if org is None or not org_connected(org, provider):
        return
    if _attr(org, provider, "account_label"):
        return
    if not _should_attempt_label_backfill(org.id, provider):
        return
    try:
        access = get_valid_access_token(db, org, provider)
        label = _fetch_account_label(provider, access)
    except (MeetingOAuthError, httpx.HTTPError):
        return
    if label:
        _set_attr(org, provider, "account_label", label)
        db.commit()


# --------------------------------------------------------------------------- #
# Token resolution + refresh (serialized per org+provider)
# --------------------------------------------------------------------------- #

_locks_guard = threading.Lock()
_locks: dict[tuple[int, str], threading.Lock] = {}


def _lock_for(org_id: int, provider: str) -> threading.Lock:
    key = (org_id, provider)
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _locks[key] = lock
        return lock


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def org_connected(org: Organization | None, provider: str) -> bool:
    if org is None:
        return False
    return bool(_attr(org, provider, "access_token_enc") and not _attr(org, provider, "needs_reconnect"))


def get_valid_access_token(db: Session, org: Organization, provider: str) -> str:
    cfg = provider_config(provider)
    if org is None or not _attr(org, provider, "access_token_enc"):
        raise MeetingOAuthError(f"This workspace has not connected {cfg['label']}")
    if _attr(org, provider, "needs_reconnect"):
        raise MeetingOAuthError(f"{cfg['label']} connection expired — please reconnect")

    now = datetime.now(timezone.utc)
    expires_at = _aware(_attr(org, provider, "token_expires_at"))
    if expires_at and expires_at - _REFRESH_BUFFER > now:
        try:
            return decrypt(_attr(org, provider, "access_token_enc"))
        except DecryptError:
            _mark_needs_reconnect(db, org, provider)
            raise MeetingOAuthError(f"Stored {cfg['label']} token could not be decrypted — please reconnect")

    with _lock_for(org.id, provider):
        db.refresh(org)
        if _attr(org, provider, "needs_reconnect"):
            raise MeetingOAuthError(f"{cfg['label']} connection expired — please reconnect")
        expires_at = _aware(_attr(org, provider, "token_expires_at"))
        if expires_at and expires_at - _REFRESH_BUFFER > now and _attr(org, provider, "access_token_enc"):
            try:
                return decrypt(_attr(org, provider, "access_token_enc"))
            except DecryptError:
                pass
        return _refresh(db, org, provider)


def _refresh(db: Session, org: Organization, provider: str) -> str:
    cfg = provider_config(provider)
    refresh_enc = _attr(org, provider, "refresh_token_enc")
    if not refresh_enc:
        _mark_needs_reconnect(db, org, provider)
        raise MeetingOAuthError(f"No {cfg['label']} refresh token on file — please reconnect")
    try:
        refresh_token = decrypt(refresh_enc)
    except DecryptError:
        _mark_needs_reconnect(db, org, provider)
        raise MeetingOAuthError(f"Stored {cfg['label']} token could not be decrypted — please reconnect")

    data = {"grant_type": "refresh_token", "refresh_token": refresh_token}
    if cfg["scopes"] and cfg["auth_style"] == "body" and cfg.get("refresh_send_scope", True):
        data["scope"] = " ".join(cfg["scopes"])
    try:
        body = _token_request(provider, data)
    except MeetingOAuthError as exc:
        if not exc.transient:
            _mark_needs_reconnect(db, org, provider)
        raise
    logger.info("Refreshed %s access token for org #%s", cfg["label"], org.id)
    return _persist_tokens(db, org, provider, body)


def _mark_needs_reconnect(db: Session, org: Organization, provider: str) -> None:
    _set_attr(org, provider, "needs_reconnect", True)
    db.commit()


# --------------------------------------------------------------------------- #
# Disconnect + status
# --------------------------------------------------------------------------- #


def disconnect(db: Session, org: Organization, provider: str) -> None:
    _set_attr(org, provider, "access_token_enc", None)
    _set_attr(org, provider, "refresh_token_enc", None)
    _set_attr(org, provider, "token_expires_at", None)
    _set_attr(org, provider, "needs_reconnect", False)
    _set_attr(org, provider, "connected_at", None)
    _set_attr(org, provider, "account_label", None)
    _set_attr(org, provider, "oauth_state", None)
    _set_attr(org, provider, "disabled", True)
    db.commit()


def status(org: Organization | None, provider: str) -> dict:
    cfg = provider_config(provider)
    connected = org_connected(org, provider)
    return {
        "provider": provider,
        "label": cfg["label"],
        "configured": oauth_configured(provider),
        "connected": connected,
        "needs_reconnect": bool(org and _attr(org, provider, "needs_reconnect")),
        "account_label": (_attr(org, provider, "account_label") if org else None),
        "connected_at": (
            _aware(_attr(org, provider, "connected_at")).isoformat()
            if org and _attr(org, provider, "connected_at") else None
        ),
    }
