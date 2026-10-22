"""HubSpot integration endpoints — per-org OAuth connection + status.

Connection model: each Organization connects its own HubSpot portal via an
OAuth public app. Access + refresh tokens are stored encrypted on the org
row. There is no shared/global token fallback — an org must connect its own
HubSpot portal to sync, and the integrations page nudges it to connect.

The OAuth callback (`/oauth/callback`) is a top-level browser redirect from
HubSpot with no bearer header, so it authenticates via the signed `state`
and lives on a separate, unprotected router (registered in main.py). Every
other endpoint here requires a bearer token (and writes require admin).

Per-conversation sync lives on the conversations router as
`POST /api/conversations/{id}/hubspot-sync`.
"""
from __future__ import annotations

import logging
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import Conversation, Organization, User
from ..services import hubspot_oauth as oauth
from .auth import require_admin, require_user

logger = logging.getLogger("concap.hubspot.router")

router = APIRouter(prefix="/api/hubspot", tags=["hubspot"])
# Public router for the OAuth callback — no bearer dependency (auth via state).
public_router = APIRouter(prefix="/api/hubspot", tags=["hubspot"])


def _org_or_none(db: Session, user: User) -> Organization | None:
    return db.get(Organization, user.org_id) if user.org_id else None


def _granular_toggles(org: Organization | None) -> dict:
    """The six per-step sync toggles, as the integrations page expects them.
    Unset (legacy) rows read as on."""
    return {
        "sync_contacts": oauth.sync_contacts_enabled(org),
        "sync_companies": oauth.sync_companies_enabled(org),
        "sync_notes": oauth.sync_notes_enabled(org),
        "sync_transcript": oauth.sync_transcript_enabled(org),
        "sync_tasks": oauth.sync_tasks_enabled(org),
        "sync_insights": oauth.sync_insights_enabled(org),
    }


def _last_sync_at(db: Session, org: Organization | None) -> str | None:
    """ISO timestamp of the most recent successful conversation sync for the
    org, or None if nothing has synced yet."""
    if org is None:
        return None
    val = db.scalar(
        select(func.max(Conversation.hubspot_synced_at)).where(Conversation.org_id == org.id)
    )
    return val.isoformat() if val else None


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

@router.get("/status")
def hubspot_status(db: Session = Depends(get_db), user: User = Depends(require_user)) -> dict:
    """Report this org's HubSpot connection state for the integrations page.
    Never exposes tokens. Each org connects its own portal via OAuth; there is
    no shared-token fallback. Covers: connected, needs-reconnect, disconnected,
    and not-connected."""
    s = get_settings()
    org = _org_or_none(db, user)
    base = {"oauth_configured": s.hubspot_oauth_configured()}

    # 1) Org connected via OAuth.
    if org is not None and org.hubspot_access_token_enc:
        if org.hubspot_needs_reconnect:
            return {
                **base,
                "connected": False,
                "needs_reconnect": True,
                "mode": "oauth",
                "portal_id": org.hubspot_portal_id,
                "auto_sync": oauth.auto_sync_enabled(org),
                "create_deals": oauth.create_deals_enabled(org),
                "reason": "HubSpot connection expired — please reconnect.",
            }
        result = {
            **base,
            "connected": True,
            "needs_reconnect": False,
            "mode": "oauth",
            "portal_id": org.hubspot_portal_id,
            "connected_at": org.hubspot_connected_at.isoformat() if org.hubspot_connected_at else None,
            "auto_sync": oauth.auto_sync_enabled(org),
            "create_deals": oauth.create_deals_enabled(org),
            "default_owner_id": oauth.default_owner_id(org),
            "last_sync_at": _last_sync_at(db, org),
            **_granular_toggles(org),
        }
        if org.hubspot_portal_id:
            result["portal_url"] = f"https://app.hubspot.com/contacts/{org.hubspot_portal_id}"
        return result

    # 1b) Org explicitly disconnected its own OAuth connection.
    if org is not None and org.hubspot_disabled:
        return {
            **base,
            "connected": False,
            "disconnected": True,
            "needs_migration": True,
            "mode": None,
            "auto_sync": oauth.auto_sync_enabled(org),
            "create_deals": oauth.create_deals_enabled(org),
            "reason": "HubSpot is disconnected for this workspace. Reconnect to resume syncing.",
        }

    # 2) Not connected — no per-org OAuth connection (no shared-token fallback);
    #    nudge the org to connect its own HubSpot portal.
    return {
        **base,
        "connected": False,
        "needs_migration": True,
        "mode": None,
        "auto_sync": True,
        "create_deals": True,
        "reason": None if base["oauth_configured"] else (
            "HubSpot OAuth is not configured on this server. "
            "An administrator must set HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET and PUBLIC_BASE_URL."
        ),
    }


# ---------------------------------------------------------------------------
# OAuth connect (start + callback)
# ---------------------------------------------------------------------------

@router.get("/oauth/start")
def hubspot_oauth_start(db: Session = Depends(get_db), user: User = Depends(require_admin)) -> dict:
    """Return the HubSpot authorize URL for the current org. The frontend
    navigates the browser to it. We return JSON rather than a 302 because
    this call is made via an authenticated fetch (bearer in the header) — a
    redirect from a fetch wouldn't carry the top-level browser navigation.

    Owner/admin only — same policy as disconnect/settings, since connecting
    rebinds the whole org's HubSpot portal."""
    org = _org_or_none(db, user)
    if org is None:
        raise HTTPException(status_code=400, detail="Your account is not attached to an organization.")
    try:
        url = oauth.authorize_url(db, org, user.id)
    except oauth.HubSpotOAuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"authorize_url": url}


def _redirect_integrations(*, connected: bool = False, error: str | None = None) -> RedirectResponse:
    params = []
    if connected:
        params.append("hubspot=connected")
    if error:
        params.append(f"hubspot_error={quote(error)}")
    suffix = ("?" + "&".join(params)) if params else ""
    return RedirectResponse(url=f"/integrations{suffix}", status_code=302)


@public_router.get("/oauth/callback")
def hubspot_oauth_callback(
    db: Session = Depends(get_db),
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
) -> RedirectResponse:
    """OAuth redirect target. Authenticated by the signed `state` (no bearer).
    Always redirects back to /integrations with a status query param so the
    page can show a toast."""
    if error:
        return _redirect_integrations(error=error)
    if not code or not state:
        return _redirect_integrations(error="Missing authorization code")
    try:
        payload = oauth.verify_state(state)
    except oauth.HubSpotOAuthError as exc:
        return _redirect_integrations(error=str(exc))

    org = db.get(Organization, int(payload.get("org", 0)))
    if org is None:
        return _redirect_integrations(error="Unknown organization")

    try:
        # Reject replays: the nonce must match the one issued at /oauth/start.
        oauth.consume_state(db, org, payload)
        oauth.complete_connection(db, org, code)
    except oauth.HubSpotOAuthError as exc:
        logger.warning("HubSpot connect failed for org #%s: %s", org.id, exc)
        return _redirect_integrations(error=str(exc))
    logger.info("HubSpot connected for org #%s", org.id)
    return _redirect_integrations(connected=True)


# ---------------------------------------------------------------------------
# Settings (per-org toggles) + disconnect
# ---------------------------------------------------------------------------

class SettingsIn(BaseModel):
    auto_sync: bool | None = None
    create_deals: bool | None = None
    sync_contacts: bool | None = None
    sync_companies: bool | None = None
    sync_notes: bool | None = None
    sync_transcript: bool | None = None
    sync_tasks: bool | None = None
    sync_insights: bool | None = None
    # Default HubSpot owner for synced Tasks. Empty string clears it (tasks
    # land unassigned); None means "leave unchanged".
    default_owner_id: str | None = None


@router.put("/settings")
def hubspot_settings(
    payload: SettingsIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    """Update this org's sync toggles. Owner/admin only."""
    org = _org_or_none(db, user)
    if org is None:
        raise HTTPException(status_code=400, detail="Your account is not attached to an organization.")
    if payload.auto_sync is not None:
        org.hubspot_auto_sync = payload.auto_sync
    if payload.create_deals is not None:
        org.hubspot_create_deals = payload.create_deals
    if payload.sync_contacts is not None:
        org.hubspot_sync_contacts = payload.sync_contacts
    if payload.sync_companies is not None:
        org.hubspot_sync_companies = payload.sync_companies
    if payload.sync_notes is not None:
        org.hubspot_sync_notes = payload.sync_notes
    if payload.sync_transcript is not None:
        org.hubspot_sync_transcript = payload.sync_transcript
    if payload.sync_tasks is not None:
        org.hubspot_sync_tasks = payload.sync_tasks
    if payload.sync_insights is not None:
        org.hubspot_sync_insights = payload.sync_insights
    if payload.default_owner_id is not None:
        # Empty string clears the assignment; otherwise store the owner id.
        org.hubspot_default_owner_id = payload.default_owner_id.strip() or None
    db.commit()
    return {
        "auto_sync": oauth.auto_sync_enabled(org),
        "create_deals": oauth.create_deals_enabled(org),
        "default_owner_id": oauth.default_owner_id(org),
        **_granular_toggles(org),
    }


@router.get("/owners")
def hubspot_owners(db: Session = Depends(get_db), user: User = Depends(require_admin)) -> dict:
    """List the connected portal's HubSpot owners so an admin can pick the
    default owner for synced Tasks. Owner/admin only (mirrors settings).

    Returns ``{owners: [{id, email, name}], default_owner_id}``. Returns a 501
    when the org hasn't connected HubSpot so the UI can nudge them to connect."""
    org = _org_or_none(db, user)
    if org is None or not org.hubspot_access_token_enc:
        raise HTTPException(status_code=501, detail="Connect HubSpot first.")

    from ..services.hubspot import (
        HubSpotError,
        _resolve_org_credentials,
        list_owners,
        use_org_context,
    )

    try:
        token, options = _resolve_org_credentials(db, org)
        with use_org_context(token, options):
            owners = list_owners()
    except HubSpotError as exc:
        raise HTTPException(status_code=exc.status_code or 502, detail=str(exc)) from exc

    return {"owners": owners, "default_owner_id": oauth.default_owner_id(org)}


# ---------------------------------------------------------------------------
# Manual backlog sync ("Sync now")
# ---------------------------------------------------------------------------

# Cap a single manual run so one click can't fan out into hundreds of HubSpot
# API calls (rate limits) or a long-blocking request.
_SYNC_ALL_LIMIT = 50


@router.post("/sync-all")
def hubspot_sync_all(
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    """Sync the org's backlog of analyzed conversations that haven't synced yet
    (or whose last sync errored), bounded per run. Owner/admin only."""
    org = _org_or_none(db, user)
    if org is None or not org.hubspot_access_token_enc:
        raise HTTPException(status_code=501, detail="Connect HubSpot first.")

    # Avoid a hard import cycle: the conversations service imports the hubspot
    # service which is fine, but keep this lazy to mirror the rest of the file.
    from ..services.hubspot import sync_conversation_safe

    stmt = (
        select(Conversation)
        .where(
            Conversation.org_id == org.id,
            Conversation.status == "analyzed",
            or_(
                Conversation.hubspot_synced_at.is_(None),
                Conversation.hubspot_sync_error.isnot(None),
            ),
        )
        .order_by(Conversation.created_at.desc())
        .limit(_SYNC_ALL_LIMIT)
    )
    convs = db.scalars(stmt).all()

    synced = 0
    failed = 0
    for conv in convs:
        result = sync_conversation_safe(db, conv.id)
        if result and result.get("ok"):
            synced += 1
        else:
            failed += 1

    return {
        "synced": synced,
        "failed": failed,
        "candidates": len(convs),
        "limit": _SYNC_ALL_LIMIT,
        "last_sync_at": _last_sync_at(db, org),
    }


@router.post("/disconnect")
def hubspot_disconnect(
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    """Disconnect this org's HubSpot. Clears the stored tokens (and best-effort
    revokes the grant at HubSpot). Owner/admin only."""
    org = _org_or_none(db, user)
    if org is not None and org.hubspot_access_token_enc:
        oauth.disconnect(db, org)
    return {"connected": False, "mode": None, "disconnected": True}


# ---------------------------------------------------------------------------
# Operator visibility into which orgs are connected vs not is provided
# server-side via `python -m app.scripts.hubspot_connections` (no tenant-facing
# API — there is no platform-operator role, so a cross-org report would leak
# other tenants' metadata to any org admin).
# ---------------------------------------------------------------------------
