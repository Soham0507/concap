"""HubSpot CRM client + sync orchestration.

This module talks to HubSpot's v3 CRM API using the organization's own
per-org OAuth access token (bound for the duration of a sync via
`use_org_context`). The public entry point is
`sync_conversation(db, conversation)` — it upserts the contact (and
backing company), creates a note engagement with the transcript +
analysis, and optionally creates a deal in the default pipeline. There is
no shared global token: an org that hasn't connected its own HubSpot portal
cannot sync.

Design notes
------------
* Idempotent. Repeated calls update HubSpot's existing record instead of
  creating duplicates: we cache the HubSpot ids on our own rows
  (`visitor.hubspot_contact_id`, `company.hubspot_company_id`,
  `conversation.hubspot_note_id` / `hubspot_deal_id`) and fall back to
  the search API (by email -> phone for contacts, by domain -> name for
  companies) when no cached id exists.
* Tolerant of partial data. Visitors without an email/phone still produce
  a contact (HubSpot allows it, we just send what we have). Companies
  without a website become a name-only search. Missing analysis fields
  are omitted from the note rather than rendered as "None".
* Failure is loud but contained. Network/HTTP errors raise
  `HubSpotError`. The caller decides whether that crashes the request
  (manual /hubspot-sync click) or just logs (auto-sync after pipeline).
"""
from __future__ import annotations

import contextlib
import contextvars
import hashlib
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

import httpx
from sqlalchemy.orm import Session

from ..models import Company, Conversation, Organization, Visitor

logger = logging.getLogger("booth.hubspot")

API_BASE = "https://api.hubapi.com"
PORTAL_BASE = "https://app.hubspot.com"
DEFAULT_TIMEOUT = httpx.Timeout(30.0, connect=10.0)

class HubSpotError(RuntimeError):
    """Raised on any non-recoverable HubSpot API failure.

    `status_code` is the HTTP status from HubSpot (or 0 if we never got a
    response). `payload` is the parsed response body when available.
    """

    def __init__(self, message: str, *, status_code: int = 0, payload: Any = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


class HubSpotNotConfigured(HubSpotError):
    """No usable HubSpot connection for this org (not connected, or its
    OAuth connection needs reconnecting). The caller should surface this as
    a 501/clear UI message nudging the org to connect, not a crash."""

    def __init__(self, message: str | None = None) -> None:
        super().__init__(
            message or "HubSpot is not connected. Connect HubSpot from Integrations.",
            status_code=501,
        )


# ---------------------------------------------------------------------------
# Low-level HTTP wrapper
# ---------------------------------------------------------------------------


# Per-org context for a single sync. When `sync_conversation` resolves an
# organization's OAuth access token it sets these so the ~25 internal
# `_request` call sites pick up the right token without being rewritten.
# There is no shared/global token fallback — a sync without a bound token
# raises HubSpotNotConfigured.
_access_token_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "hubspot_access_token", default=None
)
# Per-sync options dict (create_deals + the granular sync_* toggles). Bound by
# `use_org_context` and read by `_opt` so the individual sync steps can gate
# themselves without threading the org through every helper.
_sync_options_ctx: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "hubspot_sync_options", default=None
)


@contextlib.contextmanager
def use_org_context(access_token: str | None, options: dict | bool | None = None):
    """Bind a per-org OAuth access token (and the sync options) for the
    duration of a sync. Every sync must bind a real token — there is no
    global/shared token fallback.

    `options` is a dict of toggles (``create_deals`` plus the granular
    ``sync_contacts``/``sync_companies``/``sync_notes``/``sync_transcript``/
    ``sync_tasks``/``sync_insights``). For backward compatibility a bare bool
    is accepted and treated as ``{"create_deals": <bool>}``."""
    if isinstance(options, bool):
        options = {"create_deals": options}
    tok_reset = _access_token_ctx.set(access_token)
    opt_reset = _sync_options_ctx.set(options or {})
    try:
        yield
    finally:
        _access_token_ctx.reset(tok_reset)
        _sync_options_ctx.reset(opt_reset)


def _token() -> str:
    # The per-org OAuth token must be bound (by sync_conversation) for any
    # HubSpot call. There is no global/shared token fallback.
    ctx_token = _access_token_ctx.get()
    if ctx_token:
        return ctx_token
    raise HubSpotNotConfigured()


def _opt(name: str, default: bool = True) -> bool:
    """Read one of the per-sync toggles bound for this sync. Unbound/None
    reads as `default` (the granular sync_* toggles default on)."""
    opts = _sync_options_ctx.get() or {}
    val = opts.get(name)
    return default if val is None else bool(val)


def _create_deals_active() -> bool:
    """Whether this sync should upsert deals — the per-org toggle bound for
    this sync. Defaults to off when nothing is bound."""
    return _opt("create_deals", False)


def _default_owner_id() -> str | None:
    """The configured default HubSpot owner id for this sync (assigned to
    synced Tasks), or None when no owner is configured for the org."""
    opts = _sync_options_ctx.get() or {}
    val = opts.get("default_owner_id")
    return str(val) if val else None


def _resolve_org_credentials(db: Session, org: Organization | None) -> tuple[str, dict]:
    """Resolve the access token + sync options for a sync.

    Returns ``(access_token, options)`` for an org connected via its own
    OAuth: its (refreshed) token + the per-org sync toggles. Every sync runs
    against the org's own OAuth connection — there is no shared/global token
    fallback.

    Raises HubSpotNotConfigured when the org hasn't connected its own HubSpot
    portal (or its connection needs reconnecting), so the caller surfaces a
    clean 501 directing them to connect."""
    from .hubspot_oauth import (
        HubSpotOAuthError,
        create_deals_enabled,
        default_owner_id,
        get_valid_access_token,
        sync_companies_enabled,
        sync_contacts_enabled,
        sync_insights_enabled,
        sync_notes_enabled,
        sync_tasks_enabled,
        sync_transcript_enabled,
    )

    if org is not None and org.hubspot_access_token_enc:
        try:
            token = get_valid_access_token(db, org)
        except HubSpotOAuthError as exc:
            raise HubSpotNotConfigured(str(exc)) from exc
        options = {
            "create_deals": create_deals_enabled(org),
            "sync_contacts": sync_contacts_enabled(org),
            "sync_companies": sync_companies_enabled(org),
            "sync_notes": sync_notes_enabled(org),
            "sync_transcript": sync_transcript_enabled(org),
            "sync_tasks": sync_tasks_enabled(org),
            "sync_insights": sync_insights_enabled(org),
            "default_owner_id": default_owner_id(org),
        }
        return token, options

    raise HubSpotNotConfigured(
        "This workspace hasn't connected HubSpot. Connect your own HubSpot "
        "portal from Integrations to enable syncing."
    )


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=API_BASE,
        timeout=DEFAULT_TIMEOUT,
        headers={
            "Authorization": f"Bearer {_token()}",
            "Content-Type": "application/json",
        },
    )


def _request(method: str, path: str, *, json: Any = None, params: dict | None = None) -> Any:
    """Issue an authenticated HubSpot call. Returns parsed JSON (or None
    on 204). Maps non-2xx into HubSpotError with the body attached so the
    caller can show HubSpot's own diagnostic message in the UI."""
    with _client() as c:
        try:
            resp = c.request(method, path, json=json, params=params)
        except httpx.HTTPError as exc:
            raise HubSpotError(f"HubSpot network error: {exc}", status_code=0) from exc

    if resp.status_code == 204 or not resp.content:
        return None
    try:
        body = resp.json()
    except ValueError:
        body = {"raw": resp.text}

    if resp.is_success:
        return body

    # HubSpot returns useful messages in `message` and `errors`. Surface them.
    msg = body.get("message") if isinstance(body, dict) else None
    detail = msg or f"HubSpot API {resp.status_code} on {method} {path}"
    logger.warning("HubSpot error %s %s -> %s", method, path, body)
    raise HubSpotError(detail, status_code=resp.status_code, payload=body)


# ---------------------------------------------------------------------------
# Helpers — domain extraction, name splitting, stage mapping
# ---------------------------------------------------------------------------


def _split_name(full: str | None) -> tuple[str, str]:
    if not full:
        return "", ""
    parts = [p for p in re.split(r"\s+", full.strip()) if p]
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def _extract_domain(website: str | None, email: str | None = None) -> str | None:
    """Best-effort domain for company dedup. Tries the website first
    (with or without scheme), then the email host. Strips `www.` so
    `acme.com` and `www.acme.com` collapse to the same key.
    """
    candidate = (website or "").strip()
    if candidate:
        if "://" not in candidate:
            candidate = f"http://{candidate}"
        host = urlparse(candidate).hostname or ""
        host = host.lower().lstrip(".")
        if host.startswith("www."):
            host = host[4:]
        if host:
            return host
    if email and "@" in email:
        host = email.split("@", 1)[1].strip().lower()
        # Filter out the obvious freemail providers — they're never the
        # company's own domain and produce nonsense merges.
        if host and host not in _FREE_EMAIL_DOMAINS:
            return host
    return None


# HubSpot's `industry` property is a strict enum on contacts and (with a
# slightly different list) on companies. Sending an off-list value 400s
# the entire upsert. We map common free-text industries we see in scans
# and manual entry to the canonical enum codes; anything we don't
# recognize is dropped from the payload (we never blank the field — just
# omit it so HubSpot keeps whatever the user already set there).
_HUBSPOT_INDUSTRY_MAP = {
    # Tech
    "information technology": "INFORMATION_TECHNOLOGY_AND_SERVICES",
    "it": "INFORMATION_TECHNOLOGY_AND_SERVICES",
    "it services": "INFORMATION_TECHNOLOGY_AND_SERVICES",
    "information technology and services": "INFORMATION_TECHNOLOGY_AND_SERVICES",
    "tech": "COMPUTER_SOFTWARE",
    "technology": "COMPUTER_SOFTWARE",
    "software": "COMPUTER_SOFTWARE",
    "saas": "COMPUTER_SOFTWARE",
    "computer software": "COMPUTER_SOFTWARE",
    "internet": "INTERNET",
    "computer hardware": "COMPUTER_HARDWARE",
    "computer networking": "COMPUTER_NETWORKING",
    "semiconductors": "SEMICONDUCTORS",
    "telecom": "TELECOMMUNICATIONS",
    "telecommunications": "TELECOMMUNICATIONS",
    "cybersecurity": "COMPUTER_NETWORK_SECURITY",
    "security": "COMPUTER_NETWORK_SECURITY",
    "ai": "COMPUTER_SOFTWARE",
    "artificial intelligence": "COMPUTER_SOFTWARE",
    # Manufacturing & industrial
    "manufacturing": "MECHANICAL_OR_INDUSTRIAL_ENGINEERING",
    "industrial": "MECHANICAL_OR_INDUSTRIAL_ENGINEERING",
    "machinery": "MACHINERY",
    "automotive": "AUTOMOTIVE",
    "chemicals": "CHEMICALS",
    "construction": "CONSTRUCTION",
    "electrical": "ELECTRICAL_ELECTRONIC_MANUFACTURING",
    "electronics": "ELECTRICAL_ELECTRONIC_MANUFACTURING",
    "aerospace": "AVIATION_AEROSPACE",
    "aviation": "AVIATION_AEROSPACE",
    # Finance
    "banking": "BANKING",
    "finance": "FINANCIAL_SERVICES",
    "financial services": "FINANCIAL_SERVICES",
    "fintech": "FINANCIAL_SERVICES",
    "insurance": "INSURANCE",
    "investment banking": "INVESTMENT_BANKING",
    "venture capital": "VENTURE_CAPITAL_PRIVATE_EQUITY",
    "private equity": "VENTURE_CAPITAL_PRIVATE_EQUITY",
    "accounting": "ACCOUNTING",
    # Healthcare
    "healthcare": "HOSPITAL_HEALTH_CARE",
    "health care": "HOSPITAL_HEALTH_CARE",
    "hospital": "HOSPITAL_HEALTH_CARE",
    "pharma": "PHARMACEUTICALS",
    "pharmaceuticals": "PHARMACEUTICALS",
    "biotech": "BIOTECHNOLOGY",
    "biotechnology": "BIOTECHNOLOGY",
    "medical devices": "MEDICAL_DEVICES",
    # Retail / consumer
    "retail": "RETAIL",
    "ecommerce": "RETAIL",
    "e-commerce": "RETAIL",
    "consumer goods": "CONSUMER_GOODS",
    "fashion": "APPAREL_FASHION",
    "apparel": "APPAREL_FASHION",
    "food": "FOOD_AND_BEVERAGES",
    "food and beverage": "FOOD_AND_BEVERAGES",
    "hospitality": "HOSPITALITY",
    "restaurant": "RESTAURANTS",
    "restaurants": "RESTAURANTS",
    # Services
    "consulting": "MANAGEMENT_CONSULTING",
    "management consulting": "MANAGEMENT_CONSULTING",
    "marketing": "MARKETING_AND_ADVERTISING",
    "advertising": "MARKETING_AND_ADVERTISING",
    "media": "MEDIA_PRODUCTION",
    "publishing": "PUBLISHING",
    "law": "LAW_PRACTICE",
    "legal": "LEGAL_SERVICES",
    "real estate": "REAL_ESTATE",
    "logistics": "LOGISTICS_AND_SUPPLY_CHAIN",
    "supply chain": "LOGISTICS_AND_SUPPLY_CHAIN",
    "transportation": "TRANSPORTATION_TRUCKING_RAILROAD",
    "shipping": "MARITIME",
    "human resources": "HUMAN_RESOURCES",
    "staffing": "STAFFING_AND_RECRUITING",
    "recruiting": "STAFFING_AND_RECRUITING",
    # Education & public
    "education": "EDUCATION_MANAGEMENT",
    "higher education": "HIGHER_EDUCATION",
    "research": "RESEARCH",
    "government": "GOVERNMENT_ADMINISTRATION",
    "nonprofit": "NON_PROFIT_ORGANIZATION_MANAGEMENT",
    "non-profit": "NON_PROFIT_ORGANIZATION_MANAGEMENT",
    # Energy
    "energy": "OIL_AND_ENERGY",
    "oil and gas": "OIL_AND_ENERGY",
    "renewable energy": "RENEWABLES_ENVIRONMENT",
    "utilities": "UTILITIES",
    # Travel
    "travel": "LEISURE_TRAVEL_AND_TOURISM",
    "tourism": "LEISURE_TRAVEL_AND_TOURISM",
    "airlines": "AIRLINES_AVIATION",
}


def _map_industry(value: str | None) -> str | None:
    """Return a HubSpot-enum-valid industry code, or None if we don't
    know how to map this string. Caller should omit the field when None."""
    if not value:
        return None
    key = value.strip().lower()
    return _HUBSPOT_INDUSTRY_MAP.get(key)


_FREE_EMAIL_DOMAINS = {
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk",
    "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com",
    "aol.com", "proton.me", "protonmail.com", "msn.com", "rediffmail.com",
}


def _temperature_to_stage(temp: str | None) -> str | None:
    """Map our lead temperature to HubSpot's default-pipeline stage ids.
    Returns None when no opinionated mapping applies (we'll fall back to
    the pipeline default by omitting the field)."""
    if not temp:
        return None
    t = temp.strip().lower()
    return {
        "hot": "qualifiedtobuy",
        "warm": "appointmentscheduled",
        "cold": "appointmentscheduled",
    }.get(t)


def _portal_id_from_response(body: Any) -> str | None:
    """Try to find the portal id buried in HubSpot's audit metadata so we
    can build clickable URLs back to the record in the HubSpot UI."""
    if not isinstance(body, dict):
        return None
    for key in ("portalId", "hubId"):
        if key in body:
            return str(body[key])
    return None


def _contact_url(portal_id: str | None, contact_id: str) -> str | None:
    if not portal_id:
        return None
    return f"{PORTAL_BASE}/contacts/{portal_id}/contact/{contact_id}"


def _company_url(portal_id: str | None, company_id: str) -> str | None:
    if not portal_id:
        return None
    return f"{PORTAL_BASE}/contacts/{portal_id}/company/{company_id}"


def _deal_url(portal_id: str | None, deal_id: str) -> str | None:
    if not portal_id:
        return None
    return f"{PORTAL_BASE}/contacts/{portal_id}/deal/{deal_id}"


# ---------------------------------------------------------------------------
# Account / status
# ---------------------------------------------------------------------------


def get_account_info() -> dict:
    """Return basic portal info — used by /api/hubspot/status to confirm
    the token is valid and surface the portal name/email in the UI."""
    info = _request("GET", "/account-info/v3/details")
    return {
        "portal_id": info.get("portalId") if isinstance(info, dict) else None,
        "account_type": info.get("accountType") if isinstance(info, dict) else None,
        "time_zone": info.get("timeZone") if isinstance(info, dict) else None,
        "company_currency": info.get("companyCurrency") if isinstance(info, dict) else None,
        "utc_offset": info.get("utcOffset") if isinstance(info, dict) else None,
        "ui_domain": info.get("uiDomain") if isinstance(info, dict) else None,
    }


def list_owners() -> list[dict]:
    """Return the portal's active HubSpot owners (the reps a Task can be
    assigned to). Each item is ``{id, email, name}``. Paginates through the
    owners API; inactive/archived owners are excluded by default.

    Requires the ``crm.objects.owners.read`` scope (in our OAuth scope set).
    """
    owners: list[dict] = []
    after: str | None = None
    # Safety cap so a pathological portal can't loop forever / return megabytes.
    for _ in range(20):
        params: dict[str, Any] = {"limit": 100}
        if after:
            params["after"] = after
        body = _request("GET", "/crm/v3/owners", params=params) or {}
        for o in (body.get("results") or []):
            oid = str(o.get("id") or "")
            if not oid:
                continue
            first = (o.get("firstName") or "").strip()
            last = (o.get("lastName") or "").strip()
            name = " ".join(p for p in (first, last) if p).strip()
            email = (o.get("email") or "").strip()
            owners.append({
                "id": oid,
                "email": email,
                "name": name or email or f"Owner {oid}",
            })
        after = (((body.get("paging") or {}).get("next") or {}).get("after"))
        if not after:
            break
    return owners


# ---------------------------------------------------------------------------
# Company upsert
# ---------------------------------------------------------------------------


def _company_properties(company: Company) -> dict:
    """Map our Company row -> HubSpot company properties.
    Only includes non-empty fields so we never blank out manually-edited
    HubSpot values with our nulls."""
    domain = _extract_domain(company.website, company.email)
    props: dict[str, Any] = {}
    if company.name:
        props["name"] = company.name
    if domain:
        props["domain"] = domain
    if company.website:
        props["website"] = company.website
    if company.phone:
        props["phone"] = company.phone
    mapped_industry = _map_industry(company.industry)
    if mapped_industry:
        props["industry"] = mapped_industry
    if company.address:
        props["address"] = company.address[:200]
    if company.city:
        props["city"] = company.city
    if company.state:
        props["state"] = company.state
    if company.country:
        props["country"] = company.country
    return props


def _search_company_id(domain: str | None, name: str | None) -> str | None:
    """Find an existing HubSpot company id by domain (preferred) or
    case-insensitive name. Returns None when no match."""
    if domain:
        body = _request(
            "POST",
            "/crm/v3/objects/companies/search",
            json={
                "filterGroups": [{"filters": [{"propertyName": "domain", "operator": "EQ", "value": domain}]}],
                "properties": ["domain", "name"],
                "limit": 1,
            },
        )
        results = (body or {}).get("results") or []
        if results:
            return str(results[0]["id"])
    if name:
        body = _request(
            "POST",
            "/crm/v3/objects/companies/search",
            json={
                "filterGroups": [{"filters": [{"propertyName": "name", "operator": "EQ", "value": name}]}],
                "properties": ["domain", "name"],
                "limit": 1,
            },
        )
        results = (body or {}).get("results") or []
        if results:
            return str(results[0]["id"])
    return None


def upsert_company(db: Session, company: Company | None) -> str | None:
    """Create-or-update a HubSpot company. Returns the HubSpot id, or
    None if `company` is None or has no usable identifiers."""
    if company is None:
        return None
    props = _company_properties(company)
    if not props.get("name") and not props.get("domain"):
        return None  # nothing to identify it with

    # 1) Cached id from a prior sync — fast path.
    if company.hubspot_company_id:
        try:
            _request(
                "PATCH",
                f"/crm/v3/objects/companies/{company.hubspot_company_id}",
                json={"properties": props},
            )
            company.hubspot_synced_at = datetime.now(timezone.utc)
            db.commit()
            return company.hubspot_company_id
        except HubSpotError as exc:
            # 404 -> the cached id was deleted in HubSpot. Fall through to
            # search/create. For any other error, propagate.
            if exc.status_code != 404:
                raise
            company.hubspot_company_id = None

    # 2) Search by domain then name to avoid creating a duplicate.
    domain = props.get("domain")
    found = _search_company_id(domain, props.get("name"))
    if found:
        _request("PATCH", f"/crm/v3/objects/companies/{found}", json={"properties": props})
        company.hubspot_company_id = found
        company.hubspot_synced_at = datetime.now(timezone.utc)
        db.commit()
        return found

    # 3) Create.
    created = _request("POST", "/crm/v3/objects/companies", json={"properties": props}) or {}
    new_id = str(created.get("id") or "")
    if not new_id:
        raise HubSpotError("HubSpot did not return a company id on create", payload=created)
    company.hubspot_company_id = new_id
    company.hubspot_synced_at = datetime.now(timezone.utc)
    db.commit()
    return new_id


# ---------------------------------------------------------------------------
# Contact upsert
# ---------------------------------------------------------------------------


def _contact_properties(visitor: Visitor) -> dict:
    first, last = _split_name(visitor.name)
    props: dict[str, Any] = {}
    if first:
        props["firstname"] = first
    if last:
        props["lastname"] = last
    if visitor.email:
        props["email"] = visitor.email.strip().lower()
    if visitor.phone:
        props["phone"] = visitor.phone
    if visitor.designation:
        props["jobtitle"] = visitor.designation
    if visitor.company:
        props["company"] = visitor.company
    mapped_industry = _map_industry(visitor.industry)
    if mapped_industry:
        props["industry"] = mapped_industry
    if visitor.website:
        props["website"] = visitor.website
    if visitor.address:
        props["address"] = visitor.address[:200]
    if visitor.interest_category:
        # Stuff into HubSpot's "hs_content_membership_notes" wouldn't be
        # right; use the standard "hs_lead_status" or just leave it on
        # our note. Keeping out for now — surfaced in the note body.
        pass
    # Tag where the contact came from for filtering in HubSpot.
    props["hs_analytics_source"] = "OTHER_CAMPAIGNS"
    return props


def _search_contact_id(email: str | None, phone: str | None) -> str | None:
    if email:
        body = _request(
            "POST",
            "/crm/v3/objects/contacts/search",
            json={
                "filterGroups": [{"filters": [{"propertyName": "email", "operator": "EQ", "value": email.lower()}]}],
                "properties": ["email", "phone"],
                "limit": 1,
            },
        )
        results = (body or {}).get("results") or []
        if results:
            return str(results[0]["id"])
    if phone:
        body = _request(
            "POST",
            "/crm/v3/objects/contacts/search",
            json={
                "filterGroups": [{"filters": [{"propertyName": "phone", "operator": "EQ", "value": phone}]}],
                "properties": ["email", "phone"],
                "limit": 1,
            },
        )
        results = (body or {}).get("results") or []
        if results:
            return str(results[0]["id"])
    return None


def upsert_contact(db: Session, visitor: Visitor) -> str:
    """Create-or-update a HubSpot contact for the visitor. Returns the
    HubSpot contact id. Raises HubSpotError on failure or when the
    visitor has no usable identifier (HubSpot won't accept it)."""
    props = _contact_properties(visitor)
    if not props.get("email") and not props.get("phone") and not (
        props.get("firstname") or props.get("lastname")
    ):
        raise HubSpotError("Visitor has no name, email, or phone to identify in HubSpot.", status_code=400)

    # 1) Cached id.
    if visitor.hubspot_contact_id:
        try:
            _request(
                "PATCH",
                f"/crm/v3/objects/contacts/{visitor.hubspot_contact_id}",
                json={"properties": props},
            )
            visitor.hubspot_synced_at = datetime.now(timezone.utc)
            db.commit()
            return visitor.hubspot_contact_id
        except HubSpotError as exc:
            if exc.status_code != 404:
                raise
            visitor.hubspot_contact_id = None

    # 2) Search.
    found = _search_contact_id(props.get("email"), props.get("phone"))
    if found:
        _request("PATCH", f"/crm/v3/objects/contacts/{found}", json={"properties": props})
        visitor.hubspot_contact_id = found
        visitor.hubspot_synced_at = datetime.now(timezone.utc)
        db.commit()
        return found

    # 3) Create.
    created = _request("POST", "/crm/v3/objects/contacts", json={"properties": props}) or {}
    new_id = str(created.get("id") or "")
    if not new_id:
        raise HubSpotError("HubSpot did not return a contact id on create", payload=created)
    visitor.hubspot_contact_id = new_id
    visitor.hubspot_synced_at = datetime.now(timezone.utc)
    db.commit()
    return new_id


# ---------------------------------------------------------------------------
# Associations (contact <-> company)
# ---------------------------------------------------------------------------


def associate_contact_to_company(contact_id: str, company_id: str) -> None:
    """Idempotent association — HubSpot returns 200 even if the link
    already exists. Uses the default labelled association
    ("contact_to_company")."""
    try:
        _request(
            "PUT",
            f"/crm/v3/objects/contacts/{contact_id}/associations/companies/{company_id}/contact_to_company",
        )
    except HubSpotError as exc:
        # Don't blow up the whole sync over an association quirk.
        logger.warning("HubSpot association contact %s -> company %s failed: %s", contact_id, company_id, exc)


# ---------------------------------------------------------------------------
# Notes (engagement) from the transcript + analysis
# ---------------------------------------------------------------------------


def _build_note_html(conv: Conversation, *, include_transcript: bool = True) -> str:
    """Render a rich HTML note body for HubSpot from our analysis blob +
    transcript. HubSpot's note editor accepts inline HTML. When
    `include_transcript` is False the raw transcript block is omitted (the
    summary/insights are always kept)."""
    a = conv.analysis or {}
    lines: list[str] = []
    lines.append(f"<p><strong>Concap booth conversation #{conv.id}</strong></p>")
    meta_bits = []
    if conv.created_at:
        meta_bits.append(conv.created_at.strftime("%Y-%m-%d %H:%M UTC"))
    if conv.event_name:
        meta_bits.append(conv.event_name)
    if conv.booth_name:
        meta_bits.append(conv.booth_name)
    if conv.staff_name:
        meta_bits.append(f"Staff: {conv.staff_name}")
    if meta_bits:
        lines.append(f"<p><em>{' · '.join(meta_bits)}</em></p>")

    score_bits = []
    if conv.lead_score is not None:
        score_bits.append(f"Lead score: <strong>{conv.lead_score}/100</strong>")
    if conv.lead_temperature:
        score_bits.append(f"Temperature: <strong>{conv.lead_temperature.title()}</strong>")
    if a.get("urgency"):
        score_bits.append(f"Urgency: {a['urgency']}")
    if a.get("timeline"):
        score_bits.append(f"Timeline: {a['timeline']}")
    if a.get("budget_range"):
        score_bits.append(f"Budget: {a['budget_range']}")
    if score_bits:
        lines.append("<p>" + " · ".join(score_bits) + "</p>")

    if a.get("summary"):
        lines.append(f"<p><strong>Summary</strong><br/>{_escape(a['summary'])}</p>")

    if a.get("intent"):
        lines.append(f"<p><strong>Intent:</strong> {_escape(a['intent'])}</p>")

    for label, key in (
        ("Products discussed", "products_discussed"),
        ("Pain points", "pain_points"),
        ("Competitors mentioned", "competitors_mentioned"),
    ):
        items = a.get(key) or []
        if items:
            lis = "".join(f"<li>{_escape(str(x))}</li>" for x in items)
            lines.append(f"<p><strong>{label}</strong></p><ul>{lis}</ul>")

    if a.get("next_action"):
        lines.append(f"<p><strong>Next action:</strong> {_escape(a['next_action'])}</p>")

    actions = a.get("action_items") or []
    if actions:
        lis = "".join(f"<li>{_escape(str(x))}</li>" for x in actions)
        lines.append(f"<p><strong>Action items</strong></p><ul>{lis}</ul>")

    quotes = a.get("key_quotes") or []
    if quotes:
        items = "".join(f'<blockquote>"{_escape(str(q))}"</blockquote>' for q in quotes)
        lines.append(f"<p><strong>Key quotes</strong></p>{items}")

    if include_transcript and conv.transcript:
        # HubSpot caps note bodies around 65k chars. Truncate the
        # transcript to keep headroom for the formatted analysis.
        snippet = conv.transcript[:40_000]
        if len(conv.transcript) > 40_000:
            snippet += "\n\n…[transcript truncated]"
        lines.append(
            "<p><strong>Transcript</strong></p>"
            f"<pre style='white-space: pre-wrap; font-family: ui-monospace, monospace;'>{_escape(snippet)}</pre>"
        )

    return "\n".join(lines)


def _escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def create_or_update_note(
    db: Session,
    conv: Conversation,
    *,
    contact_id: str | None,
    company_id: str | None,
    include_transcript: bool = True,
) -> str | None:
    """Create (or update if already mirrored) a HubSpot note engagement
    summarising the transcript. Associated to the contact + company."""
    body = _build_note_html(conv, include_transcript=include_transcript)
    ts_ms = int((conv.created_at or datetime.now(timezone.utc)).timestamp() * 1000)
    props = {
        "hs_note_body": body,
        "hs_timestamp": ts_ms,
    }
    # Update path — reuse the existing note so re-syncs don't duplicate.
    if conv.hubspot_note_id:
        try:
            _request(
                "PATCH",
                f"/crm/v3/objects/notes/{conv.hubspot_note_id}",
                json={"properties": props},
            )
            return conv.hubspot_note_id
        except HubSpotError as exc:
            if exc.status_code != 404:
                raise
            conv.hubspot_note_id = None

    # Build the create payload with inline associations so the note is
    # linked to the contact + company atomically (no follow-up PUTs).
    associations = []
    if contact_id:
        associations.append({
            "to": {"id": contact_id},
            "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 202}],  # note->contact
        })
    if company_id:
        associations.append({
            "to": {"id": company_id},
            "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 190}],  # note->company
        })

    payload: dict[str, Any] = {"properties": props}
    if associations:
        payload["associations"] = associations

    created = _request("POST", "/crm/v3/objects/notes", json=payload) or {}
    new_id = str(created.get("id") or "")
    if not new_id:
        raise HubSpotError("HubSpot did not return a note id on create", payload=created)
    conv.hubspot_note_id = new_id
    db.commit()
    return new_id


# ---------------------------------------------------------------------------
# Deals (optional)
# ---------------------------------------------------------------------------


def _deal_name(conv: Conversation, visitor: Visitor | None, company: Company | None) -> str:
    who = (visitor.name if visitor else None) or (company.name if company else None) or f"Lead #{conv.id}"
    topic = conv.topic or (conv.analysis or {}).get("intent") or "Booth conversation"
    return f"{who} · {topic}"[:255]


def upsert_deal(
    db: Session,
    conv: Conversation,
    visitor: Visitor | None,
    company: Company | None,
    *,
    contact_id: str | None,
    company_id: str | None,
) -> str | None:
    """Create-or-update a HubSpot deal in the default pipeline with the
    stage chosen from lead_temperature. Returns the deal id."""
    if not _create_deals_active():
        return None

    props: dict[str, Any] = {
        "dealname": _deal_name(conv, visitor, company),
        "pipeline": "default",
    }
    stage = _temperature_to_stage(conv.lead_temperature)
    if stage:
        props["dealstage"] = stage
    if conv.created_at:
        # closedate is required for some pipelines; use a 30-day default.
        from datetime import timedelta
        target = conv.created_at + timedelta(days=30)
        props["closedate"] = int(target.timestamp() * 1000)

    if conv.hubspot_deal_id:
        try:
            _request(
                "PATCH",
                f"/crm/v3/objects/deals/{conv.hubspot_deal_id}",
                json={"properties": props},
            )
            return conv.hubspot_deal_id
        except HubSpotError as exc:
            if exc.status_code != 404:
                raise
            conv.hubspot_deal_id = None

    associations = []
    if contact_id:
        associations.append({
            "to": {"id": contact_id},
            "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 3}],  # deal->contact
        })
    if company_id:
        associations.append({
            "to": {"id": company_id},
            "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 5}],  # deal->company
        })

    payload: dict[str, Any] = {"properties": props}
    if associations:
        payload["associations"] = associations

    created = _request("POST", "/crm/v3/objects/deals", json=payload) or {}
    new_id = str(created.get("id") or "")
    if not new_id:
        raise HubSpotError("HubSpot did not return a deal id on create", payload=created)
    conv.hubspot_deal_id = new_id
    db.commit()
    return new_id


# ---------------------------------------------------------------------------
# AI insights -> custom contact properties
# ---------------------------------------------------------------------------

# A dedicated property group + properties on the contact object so the AI
# insights show up as their own labelled fields in HubSpot (not buried in the
# note). Created once per portal (idempotent — repeated POSTs 409 once it
# exists) and cached per process so we don't re-POST on every sync.
CONCAP_PROPERTY_GROUP = "concap_ai"
_CONCAP_CONTACT_PROPERTIES: list[dict[str, Any]] = [
    {"name": "concap_lead_score", "label": "Concap AI Lead Score", "type": "number", "fieldType": "number"},
    {"name": "concap_lead_quality", "label": "Concap AI Lead Quality", "type": "string", "fieldType": "text"},
    {"name": "concap_sentiment", "label": "Concap AI Sentiment", "type": "string", "fieldType": "text"},
    {"name": "concap_intent", "label": "Concap AI Intent", "type": "string", "fieldType": "text"},
    {"name": "concap_urgency", "label": "Concap AI Urgency", "type": "string", "fieldType": "text"},
    {"name": "concap_buying_role", "label": "Concap AI Buying Role", "type": "string", "fieldType": "text"},
    {"name": "concap_budget", "label": "Concap AI Budget", "type": "string", "fieldType": "text"},
    {"name": "concap_last_conversation", "label": "Concap AI Last Conversation", "type": "string", "fieldType": "textarea"},
]

# Process-lifetime cache of portals whose Concap properties we've ensured.
_ensured_property_portals: set[str] = set()


def _already_exists(exc: HubSpotError) -> bool:
    """True when a create call failed only because the object already exists —
    HubSpot returns 409 (and occasionally a 400 whose message says so)."""
    if exc.status_code == 409:
        return True
    payload = exc.payload
    msg = (payload.get("message") if isinstance(payload, dict) else "") or ""
    return "already exists" in msg.lower()


def ensure_custom_properties(portal_id: str | None) -> None:
    """Create the Concap AI property group + contact properties once per
    portal. Idempotent and cached per process; tolerant of the
    already-exists conflict so concurrent/repeat syncs don't error.

    The cache is keyed on the real portal id. When the portal id is unknown
    (account-info lookup failed) we deliberately skip caching and re-attempt
    every time — caching an unknown-portal sentinel would be shared across
    tenants and could suppress property creation for other orgs."""
    if portal_id and portal_id in _ensured_property_portals:
        return
    try:
        _request(
            "POST",
            "/crm/v3/properties/contacts/groups",
            json={"name": CONCAP_PROPERTY_GROUP, "label": "Concap AI"},
        )
    except HubSpotError as exc:
        if not _already_exists(exc):
            raise
    for prop in _CONCAP_CONTACT_PROPERTIES:
        try:
            _request(
                "POST",
                "/crm/v3/properties/contacts",
                json={**prop, "groupName": CONCAP_PROPERTY_GROUP},
            )
        except HubSpotError as exc:
            if not _already_exists(exc):
                raise
    if portal_id:
        _ensured_property_portals.add(portal_id)


def _temperature_to_lead_status(temp: str | None) -> str | None:
    """Map our lead temperature to a HubSpot default `hs_lead_status` value.
    Returns None when there's no opinionated mapping."""
    if not temp:
        return None
    return {
        "hot": "OPEN_DEAL",
        "warm": "OPEN",
        "cold": "UNQUALIFIED",
    }.get(temp.strip().lower())


def apply_contact_insights(db: Session, contact_id: str, conv: Conversation) -> None:
    """Write the conversation's AI insights onto the contact's Concap custom
    properties, and best-effort set the standard `hs_lead_status`. Assumes the
    custom properties have been ensured for this portal."""
    a = conv.analysis or {}
    props: dict[str, Any] = {}
    if conv.lead_score is not None:
        props["concap_lead_score"] = conv.lead_score
    if conv.lead_temperature:
        props["concap_lead_quality"] = conv.lead_temperature
    if a.get("sentiment"):
        props["concap_sentiment"] = str(a["sentiment"])[:255]
    if a.get("intent"):
        props["concap_intent"] = str(a["intent"])[:255]
    if a.get("urgency"):
        props["concap_urgency"] = str(a["urgency"])[:255]
    if a.get("buying_role"):
        props["concap_buying_role"] = str(a["buying_role"])[:255]
    if a.get("budget_range"):
        props["concap_budget"] = str(a["budget_range"])[:255]
    if a.get("summary"):
        props["concap_last_conversation"] = str(a["summary"])[:60_000]
    if props:
        _request("PATCH", f"/crm/v3/objects/contacts/{contact_id}", json={"properties": props})

    # hs_lead_status is a standard enum a portal may have customized — never
    # let an off-list value tank the whole insights step.
    status = _temperature_to_lead_status(conv.lead_temperature)
    if status:
        try:
            _request(
                "PATCH",
                f"/crm/v3/objects/contacts/{contact_id}",
                json={"properties": {"hs_lead_status": status}},
            )
        except HubSpotError as exc:
            logger.warning("HubSpot hs_lead_status set failed for contact %s: %s", contact_id, exc)


# ---------------------------------------------------------------------------
# Tasks (action items)
# ---------------------------------------------------------------------------


# Generic next-action fallback emitted by analysis when there's nothing real to
# do — not worth a HubSpot task.
_GENERIC_NEXT_ACTIONS = {
    "follow up to gather more information.",
    "follow up to gather more information",
}


def _task_due_ms(text: str, base: datetime) -> int:
    """Best-effort due date from the action text. Light keyword parse; falls
    back to two days out so every task lands on the rep's queue."""
    t = (text or "").lower()
    if any(k in t for k in ("today", "asap", "immediately", "right away", "24 hour", "24-hour", "tomorrow")):
        days = 1
    elif "next week" in t:
        days = 7
    elif "this week" in t:
        days = 3
    elif "month" in t:
        days = 30
    else:
        days = 2
    return int((base + timedelta(days=days)).timestamp() * 1000)


def _task_priority(temp: str | None) -> str:
    return {"hot": "HIGH", "warm": "MEDIUM", "cold": "LOW"}.get((temp or "").strip().lower(), "MEDIUM")


def _task_texts(conv: Conversation) -> list[str]:
    """Collect deduped task subjects from the analysis action items + a
    meaningful next_action."""
    a = conv.analysis or {}
    texts: list[str] = []
    for item in a.get("action_items") or []:
        s = str(item).strip()
        if s:
            texts.append(s)
    na = str(a.get("next_action") or "").strip()
    if na and na.lower() not in _GENERIC_NEXT_ACTIONS:
        texts.append(na)
    seen: set[str] = set()
    uniq: list[str] = []
    for t in texts:
        k = t.lower()
        if k in seen:
            continue
        seen.add(k)
        uniq.append(t)
    return uniq


def create_tasks(
    db: Session,
    conv: Conversation,
    *,
    contact_id: str | None,
    company_id: str | None,
) -> list[str]:
    """Create a HubSpot Task per action item, associated to the contact (and
    company). Idempotent: a per-text hash is recorded on
    `conv.hubspot_task_ids`, so re-syncing creates only newly-added action
    items rather than duplicating existing tasks. Returns all known task ids."""
    uniq = _task_texts(conv)
    existing = list(conv.hubspot_task_ids) if isinstance(conv.hubspot_task_ids, list) else []
    existing_hashes = {e.get("h") for e in existing if isinstance(e, dict)}
    if not uniq:
        return [e["id"] for e in existing if isinstance(e, dict) and e.get("id")]

    base = datetime.now(timezone.utc)
    owner_id = _default_owner_id()
    created_any = False
    for t in uniq:
        h = hashlib.sha1(t.lower().encode("utf-8")).hexdigest()[:16]
        if h in existing_hashes:
            continue
        props = {
            "hs_task_subject": t[:255],
            "hs_task_body": f"From Concap booth conversation #{conv.id}",
            "hs_task_status": "NOT_STARTED",
            "hs_task_priority": _task_priority(conv.lead_temperature),
            "hs_task_type": "TODO",
            "hs_timestamp": _task_due_ms(t, base),
        }
        # Assign the task to the org's configured default owner. When none is
        # configured the field is omitted and the task lands unassigned (the
        # HubSpot default) — we never block task creation on owner config.
        if owner_id:
            props["hubspot_owner_id"] = owner_id
        associations = []
        if contact_id:
            associations.append({
                "to": {"id": contact_id},
                "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 204}],  # task->contact
            })
        if company_id:
            associations.append({
                "to": {"id": company_id},
                "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 192}],  # task->company
            })
        payload: dict[str, Any] = {"properties": props}
        if associations:
            payload["associations"] = associations
        created = _request("POST", "/crm/v3/objects/tasks", json=payload) or {}
        new_id = str(created.get("id") or "")
        if new_id:
            existing.append({"h": h, "id": new_id, "text": t[:255]})
            existing_hashes.add(h)
            created_any = True

    if created_any:
        # Reassign (new list object) so SQLAlchemy persists the JSON change.
        conv.hubspot_task_ids = existing
        db.commit()
    return [e["id"] for e in existing if isinstance(e, dict) and e.get("id")]


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def sync_conversation(db: Session, conversation_id: int) -> dict:
    """Full upsert flow for a single conversation. Safe to call
    repeatedly — every step is idempotent on the cached HubSpot ids.

    Returns a dict shaped for the API/UI:
        {
          ok: bool,
          contact_id, company_id, note_id, deal_id,
          contact_url, company_url, deal_url,
          synced_at: ISO timestamp,
        }
    """
    conv = db.get(Conversation, conversation_id)
    if conv is None:
        raise HubSpotError(f"Conversation #{conversation_id} not found", status_code=404)
    visitor = db.get(Visitor, conv.visitor_id) if conv.visitor_id else None
    if visitor is None:
        raise HubSpotError("Conversation has no visitor to sync.", status_code=400)
    company = db.get(Company, conv.company_id) if conv.company_id else None

    # Resolve which HubSpot portal this conversation belongs to — the org's
    # own OAuth connection. Raises HubSpotNotConfigured when the org hasn't
    # connected (no shared/global token fallback).
    org = db.get(Organization, conv.org_id) if conv.org_id else None
    access_token, options = _resolve_org_credentials(db, org)

    with use_org_context(access_token, options):
        # Account info gives us the portal id for clickable URLs in the UI.
        # Cheap call, gated behind the same token check. We swallow failures
        # here so a permissions blip on account-info doesn't block the sync.
        portal_id: str | None = None
        try:
            portal_id = (get_account_info() or {}).get("portal_id")
            if portal_id is not None:
                portal_id = str(portal_id)
        except HubSpotError:
            portal_id = None

        # Company. When disabled, fall back to the cached id so dependent
        # associations (contact/note/deal) still link to a prior company.
        if _opt("sync_companies"):
            company_hs_id = upsert_company(db, company)
        else:
            company_hs_id = company.hubspot_company_id if company else None

        # Contact. When disabled, fall back to the cached id so the note/tasks
        # can still associate to an existing contact (but we won't create one).
        if _opt("sync_contacts"):
            contact_hs_id = upsert_contact(db, visitor)
            if contact_hs_id and company_hs_id:
                associate_contact_to_company(contact_hs_id, company_hs_id)
        else:
            contact_hs_id = visitor.hubspot_contact_id

        # AI insights -> custom contact properties + lead status. Best-effort
        # so a property/permission quirk never tanks the rest of the sync.
        if contact_hs_id and _opt("sync_insights"):
            try:
                ensure_custom_properties(portal_id)
                apply_contact_insights(db, contact_hs_id, conv)
            except HubSpotError as exc:
                logger.warning("HubSpot insights sync failed for conv #%s: %s", conv.id, exc)

        note_id: str | None = None
        if _opt("sync_notes"):
            note_id = create_or_update_note(
                db, conv,
                contact_id=contact_hs_id,
                company_id=company_hs_id,
                include_transcript=_opt("sync_transcript"),
            )

        # Tasks from action items. Needs a contact to associate to; best-effort
        # so a tasks-scope/permission quirk doesn't tank the rest of the sync.
        task_ids: list[str] = []
        if _opt("sync_tasks") and contact_hs_id:
            try:
                task_ids = create_tasks(
                    db, conv, contact_id=contact_hs_id, company_id=company_hs_id
                )
            except HubSpotError as exc:
                logger.warning("HubSpot task sync failed for conv #%s: %s", conv.id, exc)

        deal_id: str | None = None
        if _create_deals_active():
            try:
                deal_id = upsert_deal(
                    db, conv, visitor, company,
                    contact_id=contact_hs_id, company_id=company_hs_id,
                )
            except HubSpotError as exc:
                # Deal pipeline / stage configs vary a lot per portal. Don't
                # tank the whole sync if the deal step alone errored.
                logger.warning("HubSpot deal upsert failed for conv #%s: %s", conv.id, exc)

    now = datetime.now(timezone.utc)
    conv.hubspot_synced_at = now
    conv.hubspot_sync_error = None
    db.commit()

    return {
        "ok": True,
        "contact_id": contact_hs_id,
        "company_id": company_hs_id,
        "note_id": note_id,
        "deal_id": deal_id,
        "task_ids": task_ids,
        "contact_url": _contact_url(portal_id, contact_hs_id) if contact_hs_id else None,
        "company_url": _company_url(portal_id, company_hs_id) if company_hs_id else None,
        "deal_url": _deal_url(portal_id, deal_id) if deal_id else None,
        "synced_at": now.isoformat(),
    }


def sync_conversation_safe(db: Session, conversation_id: int) -> dict | None:
    """Background-friendly wrapper: never raises. Persists any error to
    conversation.hubspot_sync_error so the UI can show it next time the
    user opens the conversation."""
    try:
        return sync_conversation(db, conversation_id)
    except HubSpotError as exc:
        logger.warning("HubSpot auto-sync failed for conv #%s: %s", conversation_id, exc)
        conv = db.get(Conversation, conversation_id)
        if conv is not None:
            conv.hubspot_sync_error = str(exc)[:1000]
            db.commit()
        return None
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected HubSpot sync failure for conv #%s", conversation_id)
        conv = db.get(Conversation, conversation_id)
        if conv is not None:
            conv.hubspot_sync_error = f"Unexpected: {exc}"[:1000]
            db.commit()
        return None
