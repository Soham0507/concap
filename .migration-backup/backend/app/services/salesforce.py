"""Salesforce CRM client + sync orchestration.

Mirrors ``hubspot.py``: it talks to the Salesforce REST API using the
organization's own per-org OAuth access token + instance URL (bound for the
duration of a sync via ``use_org_context``). The public entry point is
``sync_conversation(db, conversation_id)`` — it upserts the Account, the
Contact (linked to the Account via ``AccountId``), a Note carrying the
transcript + analysis, and optionally an Opportunity. There is no shared
global token: an org that hasn't connected its own Salesforce org cannot sync.

Design notes
------------
* Idempotent. Repeated calls update existing records instead of creating
  duplicates: we cache the Salesforce ids on our own rows
  (``visitor.salesforce_contact_id``, ``company.salesforce_account_id``,
  ``conversation.salesforce_note_id`` / ``salesforce_opportunity_id``) and
  fall back to a SOQL search (by email -> phone for contacts, by website ->
  name for accounts) when no cached id exists.
* Tolerant of partial data. Missing fields are simply omitted from the
  payload rather than blanking a manually-edited Salesforce value.
* Failure is loud but contained. Network/HTTP errors raise ``SalesforceError``.
  The caller decides whether that crashes the request (manual click) or just
  logs (auto-sync after the pipeline).
"""
from __future__ import annotations

import contextlib
import contextvars
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

import httpx
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Company, Conversation, Organization, Visitor

logger = logging.getLogger("booth.salesforce")

DEFAULT_TIMEOUT = httpx.Timeout(30.0, connect=10.0)


class SalesforceError(RuntimeError):
    """Raised on any non-recoverable Salesforce API failure.

    `status_code` is the HTTP status from Salesforce (or 0 if we never got a
    response). `payload` is the parsed response body when available.
    """

    def __init__(self, message: str, *, status_code: int = 0, payload: Any = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


class SalesforceNotConfigured(SalesforceError):
    """No usable Salesforce connection for this org (not connected, or its
    OAuth connection needs reconnecting). The caller should surface this as a
    501/clear UI message nudging the org to connect, not a crash."""

    def __init__(self, message: str | None = None) -> None:
        super().__init__(
            message or "Salesforce is not connected. Connect Salesforce from Integrations.",
            status_code=501,
        )


# ---------------------------------------------------------------------------
# Low-level HTTP wrapper
# ---------------------------------------------------------------------------

# Per-org context for a single sync. ``sync_conversation`` resolves the org's
# OAuth access token + instance URL and binds them so the internal `_request`
# call sites pick up the right credentials without being rewritten. There is
# no shared/global token fallback — a sync without a bound token raises
# SalesforceNotConfigured.
_access_token_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "salesforce_access_token", default=None
)
_instance_url_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "salesforce_instance_url", default=None
)
_create_opps_ctx: contextvars.ContextVar[bool | None] = contextvars.ContextVar(
    "salesforce_create_opportunities", default=None
)


@contextlib.contextmanager
def use_org_context(access_token: str | None, instance_url: str | None, create_opportunities: bool | None):
    """Bind a per-org OAuth access token + instance URL (and the
    create-opportunities preference) for the duration of a sync."""
    tok_reset = _access_token_ctx.set(access_token)
    inst_reset = _instance_url_ctx.set(instance_url)
    opp_reset = _create_opps_ctx.set(create_opportunities)
    try:
        yield
    finally:
        _access_token_ctx.reset(tok_reset)
        _instance_url_ctx.reset(inst_reset)
        _create_opps_ctx.reset(opp_reset)


def _token() -> str:
    ctx_token = _access_token_ctx.get()
    if ctx_token:
        return ctx_token
    raise SalesforceNotConfigured()


def _instance_url() -> str:
    base = _instance_url_ctx.get()
    if base:
        return base.rstrip("/")
    raise SalesforceNotConfigured()


def _create_opps_active() -> bool:
    """Whether this sync should upsert opportunities — the per-org toggle bound
    for this sync. Defaults to off when nothing is bound."""
    return bool(_create_opps_ctx.get())


def _resolve_org_credentials(db: Session, org: Organization | None) -> tuple[str, str, bool]:
    """Resolve ``(access_token, instance_url, create_opportunities)`` for a
    sync against the org's own OAuth connection.

    Raises SalesforceNotConfigured when the org hasn't connected its own
    Salesforce org (or its connection needs reconnecting)."""
    from .salesforce_oauth import (
        SalesforceOAuthError,
        create_opportunities_enabled,
        get_valid_access_token,
    )

    if org is not None and org.salesforce_access_token_enc:
        try:
            token = get_valid_access_token(db, org)
        except SalesforceOAuthError as exc:
            raise SalesforceNotConfigured(str(exc)) from exc
        instance_url = org.salesforce_instance_url
        if not instance_url:
            raise SalesforceNotConfigured(
                "Salesforce connection is missing its instance URL — please reconnect."
            )
        return token, instance_url, create_opportunities_enabled(org)

    raise SalesforceNotConfigured(
        "This workspace hasn't connected Salesforce. Connect your own Salesforce "
        "org from Integrations to enable syncing."
    )


def _api_path(path: str) -> str:
    ver = get_settings().salesforce_api_version
    return f"/services/data/{ver}{path}"


def _request(method: str, path: str, *, json: Any = None, params: dict | None = None) -> Any:
    """Issue an authenticated Salesforce REST call. ``path`` is relative to the
    versioned data root (e.g. ``/sobjects/Contact``). Returns parsed JSON (or
    None on 204). Maps non-2xx into SalesforceError with the body attached."""
    url = f"{_instance_url()}{_api_path(path)}"
    headers = {
        "Authorization": f"Bearer {_token()}",
        "Content-Type": "application/json",
    }
    try:
        with httpx.Client(timeout=DEFAULT_TIMEOUT) as c:
            resp = c.request(method, url, json=json, params=params, headers=headers)
    except httpx.HTTPError as exc:
        raise SalesforceError(f"Salesforce network error: {exc}", status_code=0) from exc

    if resp.status_code == 204 or not resp.content:
        return None
    try:
        body = resp.json()
    except ValueError:
        body = {"raw": resp.text}

    if resp.is_success:
        return body

    # Salesforce returns a list of {message, errorCode} objects on error.
    detail = _error_message(body) or f"Salesforce API {resp.status_code} on {method} {path}"
    logger.warning("Salesforce error %s %s -> %s", method, path, body)
    raise SalesforceError(detail, status_code=resp.status_code, payload=body)


def _error_message(body: Any) -> str | None:
    if isinstance(body, list) and body:
        first = body[0]
        if isinstance(first, dict):
            return first.get("message") or first.get("errorCode")
    if isinstance(body, dict):
        return body.get("message") or body.get("error_description") or body.get("error")
    return None


# ---------------------------------------------------------------------------
# SOQL helpers
# ---------------------------------------------------------------------------

def _soql_escape(value: str) -> str:
    """Escape a string literal for safe inclusion in a SOQL WHERE clause.
    Backslash first, then single quote — order matters."""
    return value.replace("\\", "\\\\").replace("'", "\\'")


def _query_first_id(soql: str) -> str | None:
    body = _request("GET", "/query", params={"q": soql})
    records = (body or {}).get("records") or []
    if records:
        return str(records[0].get("Id"))
    return None


# ---------------------------------------------------------------------------
# Helpers — name splitting, domain, industry + stage mapping
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


_FREE_EMAIL_DOMAINS = {
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk",
    "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com",
    "aol.com", "proton.me", "protonmail.com", "msn.com", "rediffmail.com",
}


def _extract_domain(website: str | None, email: str | None = None) -> str | None:
    """Best-effort domain for account dedup. Tries the website first (with or
    without scheme), then the email host. Strips ``www.``."""
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
        if host and host not in _FREE_EMAIL_DOMAINS:
            return host
    return None


# Salesforce's standard `Industry` picklist. When the field is a restricted
# picklist (common), sending an off-list value 400s the whole upsert, so we map
# common free-text industries to standard values and omit anything we don't
# recognize (we never blank the field).
_SF_INDUSTRY_MAP = {
    "information technology": "Technology",
    "it": "Technology",
    "it services": "Technology",
    "tech": "Technology",
    "technology": "Technology",
    "software": "Technology",
    "saas": "Technology",
    "computer software": "Technology",
    "internet": "Technology",
    "ai": "Technology",
    "artificial intelligence": "Technology",
    "cybersecurity": "Technology",
    "electronics": "Electronics",
    "semiconductors": "Electronics",
    "telecom": "Telecommunications",
    "telecommunications": "Telecommunications",
    "communications": "Communications",
    "manufacturing": "Manufacturing",
    "industrial": "Manufacturing",
    "machinery": "Machinery",
    "chemicals": "Chemicals",
    "construction": "Construction",
    "engineering": "Engineering",
    "aerospace": "Manufacturing",
    "aviation": "Transportation",
    "automotive": "Manufacturing",
    "banking": "Banking",
    "finance": "Finance",
    "financial services": "Finance",
    "fintech": "Finance",
    "insurance": "Insurance",
    "accounting": "Finance",
    "healthcare": "Healthcare",
    "health care": "Healthcare",
    "hospital": "Healthcare",
    "pharma": "Biotechnology",
    "pharmaceuticals": "Biotechnology",
    "biotech": "Biotechnology",
    "biotechnology": "Biotechnology",
    "medical devices": "Healthcare",
    "retail": "Retail",
    "ecommerce": "Retail",
    "e-commerce": "Retail",
    "consumer goods": "Retail",
    "apparel": "Apparel",
    "fashion": "Apparel",
    "food": "Food & Beverage",
    "food and beverage": "Food & Beverage",
    "hospitality": "Hospitality",
    "restaurant": "Hospitality",
    "restaurants": "Hospitality",
    "consulting": "Consulting",
    "management consulting": "Consulting",
    "marketing": "Communications",
    "advertising": "Communications",
    "media": "Media",
    "publishing": "Media",
    "entertainment": "Entertainment",
    "education": "Education",
    "higher education": "Education",
    "government": "Government",
    "nonprofit": "Not For Profit",
    "non-profit": "Not For Profit",
    "energy": "Energy",
    "oil and gas": "Energy",
    "renewable energy": "Energy",
    "utilities": "Utilities",
    "agriculture": "Agriculture",
    "logistics": "Transportation",
    "supply chain": "Transportation",
    "transportation": "Transportation",
    "shipping": "Shipping",
    "travel": "Recreation",
    "tourism": "Recreation",
    "environmental": "Environmental",
    "recreation": "Recreation",
}


def _map_industry(value: str | None) -> str | None:
    if not value:
        return None
    return _SF_INDUSTRY_MAP.get(value.strip().lower())


def _temperature_to_stage(temp: str | None) -> str:
    """Map our lead temperature to a standard Salesforce Opportunity stage.
    Falls back to 'Prospecting' (present in every default org)."""
    t = (temp or "").strip().lower()
    return {
        "hot": "Qualification",
        "warm": "Prospecting",
        "cold": "Prospecting",
    }.get(t, "Prospecting")


def _record_url(record_id: str | None) -> str | None:
    """Salesforce Lightning resolves ``{instance_url}/{recordId}`` to the
    record's detail page, so a single pattern works for any object."""
    if not record_id:
        return None
    try:
        base = _instance_url()
    except SalesforceNotConfigured:
        return None
    return f"{base}/{record_id}"


# ---------------------------------------------------------------------------
# Account upsert
# ---------------------------------------------------------------------------

def _account_fields(company: Company) -> dict:
    """Map our Company row -> Salesforce Account fields. Only non-empty fields
    so we never blank manually-edited Salesforce values."""
    fields: dict[str, Any] = {}
    if company.name:
        fields["Name"] = company.name[:255]
    if company.website:
        fields["Website"] = company.website[:255]
    if company.phone:
        fields["Phone"] = company.phone[:40]
    industry = _map_industry(company.industry)
    if industry:
        fields["Industry"] = industry
    if company.address:
        fields["BillingStreet"] = company.address[:255]
    if company.city:
        fields["BillingCity"] = company.city[:40]
    if company.state:
        fields["BillingState"] = company.state[:80]
    if company.country:
        fields["BillingCountry"] = company.country[:80]
    return fields


def _search_account_id(domain: str | None, name: str | None) -> str | None:
    """Find an existing Account by website domain (preferred) or exact name."""
    if domain:
        found = _query_first_id(
            f"SELECT Id FROM Account WHERE Website LIKE '%{_soql_escape(domain)}%' LIMIT 1"
        )
        if found:
            return found
    if name:
        found = _query_first_id(
            f"SELECT Id FROM Account WHERE Name = '{_soql_escape(name)}' LIMIT 1"
        )
        if found:
            return found
    return None


def upsert_account(db: Session, company: Company | None) -> str | None:
    """Create-or-update a Salesforce Account. Returns the id, or None when
    `company` is None or has no usable identifiers."""
    if company is None:
        return None
    fields = _account_fields(company)
    if not fields.get("Name"):
        return None  # Account.Name is required

    # 1) Cached id from a prior sync.
    if company.salesforce_account_id:
        try:
            _request("PATCH", f"/sobjects/Account/{company.salesforce_account_id}", json=fields)
            company.salesforce_synced_at = datetime.now(timezone.utc)
            db.commit()
            return company.salesforce_account_id
        except SalesforceError as exc:
            if exc.status_code != 404:
                raise
            company.salesforce_account_id = None

    # 2) Search by domain then name.
    domain = _extract_domain(company.website, company.email)
    found = _search_account_id(domain, fields.get("Name"))
    if found:
        _request("PATCH", f"/sobjects/Account/{found}", json=fields)
        company.salesforce_account_id = found
        company.salesforce_synced_at = datetime.now(timezone.utc)
        db.commit()
        return found

    # 3) Create.
    created = _request("POST", "/sobjects/Account", json=fields) or {}
    new_id = str(created.get("id") or "")
    if not new_id:
        raise SalesforceError("Salesforce did not return an Account id on create", payload=created)
    company.salesforce_account_id = new_id
    company.salesforce_synced_at = datetime.now(timezone.utc)
    db.commit()
    return new_id


# ---------------------------------------------------------------------------
# Contact upsert
# ---------------------------------------------------------------------------

def _contact_fields(visitor: Visitor, account_id: str | None) -> dict:
    first, last = _split_name(visitor.name)
    fields: dict[str, Any] = {}
    if first:
        fields["FirstName"] = first[:40]
    # Salesforce requires LastName on Contact; fall back to the first name or a
    # placeholder so a single-word/blank name still produces a valid contact.
    fields["LastName"] = (last or first or "Unknown")[:80]
    if visitor.email:
        fields["Email"] = visitor.email.strip().lower()[:80]
    if visitor.phone:
        fields["Phone"] = visitor.phone[:40]
    if visitor.designation:
        fields["Title"] = visitor.designation[:128]
    if visitor.address:
        fields["MailingStreet"] = visitor.address[:255]
    if account_id:
        fields["AccountId"] = account_id
    return fields


def _search_contact_id(email: str | None, phone: str | None) -> str | None:
    if email:
        found = _query_first_id(
            f"SELECT Id FROM Contact WHERE Email = '{_soql_escape(email.lower())}' LIMIT 1"
        )
        if found:
            return found
    if phone:
        found = _query_first_id(
            f"SELECT Id FROM Contact WHERE Phone = '{_soql_escape(phone)}' LIMIT 1"
        )
        if found:
            return found
    return None


def upsert_contact(db: Session, visitor: Visitor, account_id: str | None) -> str:
    """Create-or-update a Salesforce Contact for the visitor (linked to the
    Account when known). Returns the Contact id."""
    fields = _contact_fields(visitor, account_id)
    if not visitor.email and not visitor.phone and not visitor.name:
        raise SalesforceError("Visitor has no name, email, or phone to identify in Salesforce.", status_code=400)

    # 1) Cached id.
    if visitor.salesforce_contact_id:
        try:
            _request("PATCH", f"/sobjects/Contact/{visitor.salesforce_contact_id}", json=fields)
            visitor.salesforce_synced_at = datetime.now(timezone.utc)
            db.commit()
            return visitor.salesforce_contact_id
        except SalesforceError as exc:
            if exc.status_code != 404:
                raise
            visitor.salesforce_contact_id = None

    # 2) Search.
    found = _search_contact_id(visitor.email, visitor.phone)
    if found:
        _request("PATCH", f"/sobjects/Contact/{found}", json=fields)
        visitor.salesforce_contact_id = found
        visitor.salesforce_synced_at = datetime.now(timezone.utc)
        db.commit()
        return found

    # 3) Create.
    created = _request("POST", "/sobjects/Contact", json=fields) or {}
    new_id = str(created.get("id") or "")
    if not new_id:
        raise SalesforceError("Salesforce did not return a Contact id on create", payload=created)
    visitor.salesforce_contact_id = new_id
    visitor.salesforce_synced_at = datetime.now(timezone.utc)
    db.commit()
    return new_id


# ---------------------------------------------------------------------------
# Note (classic) from the transcript + analysis
# ---------------------------------------------------------------------------

def _build_note_body(conv: Conversation) -> str:
    """Render a plain-text Note body (classic Notes don't accept HTML)."""
    a = conv.analysis or {}
    lines: list[str] = [f"Concap booth conversation #{conv.id}"]
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
        lines.append(" · ".join(meta_bits))

    score_bits = []
    if conv.lead_score is not None:
        score_bits.append(f"Lead score: {conv.lead_score}/100")
    if conv.lead_temperature:
        score_bits.append(f"Temperature: {conv.lead_temperature.title()}")
    if a.get("urgency"):
        score_bits.append(f"Urgency: {a['urgency']}")
    if a.get("timeline"):
        score_bits.append(f"Timeline: {a['timeline']}")
    if a.get("budget_range"):
        score_bits.append(f"Budget: {a['budget_range']}")
    if score_bits:
        lines.append(" · ".join(score_bits))

    if a.get("summary"):
        lines.append("")
        lines.append(f"Summary: {a['summary']}")
    if a.get("intent"):
        lines.append(f"Intent: {a['intent']}")

    for label, key in (
        ("Products discussed", "products_discussed"),
        ("Pain points", "pain_points"),
        ("Competitors mentioned", "competitors_mentioned"),
        ("Action items", "action_items"),
    ):
        items = a.get(key) or []
        if items:
            lines.append("")
            lines.append(f"{label}:")
            lines.extend(f"  - {x}" for x in items)

    if a.get("next_action"):
        lines.append("")
        lines.append(f"Next action: {a['next_action']}")

    quotes = a.get("key_quotes") or []
    if quotes:
        lines.append("")
        lines.append("Key quotes:")
        lines.extend(f'  "{q}"' for q in quotes)

    if conv.transcript:
        lines.append("")
        lines.append("Transcript:")
        snippet = conv.transcript[:30_000]
        if len(conv.transcript) > 30_000:
            snippet += "\n…[transcript truncated]"
        lines.append(snippet)

    # Classic Note.Body is capped at 32,000 characters.
    return "\n".join(lines)[:32_000]


def create_or_update_note(
    db: Session,
    conv: Conversation,
    *,
    contact_id: str | None,
    account_id: str | None,
) -> str | None:
    """Create (or update if already mirrored) a classic Salesforce Note holding
    the transcript + analysis. Classic Notes attach to a single parent, so we
    prefer the Contact and fall back to the Account."""
    parent_id = contact_id or account_id
    if not parent_id:
        return None
    fields = {
        "Title": f"Concap conversation #{conv.id}"[:80],
        "Body": _build_note_body(conv),
        "ParentId": parent_id,
    }

    if conv.salesforce_note_id:
        try:
            # Body/Title are updatable; ParentId is not, so only patch content.
            _request(
                "PATCH",
                f"/sobjects/Note/{conv.salesforce_note_id}",
                json={"Title": fields["Title"], "Body": fields["Body"]},
            )
            return conv.salesforce_note_id
        except SalesforceError as exc:
            if exc.status_code != 404:
                raise
            conv.salesforce_note_id = None

    created = _request("POST", "/sobjects/Note", json=fields) or {}
    new_id = str(created.get("id") or "")
    if not new_id:
        raise SalesforceError("Salesforce did not return a Note id on create", payload=created)
    conv.salesforce_note_id = new_id
    db.commit()
    return new_id


# ---------------------------------------------------------------------------
# Opportunity (optional)
# ---------------------------------------------------------------------------

def _opportunity_name(conv: Conversation, visitor: Visitor | None, company: Company | None) -> str:
    who = (visitor.name if visitor else None) or (company.name if company else None) or f"Lead #{conv.id}"
    topic = conv.topic or (conv.analysis or {}).get("intent") or "Booth conversation"
    return f"{who} · {topic}"[:120]


def upsert_opportunity(
    db: Session,
    conv: Conversation,
    visitor: Visitor | None,
    company: Company | None,
    *,
    contact_id: str | None,
    account_id: str | None,
) -> str | None:
    """Create-or-update a Salesforce Opportunity with a stage chosen from the
    lead temperature. Best-effort links the Contact via OpportunityContactRole."""
    if not _create_opps_active():
        return None

    close_date = (conv.created_at or datetime.now(timezone.utc)) + timedelta(days=30)
    fields: dict[str, Any] = {
        "Name": _opportunity_name(conv, visitor, company),
        "StageName": _temperature_to_stage(conv.lead_temperature),
        "CloseDate": close_date.strftime("%Y-%m-%d"),
    }
    if account_id:
        fields["AccountId"] = account_id

    if conv.salesforce_opportunity_id:
        try:
            _request(
                "PATCH",
                f"/sobjects/Opportunity/{conv.salesforce_opportunity_id}",
                json=fields,
            )
            return conv.salesforce_opportunity_id
        except SalesforceError as exc:
            if exc.status_code != 404:
                raise
            conv.salesforce_opportunity_id = None

    created = _request("POST", "/sobjects/Opportunity", json=fields) or {}
    new_id = str(created.get("id") or "")
    if not new_id:
        raise SalesforceError("Salesforce did not return an Opportunity id on create", payload=created)
    conv.salesforce_opportunity_id = new_id
    db.commit()

    # Best-effort: link the contact to the opportunity. Quirks here must not
    # tank the whole sync.
    if contact_id:
        try:
            _request(
                "POST",
                "/sobjects/OpportunityContactRole",
                json={"OpportunityId": new_id, "ContactId": contact_id, "IsPrimary": True},
            )
        except SalesforceError as exc:
            logger.warning(
                "Salesforce OpportunityContactRole link failed for conv #%s: %s", conv.id, exc
            )
    return new_id


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def sync_conversation(db: Session, conversation_id: int) -> dict:
    """Full upsert flow for a single conversation. Safe to call repeatedly —
    every step is idempotent on the cached Salesforce ids.

    Returns a dict shaped for the API/UI:
        {
          ok, contact_id, account_id, note_id, opportunity_id,
          contact_url, account_url, opportunity_url, synced_at,
        }
    """
    conv = db.get(Conversation, conversation_id)
    if conv is None:
        raise SalesforceError(f"Conversation #{conversation_id} not found", status_code=404)
    visitor = db.get(Visitor, conv.visitor_id) if conv.visitor_id else None
    if visitor is None:
        raise SalesforceError("Conversation has no visitor to sync.", status_code=400)
    company = db.get(Company, conv.company_id) if conv.company_id else None

    org = db.get(Organization, conv.org_id) if conv.org_id else None
    access_token, instance_url, create_opps = _resolve_org_credentials(db, org)

    with use_org_context(access_token, instance_url, create_opps):
        account_id = upsert_account(db, company)
        contact_id = upsert_contact(db, visitor, account_id)
        note_id = create_or_update_note(db, conv, contact_id=contact_id, account_id=account_id)

        opportunity_id: str | None = None
        if _create_opps_active():
            try:
                opportunity_id = upsert_opportunity(
                    db, conv, visitor, company,
                    contact_id=contact_id, account_id=account_id,
                )
            except SalesforceError as exc:
                # Stage/pipeline configs vary per org. Don't tank the whole
                # sync if only the opportunity step errored.
                logger.warning("Salesforce opportunity upsert failed for conv #%s: %s", conv.id, exc)

        contact_url = _record_url(contact_id)
        account_url = _record_url(account_id)
        opportunity_url = _record_url(opportunity_id)

    now = datetime.now(timezone.utc)
    conv.salesforce_synced_at = now
    conv.salesforce_sync_error = None
    db.commit()

    return {
        "ok": True,
        "contact_id": contact_id,
        "account_id": account_id,
        "note_id": note_id,
        "opportunity_id": opportunity_id,
        "contact_url": contact_url,
        "account_url": account_url,
        "opportunity_url": opportunity_url,
        "synced_at": now.isoformat(),
    }


def sync_conversation_safe(db: Session, conversation_id: int) -> dict | None:
    """Background-friendly wrapper: never raises. Persists any error to
    conversation.salesforce_sync_error so the UI can show it next time the
    user opens the conversation."""
    try:
        return sync_conversation(db, conversation_id)
    except SalesforceError as exc:
        logger.warning("Salesforce auto-sync failed for conv #%s: %s", conversation_id, exc)
        conv = db.get(Conversation, conversation_id)
        if conv is not None:
            conv.salesforce_sync_error = str(exc)[:1000]
            db.commit()
        return None
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected Salesforce sync failure for conv #%s", conversation_id)
        conv = db.get(Conversation, conversation_id)
        if conv is not None:
            conv.salesforce_sync_error = f"Unexpected: {exc}"[:1000]
            db.commit()
        return None
