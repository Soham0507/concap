"""Salesforce integration endpoints — per-org OAuth connection + status.

Connection model: each Organization connects its own Salesforce org via an
OAuth connected app. Access + refresh tokens are stored encrypted on the org
row. There is no shared/global token fallback — an org must connect its own
Salesforce org to sync, and the integrations page nudges it to connect.

The OAuth callback (`/oauth/callback`) is a top-level browser redirect from
Salesforce with no bearer header, so it authenticates via the signed `state`
and lives on a separate, unprotected router (registered in main.py). Every
other endpoint here requires a bearer token (and writes require admin).

Per-conversation sync lives on the conversations router as
`POST /api/conversations/{id}/salesforce-sync`.
"""
from __future__ import annotations

import logging
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import Organization, User
from ..services import salesforce_oauth as oauth
from .auth import require_admin, require_user

logger = logging.getLogger("concap.salesforce.router")

router = APIRouter(prefix="/api/salesforce", tags=["salesforce"])
# Public router for the OAuth callback — no bearer dependency (auth via state).
public_router = APIRouter(prefix="/api/salesforce", tags=["salesforce"])


def _org_or_none(db: Session, user: User) -> Organization | None:
    return db.get(Organization, user.org_id) if user.org_id else None


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

@router.get("/status")
def salesforce_status(db: Session = Depends(get_db), user: User = Depends(require_user)) -> dict:
    """Report this org's Salesforce connection state for the integrations page.
    Never exposes tokens. Each org connects its own org via OAuth; there is no
    shared-token fallback. Covers: connected, needs-reconnect, disconnected,
    and not-connected."""
    s = get_settings()
    org = _org_or_none(db, user)
    base = {"oauth_configured": s.salesforce_oauth_configured()}

    # 1) Org connected via OAuth.
    if org is not None and org.salesforce_access_token_enc:
        if org.salesforce_needs_reconnect:
            return {
                **base,
                "connected": False,
                "needs_reconnect": True,
                "mode": "oauth",
                "org_id": org.salesforce_org_id,
                "auto_sync": oauth.auto_sync_enabled(org),
                "create_opportunities": oauth.create_opportunities_enabled(org),
                "reason": "Salesforce connection expired — please reconnect.",
            }
        result = {
            **base,
            "connected": True,
            "needs_reconnect": False,
            "mode": "oauth",
            "org_id": org.salesforce_org_id,
            "instance_url": org.salesforce_instance_url,
            "connected_at": org.salesforce_connected_at.isoformat() if org.salesforce_connected_at else None,
            "auto_sync": oauth.auto_sync_enabled(org),
            "create_opportunities": oauth.create_opportunities_enabled(org),
        }
        return result

    # 1b) Org explicitly disconnected its own OAuth connection.
    if org is not None and org.salesforce_disabled:
        return {
            **base,
            "connected": False,
            "disconnected": True,
            "needs_migration": True,
            "mode": None,
            "auto_sync": oauth.auto_sync_enabled(org),
            "create_opportunities": oauth.create_opportunities_enabled(org),
            "reason": "Salesforce is disconnected for this workspace. Reconnect to resume syncing.",
        }

    # 2) Not connected — no per-org OAuth connection (no shared-token fallback);
    #    nudge the org to connect its own Salesforce org.
    return {
        **base,
        "connected": False,
        "needs_migration": True,
        "mode": None,
        "auto_sync": True,
        "create_opportunities": True,
        "reason": None if base["oauth_configured"] else (
            "Salesforce OAuth is not configured on this server. "
            "An administrator must set SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET and PUBLIC_BASE_URL."
        ),
    }


# ---------------------------------------------------------------------------
# OAuth connect (start + callback)
# ---------------------------------------------------------------------------

@router.get("/oauth/start")
def salesforce_oauth_start(db: Session = Depends(get_db), user: User = Depends(require_admin)) -> dict:
    """Return the Salesforce authorize URL for the current org. The frontend
    navigates the browser to it. We return JSON rather than a 302 because
    this call is made via an authenticated fetch (bearer in the header) — a
    redirect from a fetch wouldn't carry the top-level browser navigation.

    Owner/admin only — same policy as disconnect/settings, since connecting
    rebinds the whole org's Salesforce org."""
    org = _org_or_none(db, user)
    if org is None:
        raise HTTPException(status_code=400, detail="Your account is not attached to an organization.")
    try:
        url = oauth.authorize_url(db, org, user.id)
    except oauth.SalesforceOAuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"authorize_url": url}


def _redirect_integrations(*, connected: bool = False, error: str | None = None) -> RedirectResponse:
    params = []
    if connected:
        params.append("salesforce=connected")
    if error:
        params.append(f"salesforce_error={quote(error)}")
    suffix = ("?" + "&".join(params)) if params else ""
    return RedirectResponse(url=f"/integrations{suffix}", status_code=302)


@public_router.get("/oauth/callback")
def salesforce_oauth_callback(
    db: Session = Depends(get_db),
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    error_description: str | None = Query(default=None),
) -> RedirectResponse:
    """OAuth redirect target. Authenticated by the signed `state` (no bearer).
    Always redirects back to /integrations with a status query param so the
    page can show a toast."""
    if error:
        return _redirect_integrations(error=error_description or error)
    if not code or not state:
        return _redirect_integrations(error="Missing authorization code")
    try:
        payload = oauth.verify_state(state)
    except oauth.SalesforceOAuthError as exc:
        return _redirect_integrations(error=str(exc))

    org = db.get(Organization, int(payload.get("org", 0)))
    if org is None:
        return _redirect_integrations(error="Unknown organization")

    try:
        # Reject replays: the nonce must match the one issued at /oauth/start.
        oauth.consume_state(db, org, payload)
        oauth.complete_connection(db, org, code)
    except oauth.SalesforceOAuthError as exc:
        logger.warning("Salesforce connect failed for org #%s: %s", org.id, exc)
        return _redirect_integrations(error=str(exc))
    logger.info("Salesforce connected for org #%s", org.id)
    return _redirect_integrations(connected=True)


# ---------------------------------------------------------------------------
# Settings (per-org toggles) + disconnect
# ---------------------------------------------------------------------------

class SettingsIn(BaseModel):
    auto_sync: bool | None = None
    create_opportunities: bool | None = None


@router.put("/settings")
def salesforce_settings(
    payload: SettingsIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    """Update this org's sync toggles. Owner/admin only."""
    org = _org_or_none(db, user)
    if org is None:
        raise HTTPException(status_code=400, detail="Your account is not attached to an organization.")
    if payload.auto_sync is not None:
        org.salesforce_auto_sync = payload.auto_sync
    if payload.create_opportunities is not None:
        org.salesforce_create_opportunities = payload.create_opportunities
    db.commit()
    return {
        "auto_sync": oauth.auto_sync_enabled(org),
        "create_opportunities": oauth.create_opportunities_enabled(org),
    }


@router.post("/disconnect")
def salesforce_disconnect(
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    """Disconnect this org's Salesforce. Clears the stored tokens (and best-effort
    revokes the grant at Salesforce). Owner/admin only."""
    org = _org_or_none(db, user)
    if org is not None and org.salesforce_access_token_enc:
        oauth.disconnect(db, org)
    return {"connected": False, "mode": None, "disconnected": True}
