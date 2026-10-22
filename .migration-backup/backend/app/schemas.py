from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _normalize_linkedin(value: str | None) -> str | None:
    """Make a LinkedIn URL safe to use as an <a href>. A bare value like
    'linkedin.com/in/jane' (typed in the edit modal or read off a card) is a
    *relative* link in the browser and 404s, so prefix a scheme when missing.
    Empty / whitespace becomes None. Applied on both write and read (VisitorOut
    uses from_attributes) so already-stored bare values render correctly too."""
    if not value:
        return None
    v = value.strip()
    if not v:
        return None
    if not v.lower().startswith(("http://", "https://")):
        v = "https://" + v.lstrip("/")
    return v


class VisitorIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    company: str | None = None
    company_id: int | None = None
    email: str | None = None  # plain str: OCR'd card emails are often imperfect; never reject/drop them
    phone: str | None = None
    designation: str | None = None
    industry: str | None = None
    interest_category: str | None = None
    badge_id: str | None = None
    source: str = "manual"
    notes: str | None = None
    # Card / contact fields (also populated by the scanner).
    website: str | None = None
    gst_number: str | None = None
    address: str | None = None
    contact_type: str = "lead"  # lead | customer | employee
    linkedin_url: str | None = None

    @field_validator("linkedin_url")
    @classmethod
    def _v_linkedin(cls, v: str | None) -> str | None:
        return _normalize_linkedin(v)


class VisitorOut(VisitorIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime
    # Surfaced read-only so the UI can show "scanned card" badges + the
    # raw OCR text in an edit-detail drawer. Never required to write back.
    scan_image_path: str | None = None
    scan_raw_text: str | None = None
    scan_metadata: dict[str, Any] | None = None
    person_summary: str | None = None


class VisitorUpdate(BaseModel):
    """Partial update — only fields the client sends are touched."""
    name: str | None = Field(default=None, min_length=1, max_length=200)
    company: str | None = None
    company_id: int | None = None
    email: str | None = None  # plain str: OCR'd card emails are often imperfect; never reject/drop them
    phone: str | None = None
    designation: str | None = None
    industry: str | None = None
    interest_category: str | None = None
    badge_id: str | None = None
    notes: str | None = None
    website: str | None = None
    gst_number: str | None = None
    address: str | None = None
    contact_type: str | None = None
    linkedin_url: str | None = None

    @field_validator("linkedin_url")
    @classmethod
    def _v_linkedin(cls, v: str | None) -> str | None:
        return _normalize_linkedin(v)


# ---- Company (CRM "Account") ------------------------------------------------

class CompanyIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: str | None = None  # plain str: OCR'd card emails are often imperfect; never reject/drop them
    phone: str | None = None
    website: str | None = None
    industry: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    gst_number: str | None = None
    referrer: str | None = None
    notes: str | None = None


class CompanyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    email: str | None = None  # plain str: OCR'd card emails are often imperfect; never reject/drop them
    phone: str | None = None
    website: str | None = None
    industry: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    gst_number: str | None = None
    referrer: str | None = None
    notes: str | None = None


class CompanyOut(CompanyIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime
    # AI "quick research" (populated on demand from the scan review screen).
    summary: str | None = None
    competitors: list[dict[str, Any]] | None = None
    research_updated_at: datetime | None = None


class CompanySummary(CompanyOut):
    contact_count: int = 0
    lead_count: int = 0
    customer_count: int = 0
    employee_count: int = 0
    conversation_count: int = 0


class CompanyConversation(BaseModel):
    """Lightweight conversation row shown on the company detail page."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    visitor_id: int
    visitor_name: str | None = None
    staff_name: str | None = None
    transcript: str | None = None
    status: str
    lead_score: int | None = None
    lead_temperature: str | None = None
    duration_seconds: float | None = None
    created_at: datetime
    # "direct" — Conversation.company_id matches this company.
    # "via_visitor" — only linked because the contact still has this
    # company_id (legacy rows before Conversation.company_id existed).
    link_source: str = "direct"


class CompanyDetail(CompanyOut):
    contacts: list[VisitorOut] = []
    conversations: list[CompanyConversation] = []
    contact_count: int = 0
    lead_count: int = 0
    customer_count: int = 0
    employee_count: int = 0


class ConsentIn(BaseModel):
    visitor_id: int
    recording_consent: bool
    data_processing_consent: bool
    marketing_consent: bool = False
    consent_text: str
    consent_version: str = "v1"


class ConsentOut(ConsentIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    ip_address: str | None
    user_agent: str | None
    signed_at: datetime


class ConversationCreate(BaseModel):
    visitor_id: int
    staff_name: str | None = None
    # Optional explicit company link. When omitted, the server derives it
    # from the visitor's company_id (transitive link).
    company_id: int | None = None


class ConversationLinkCompany(BaseModel):
    """Body for PATCH /api/conversations/{id}/company. Pass `null` to unlink."""
    company_id: int | None = None


class ConversationLinkContact(BaseModel):
    """Body for PATCH /api/conversations/{id}/contact — reassign the
    conversation to a different in-org contact (visitor)."""
    visitor_id: int


class ContactConversation(BaseModel):
    """Lightweight conversation row shown on a contact's profile modal."""
    id: int
    topic: str | None = None
    summary: str | None = None
    status: str
    lead_score: int | None = None
    lead_temperature: str | None = None
    duration_seconds: float | None = None
    created_at: datetime
    company_id: int | None = None
    company_name: str | None = None


class ConversationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    visitor_id: int
    staff_name: str | None
    event_name: str | None
    booth_name: str | None
    audio_filename: str | None
    duration_seconds: float | None
    transcript: str | None
    transcript_language: str | None
    analysis: dict[str, Any] | None
    lead_score: int | None
    lead_temperature: str | None
    status: str
    error_message: str | None
    created_at: datetime
    updated_at: datetime
    event_day_id: int | None = None
    event_day_label: str | None = None
    company_id: int | None = None
    company_name: str | None = None
    # Surfaced from analysis JSON so the UI can show a confirm chip on
    # unlinked transcripts without re-parsing the analysis blob.
    suggested_company: str | None = None
    # Consent detection (from analysis.consent) so the conversation detail can
    # show a consent badge without re-parsing the analysis blob.
    consent: dict[str, Any] | None = None
    # HubSpot mirror — set after a successful /hubspot-sync. URLs are
    # generated on the fly from the portal id so the frontend can deep-
    # link straight into the HubSpot record.
    hubspot_contact_id: str | None = None
    hubspot_company_id: str | None = None
    hubspot_note_id: str | None = None
    hubspot_deal_id: str | None = None
    hubspot_synced_at: datetime | None = None
    hubspot_sync_error: str | None = None
    # Salesforce mirror — set after a successful /salesforce-sync. Record URLs
    # are generated on the fly so the frontend can deep-link into Salesforce.
    salesforce_contact_id: str | None = None
    salesforce_opportunity_id: str | None = None
    salesforce_synced_at: datetime | None = None
    salesforce_sync_error: str | None = None


class ConversationListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    visitor_id: int
    visitor_name: str
    visitor_company: str | None
    staff_name: str | None
    status: str
    lead_score: int | None
    lead_temperature: str | None
    duration_seconds: float | None
    created_at: datetime
    event_name: str | None = None
    event_day_label: str | None = None
    company_id: int | None = None
    company_name: str | None = None
    suggested_company: str | None = None
    has_audio: bool = False
    topic: str | None = None
