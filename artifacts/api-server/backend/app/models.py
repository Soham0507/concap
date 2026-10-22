from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    # "individual" = private workspace of one; "company" = multi-user.
    org_type: Mapped[str] = mapped_column(String(20), default="company")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    # --- HubSpot OAuth (per-org connection) --------------------------------
    # Access + refresh tokens, encrypted at rest (Fernet). Null until the org
    # connects its own HubSpot portal via OAuth.
    hubspot_access_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    hubspot_refresh_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    hubspot_token_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    hubspot_portal_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    hubspot_connected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Single-use nonce for the in-flight OAuth round-trip. Set when /oauth/start
    # issues a state, matched + cleared by the callback so a leaked state can't
    # be replayed to attach an unintended portal.
    hubspot_oauth_state: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Set when a token refresh fails irrecoverably — the UI shows "Reconnect".
    hubspot_needs_reconnect: Mapped[bool] = mapped_column(Boolean, default=False)
    # Per-org sync toggles (override the legacy global defaults). Nullable so
    # the in-place schema migration can add them without a backfill; None is
    # treated as the default (on) at read time.
    hubspot_auto_sync: Mapped[bool] = mapped_column(Boolean, default=True)
    hubspot_create_deals: Mapped[bool] = mapped_column(Boolean, default=True)
    # Set when an org explicitly disconnects HubSpot. Distinguishes "never
    # connected" (legacy global-token fallback allowed) from "deliberately
    # disconnected" (no fallback — the org must not sync to the shared portal).
    hubspot_disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # Granular per-org sync toggles for the conversation sync. Each gates one
    # step of sync_conversation. Nullable so the in-place migration needs no
    # backfill; None is read as the default (on) at the application layer.
    hubspot_sync_contacts: Mapped[bool] = mapped_column(Boolean, default=True)
    hubspot_sync_companies: Mapped[bool] = mapped_column(Boolean, default=True)
    hubspot_sync_notes: Mapped[bool] = mapped_column(Boolean, default=True)
    hubspot_sync_transcript: Mapped[bool] = mapped_column(Boolean, default=True)
    hubspot_sync_tasks: Mapped[bool] = mapped_column(Boolean, default=True)
    hubspot_sync_insights: Mapped[bool] = mapped_column(Boolean, default=True)
    # Default HubSpot owner id that synced Tasks are assigned to. None means no
    # owner is configured — tasks are still created, just left unassigned (the
    # HubSpot default). Stored as the numeric owner id HubSpot returns as a
    # string. Nullable so the in-place migration needs no backfill.
    hubspot_default_owner_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # --- Salesforce OAuth (per-org connection) -----------------------------
    # Mirrors the HubSpot block above: per-org encrypted access + refresh
    # tokens, no shared/global fallback. `instance_url` is the org's API base
    # returned by the token endpoint and is required for every REST call.
    salesforce_access_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    salesforce_refresh_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    salesforce_token_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    salesforce_instance_url: Mapped[str | None] = mapped_column(String(255), nullable=True)
    salesforce_org_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    salesforce_connected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    salesforce_oauth_state: Mapped[str | None] = mapped_column(String(64), nullable=True)
    salesforce_needs_reconnect: Mapped[bool] = mapped_column(Boolean, default=False)
    salesforce_auto_sync: Mapped[bool] = mapped_column(Boolean, default=True)
    salesforce_create_opportunities: Mapped[bool] = mapped_column(Boolean, default=True)
    salesforce_disabled: Mapped[bool] = mapped_column(Boolean, default=False)

    # --- Meeting-platform OAuth (per-org connections) ----------------------
    # Zoom, Google Meet, and Microsoft Teams each store their own encrypted
    # access + refresh tokens on the org row, mirroring the HubSpot/Salesforce
    # blocks above. Used by the Imported Meetings tab to pull cloud-recording
    # transcripts. All nullable so the in-place schema migration needs no
    # backfill; booleans read as their default (None -> off) at the app layer.
    zoom_access_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    zoom_refresh_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    zoom_token_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    zoom_account_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    zoom_connected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    zoom_oauth_state: Mapped[str | None] = mapped_column(String(64), nullable=True)
    zoom_needs_reconnect: Mapped[bool] = mapped_column(Boolean, default=False)
    zoom_disabled: Mapped[bool] = mapped_column(Boolean, default=False)

    gmeet_access_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    gmeet_refresh_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    gmeet_token_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    gmeet_account_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    gmeet_connected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    gmeet_oauth_state: Mapped[str | None] = mapped_column(String(64), nullable=True)
    gmeet_needs_reconnect: Mapped[bool] = mapped_column(Boolean, default=False)
    gmeet_disabled: Mapped[bool] = mapped_column(Boolean, default=False)

    teams_access_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    teams_refresh_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    teams_token_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    teams_account_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    teams_connected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    teams_oauth_state: Mapped[str | None] = mapped_column(String(64), nullable=True)
    teams_needs_reconnect: Mapped[bool] = mapped_column(Boolean, default=False)
    teams_disabled: Mapped[bool] = mapped_column(Boolean, default=False)

    # --- Branding (org-scoped, set on the Settings / Branding page) --------
    # Used by the Quote agent to render branded PDF/Word proposals. All
    # nullable so the in-place schema migration can add them with no backfill.
    # The logo is stored as a data: URI (base64) so it travels with the DB and
    # needs no separate file store; capped client- and server-side (~1.5 MB).
    brand_company_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    brand_logo_data_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    brand_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    brand_email: Mapped[str | None] = mapped_column(String(200), nullable=True)
    brand_phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    brand_website: Mapped[str | None] = mapped_column(String(255), nullable=True)
    brand_primary_color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    brand_accent_color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    brand_currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    brand_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    users: Mapped[list["User"]] = relationship(back_populates="organization")


# Roles, ordered by privilege. Used for permission checks.
ROLE_OWNER = "owner"
ROLE_ADMIN = "admin"
ROLE_MEMBER = "member"
ROLE_RANK = {ROLE_MEMBER: 0, ROLE_ADMIN: 1, ROLE_OWNER: 2}


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default=ROLE_MEMBER)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # --- Primary User Voice Profile (identity used to relabel "Speaker N") ---
    # Captured from Settings -> Profile -> Voice Profile, not at signup. The
    # display_name is what replaces generic speaker labels across conversations,
    # summaries, action items, CRM notes and the Quote agent. voice_consent_at is
    # set when the user accepts the voice-profile privacy notice (required before
    # a sample can be enrolled). The actual voice/style fingerprint lives in a
    # SpeakerVoiceprint row (is_primary=True, user_id=this user).
    display_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    job_title: Mapped[str | None] = mapped_column(String(160), nullable=True)
    company_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    department: Mapped[str | None] = mapped_column(String(160), nullable=True)
    voice_consent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # --- Plaud OAuth (per-USER connection to the Plaud MCP server) ---------
    # Each user connects their own Plaud account; tokens are encrypted at rest
    # (Fernet) and never shared. Null until the user connects.
    plaud_access_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    plaud_refresh_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    plaud_token_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    plaud_connected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Single-use nonce + PKCE verifier for the in-flight OAuth round-trip. Set
    # at /oauth/start, matched + cleared by the callback (verifier is ephemeral).
    plaud_oauth_state: Mapped[str | None] = mapped_column(String(64), nullable=True)
    plaud_code_verifier: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # OAuth client used for this user's grant. When the server supports Dynamic
    # Client Registration we register per-user and store the issued client here
    # (secret encrypted); otherwise these mirror the configured static client.
    plaud_client_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    plaud_client_secret_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Set when a token refresh fails irrecoverably — the UI shows "Reconnect".
    plaud_needs_reconnect: Mapped[bool] = mapped_column(Boolean, default=False)
    # Display-only account info captured from get_current_user after connect.
    plaud_account_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    plaud_account_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    plaud_last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    organization: Mapped["Organization | None"] = relationship(back_populates="users")


class Company(Base):
    """A company / account record — the "C" in CRM. One company has many
    contact persons (Visitor rows) and, via those, many Conversations
    (transcripts). Created automatically when a card is scanned, but can
    also be added/edited manually from the Companies UI.
    """
    __tablename__ = "companies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    name: Mapped[str] = mapped_column(String(200), index=True)
    email: Mapped[str | None] = mapped_column(String(200), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    website: Mapped[str | None] = mapped_column(String(255), nullable=True)
    industry: Mapped[str | None] = mapped_column(String(200), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    city: Mapped[str | None] = mapped_column(String(120), nullable=True)
    state: Mapped[str | None] = mapped_column(String(120), nullable=True)
    country: Mapped[str | None] = mapped_column(String(120), nullable=True)
    gst_number: Mapped[str | None] = mapped_column(String(30), nullable=True)
    # Free-text "Where did this company come from?" — referrer/partner/event.
    referrer: Mapped[str | None] = mapped_column(String(200), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    # AI "quick research" — populated on demand from the scan review screen.
    # summary: a few-sentence overview of what the company does.
    # competitors: JSON list of { "name": str, "note": str }.
    # research_updated_at: when the research was last refreshed (audit / cache).
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    competitors: Mapped[list | None] = mapped_column(JSON, nullable=True)
    research_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # HubSpot mirror — the company id returned by /crm/v3/objects/companies.
    # Set on first successful sync and re-used for idempotent upserts.
    hubspot_company_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    hubspot_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Salesforce mirror — the Account id returned by /sobjects/Account.
    salesforce_account_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    salesforce_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    contacts: Mapped[list["Visitor"]] = relationship(
        back_populates="company_ref",
        # We don't cascade-delete contacts; the company router unlinks them
        # so the contact records survive a company merge/delete.
        passive_deletes=True,
    )


class Visitor(Base):
    __tablename__ = "visitors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    name: Mapped[str] = mapped_column(String(200))
    # Free-text company name. Kept as a denormalized convenience field for
    # legacy callers and the contacts list — the source of truth when a
    # Company record exists is `company_ref.name` (joined via company_id).
    company: Mapped[str | None] = mapped_column(String(200), nullable=True)
    company_id: Mapped[int | None] = mapped_column(
        ForeignKey("companies.id", ondelete="SET NULL"), index=True, nullable=True,
    )
    company_ref: Mapped["Company | None"] = relationship(back_populates="contacts")
    email: Mapped[str | None] = mapped_column(String(200), nullable=True, index=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    designation: Mapped[str | None] = mapped_column(String(200), nullable=True)
    industry: Mapped[str | None] = mapped_column(String(200), nullable=True)
    interest_category: Mapped[str | None] = mapped_column(String(200), nullable=True)
    badge_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    source: Mapped[str] = mapped_column(String(50), default="manual")  # manual | qr | nfc | ocr | scan
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Card / document scanner fields. Populated when the visitor was created
    # via the /api/scan endpoint (Google Cloud Vision OCR + QR decode). Also
    # editable from the manual contact form for the same shape.
    website: Mapped[str | None] = mapped_column(String(255), nullable=True)
    gst_number: Mapped[str | None] = mapped_column(String(30), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    # "lead" (default — booth visitor), "customer", "employee". Used to
    # group records on the Contacts page without splitting the table.
    contact_type: Mapped[str] = mapped_column(String(20), default="lead")
    # Path on disk to the original scanned image (jpg/png/heic), for audit
    # and re-parsing if our extraction heuristics improve.
    scan_image_path: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # Raw OCR text exactly as returned by Vision — useful when the parser
    # misses a field and the user wants to see what the camera actually saw.
    scan_raw_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Free-form metadata bag: { "qr_payload": str, "vision_blocks": [...],
    # "confidence": float, ... } — never required by the UI, just stored.
    scan_metadata: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    # AI enrichment. linkedin_url is captured from the card (printed URL / QR)
    # when present, otherwise discovered best-effort via web research and is
    # always user-editable. person_summary is a short AI brief on the person.
    linkedin_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    person_summary: Mapped[str | None] = mapped_column(Text, nullable=True)

    # HubSpot mirror — contact id returned by /crm/v3/objects/contacts.
    hubspot_contact_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    hubspot_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Salesforce mirror — Contact id returned by /sobjects/Contact.
    salesforce_contact_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    salesforce_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    consents: Mapped[list["Consent"]] = relationship(back_populates="visitor", cascade="all, delete-orphan")
    conversations: Mapped[list["Conversation"]] = relationship(back_populates="visitor", cascade="all, delete-orphan")


class Consent(Base):
    __tablename__ = "consents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    visitor_id: Mapped[int] = mapped_column(ForeignKey("visitors.id", ondelete="CASCADE"))
    recording_consent: Mapped[bool] = mapped_column(Boolean, default=False)
    data_processing_consent: Mapped[bool] = mapped_column(Boolean, default=False)
    marketing_consent: Mapped[bool] = mapped_column(Boolean, default=False)
    consent_text: Mapped[str] = mapped_column(Text)
    consent_version: Mapped[str] = mapped_column(String(20), default="v1")
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(300), nullable=True)
    signed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    visitor: Mapped["Visitor"] = relationship(back_populates="consents")


class Event(Base):
    """A category/event master row (e.g. "CES Las Vegas 2026"). Owned by an
    org. Each event has one or more EventDays the user assigns conversations to.
    """
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    name: Mapped[str] = mapped_column(String(200))
    location: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # When the event itself starts (Day 1's date). Optional — older events may
    # not have this. When set on create, each EventDay's event_date is seeded
    # as start_date + (day_number-1) days.
    start_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    days: Mapped[list["EventDay"]] = relationship(
        back_populates="event",
        cascade="all, delete-orphan",
        order_by="EventDay.day_number",
    )


class EventDay(Base):
    """One day within an Event (Day 1, Day 2, …). Cheap to add post-hoc."""
    __tablename__ = "event_days"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[int] = mapped_column(
        ForeignKey("events.id", ondelete="CASCADE"), index=True
    )
    day_number: Mapped[int] = mapped_column(Integer)
    label: Mapped[str | None] = mapped_column(String(100), nullable=True)
    event_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    event: Mapped["Event"] = relationship(back_populates="days")


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    visitor_id: Mapped[int] = mapped_column(ForeignKey("visitors.id", ondelete="CASCADE"))
    # Direct link to the Company (CRM "Account") this transcript belongs to.
    # Set from the booth's pre-record company picker, the recent-scan
    # auto-linker, the AI suggestion confirm-flow, or the manual "Link to
    # company" affordance. Nullable so unlinked / unclaimed transcripts
    # remain queryable on the company-detail page once linked later.
    company_id: Mapped[int | None] = mapped_column(
        ForeignKey("companies.id", ondelete="SET NULL"), index=True, nullable=True,
    )
    company: Mapped["Company | None"] = relationship()
    staff_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    event_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    booth_name: Mapped[str | None] = mapped_column(String(200), nullable=True)

    # Optional link to an Event/EventDay from the category master.
    event_day_id: Mapped[int | None] = mapped_column(
        ForeignKey("event_days.id", ondelete="SET NULL"), index=True, nullable=True
    )
    event_day: Mapped["EventDay | None"] = relationship()

    audio_filename: Mapped[str | None] = mapped_column(String(300), nullable=True)
    audio_mime: Mapped[str | None] = mapped_column(String(100), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Client-generated UUID for offline-queue dedup. If a queued capture is retried
    # after the server already accepted it, we return the existing record instead
    # of creating a duplicate. Indexed + unique.
    client_capture_id: Mapped[str | None] = mapped_column(String(64), unique=True, index=True, nullable=True)

    transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    transcript_language: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # Structured GPT analysis. Stored as JSON for flexibility.
    # Keys: intent, products, budget_range, urgency, timeline,
    #       pain_points, competitors_mentioned, buying_role, sentiment,
    #       next_action, summary, key_quotes
    analysis: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    lead_score: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 0–100
    lead_temperature: Mapped[str | None] = mapped_column(String(20), nullable=True)  # hot | warm | cold

    # Short topic label derived from the analysis ("CRM software", "Manufacturing
    # supplier", ...) — useful for filtering and search result snippets.
    topic: Mapped[str | None] = mapped_column(String(200), nullable=True)

    # OpenAI embedding of the transcript+summary, stored as JSON list of floats.
    # Not using pgvector to keep the codebase portable (SQLite dev, Postgres prod).
    # At a few hundred conversations per org the in-Python cosine search is fine.
    embedding: Mapped[list | None] = mapped_column(JSON, nullable=True)

    # Lifecycle: created -> uploaded -> transcribing -> analyzing -> analyzed | error
    status: Mapped[str] = mapped_column(String(30), default="created")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # HubSpot mirror — engagement (note) id created by /crm/v3/objects/notes
    # and the deal id from /crm/v3/objects/deals. Both nullable; only set
    # if the per-conversation HubSpot sync was actually invoked.
    hubspot_note_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    hubspot_deal_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    hubspot_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    hubspot_sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Created HubSpot Task ids for this conversation's action items, stored as a
    # JSON list of {"h": text-hash, "id": task-id, "text": subject} so re-syncs
    # add only new action items instead of duplicating existing tasks.
    hubspot_task_ids: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Salesforce mirror — Note id from /sobjects/Note and Opportunity id from
    # /sobjects/Opportunity. Both nullable; only set if a Salesforce sync ran.
    salesforce_note_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    salesforce_opportunity_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    salesforce_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    salesforce_sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    visitor: Mapped["Visitor"] = relationship(back_populates="conversations")

    # When a conversation was extracted from a long-capture Session, this
    # links back to its source session and the markers that bracketed it.
    session_id: Mapped[int | None] = mapped_column(ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True)
    session_start_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    session_end_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    session: Mapped["Session | None"] = relationship(back_populates="conversations")


class Session(Base):
    """A single continuous recording (e.g. a full booth day on a Zoom H4n).

    Markers segment the recording into per-visitor windows; running
    `process` slices the audio with ffmpeg and produces one Conversation
    row per visitor window.
    """
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    name: Mapped[str] = mapped_column(String(200))
    event_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    booth_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    staff_name: Mapped[str | None] = mapped_column(String(200), nullable=True)

    # Optional link to an event day (mirrors Conversation.event_day_id). When
    # set, every conversation derived from this session inherits it so the
    # whole booth-day is filed under the chosen event/day. Nullable so the
    # in-place schema migration needs no backfill.
    event_day_id: Mapped[int | None] = mapped_column(
        ForeignKey("event_days.id", ondelete="SET NULL"), index=True, nullable=True
    )
    event_day: Mapped["EventDay | None"] = relationship()

    audio_filename: Mapped[str | None] = mapped_column(String(300), nullable=True)
    audio_mime: Mapped[str | None] = mapped_column(String(100), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Lifecycle: created -> audio_uploaded -> [detecting -> proposed] ->
    #            processing -> processed | error
    status: Mapped[str] = mapped_column(String(30), default="created")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # AI auto-detection: the full diarized transcript (utterances) and the
    # GPT-proposed session breakdown the user reviews before confirming.
    diarized_segments: Mapped[list | None] = mapped_column(JSON, nullable=True)
    ai_proposal: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    # The wall-clock time the recording started. Useful when markers come
    # from a device with absolute timestamps (e.g. a badge scanner) and we
    # need to convert them to seconds-into-the-recording.
    recording_started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    markers: Mapped[list["SessionMarker"]] = relationship(
        back_populates="session", cascade="all, delete-orphan", order_by="SessionMarker.timestamp_seconds",
    )
    conversations: Mapped[list["Conversation"]] = relationship(back_populates="session")


class ActionItem(Base):
    """A follow-up task extracted by GPT from a conversation analysis.

    Mirrored out of `conversations.analysis["action_items"]` so the UI and
    future CRM integrations can query, update, and tick off tasks without
    having to mutate a JSON blob.
    """
    __tablename__ = "action_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    task: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="open")  # open | done | dismissed
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class MeetingBatch(Base):
    """A bulk meeting-intelligence upload. Groups many MeetingDocument rows
    so the UI can show batch progress and a combined cross-meeting summary.
    Org-scoped (all members of an org share visibility) + creator user_id.
    """
    __tablename__ = "meeting_intelligence_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True, nullable=True
    )
    label: Mapped[str | None] = mapped_column(String(300), nullable=True)
    default_source: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # queued -> running -> completed | failed
    status: Mapped[str] = mapped_column(String(20), default="queued")
    total_count: Mapped[int] = mapped_column(Integer, default=0)
    completed_count: Mapped[int] = mapped_column(Integer, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, default=0)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    documents: Mapped[list["MeetingDocument"]] = relationship(
        back_populates="batch", cascade="all, delete-orphan",
    )


class MeetingDocument(Base):
    """One uploaded meeting transcript and its structured Minutes-of-Meeting
    (MOM) extraction. Inputs are either pasted/uploaded text or an audio file
    (transcribed by the background worker before extraction). The worker
    claims queued rows, extracts via GPT, and stores both a machine-readable
    `document_json` (with evidence quotes) and a rendered `document_markdown`.
    """
    __tablename__ = "meeting_intelligence_documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True, nullable=True
    )
    batch_id: Mapped[int | None] = mapped_column(
        ForeignKey("meeting_intelligence_batches.id", ondelete="CASCADE"),
        index=True, nullable=True,
    )
    # Stable, opaque, human-referenceable transcript id (e.g. "TRX-...").
    transcript_id: Mapped[str] = mapped_column(String(64), index=True)

    project_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    department: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # Where the transcript came from: zoom | teams | meet | audio | text | ...
    meeting_source: Mapped[str] = mapped_column(String(100), default="text")
    meeting_date: Mapped[str | None] = mapped_column(String(100), nullable=True)
    meeting_title: Mapped[str | None] = mapped_column(String(300), nullable=True)
    participants: Mapped[list | None] = mapped_column(JSON, nullable=True)

    # Filled at upload for text docs; filled by the worker (after speech-to-text)
    # for audio docs. Nullable so an audio row can be queued before transcription.
    transcript_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Path on disk to the uploaded audio file (audio docs only).
    audio_path: Mapped[str | None] = mapped_column(String(400), nullable=True)

    document_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    document_markdown: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence_score: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Opaque id from the external source this doc was imported from (e.g. a
    # Plaud recording id), for traceability. Dedup is enforced by the
    # per-source mapping table (PlaudRecording); this is informational.
    external_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    # The source system's OWN summary/note, kept alongside our generated MOM so
    # the UI can show "what Plaud thought" next to "what we extracted". Rendered
    # text in source_summary; the raw structured note in source_summary_json.
    source_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_summary_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    # queued -> processing -> completed | failed
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    chunk_count: Mapped[int] = mapped_column(Integer, default=1)
    token_usage: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    # Worker bookkeeping: claimed_at marks an in-flight row (reaper re-queues
    # rows stuck longer than the stale threshold); attempts caps poison rows.
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    batch: Mapped["MeetingBatch | None"] = relationship(back_populates="documents")


class SessionMarker(Base):
    """A timestamped event inside a Session.

    Two marker types are used by the segmenter:
      - 'visitor_start' (with visitor_data) opens a window
      - 'visitor_end' closes it
    A 'visitor_start' without a matching 'visitor_end' is closed at either
    the next 'visitor_start' or the end of the recording (configurable).
    'note' markers carry free-text annotations and are ignored by the segmenter.
    """
    __tablename__ = "session_markers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    marker_type: Mapped[str] = mapped_column(String(30))  # visitor_start | visitor_end | note
    timestamp_seconds: Mapped[float] = mapped_column(Float, index=True)
    label: Mapped[str | None] = mapped_column(String(200), nullable=True)
    visitor_data: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    session: Mapped["Session"] = relationship(back_populates="markers")


class PlaudRecording(Base):
    """Dedup mapping between a Plaud recording and the records we created from
    it. One row per (user, plaud_file_id) — the unique constraint is what
    guarantees a recording is imported at most once, so re-running a sync never
    produces duplicate meeting docs or conversations.

    A recording becomes BOTH a MeetingDocument (Minutes-of-Meeting view) and a
    Conversation (standard Concap lead-analysis view + dashboard), tracked via
    ``document_id`` and ``conversation_id`` respectively. ``conversation_id`` is
    nullable so recordings imported before the conversation bridge existed can
    be backfilled on the next sync.
    """
    __tablename__ = "plaud_recordings"
    __table_args__ = (
        UniqueConstraint("user_id", "plaud_file_id", name="uq_plaud_user_file"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # The opaque recording / file id from Plaud (list_files -> file id).
    plaud_file_id: Mapped[str] = mapped_column(String(128), index=True)
    title: Mapped[str | None] = mapped_column(String(300), nullable=True)
    document_id: Mapped[int | None] = mapped_column(
        ForeignKey("meeting_intelligence_documents.id", ondelete="SET NULL"),
        index=True, nullable=True,
    )
    # The Conversation created from this recording (standard Concap analysis +
    # dashboard). Nullable: older rows imported before the conversation bridge
    # get backfilled on the next sync.
    conversation_id: Mapped[int | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"),
        index=True, nullable=True,
    )
    synced_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Brand(Base):
    """A brand the Quote agent can draft proposals under (Multi-Brand Quote
    Agent). Org-scoped: an org can keep several brands (e.g. a parent company
    and its product lines, or an agency's client-facing identities) and pick one
    per proposal. Holds the brand's identity, look, voice, reusable asset text,
    and proposal templates.

    A brand is a richer, multi-instance evolution of the single org-wide
    branding stored on Organization; the org branding remains the fallback when
    no brand is selected, so existing proposals are untouched.
    """
    __tablename__ = "brands"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    # At most one brand per org should carry this; enforced in the router, not
    # the schema, so a manual DB edit can never wedge the org into a 0/2-default
    # state the app can't recover from.
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)

    # Identity. `name` is the brand's own label (what the user picks from the
    # selector); `company_name` is the legal/entity name stamped on exports.
    name: Mapped[str] = mapped_column(String(200), default="Brand")
    company_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    logo_data_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    email: Mapped[str | None] = mapped_column(String(200), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    website: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Look. primary/accent drive the export colours (same renderer as org
    # branding); theme + typography are presentation hints carried into exports.
    primary_color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    accent_color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    currency: Mapped[str] = mapped_column(String(8), default="$")
    proposal_theme: Mapped[str | None] = mapped_column(String(40), nullable=True)
    typography: Mapped[str | None] = mapped_column(String(80), nullable=True)

    # Voice + context the AI uses to write on-brand. business_description and
    # brand_voice steer tone; assets_text is reference material extracted from
    # uploaded brand documents (service catalogue, pricing, marketing, T&C…),
    # treated as grounding DATA only.
    business_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    brand_voice: Mapped[str | None] = mapped_column(Text, nullable=True)
    assets_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # JSON list of {name, kind, chars} describing the uploaded asset documents
    # whose text is concatenated into assets_text.
    assets_meta: Mapped[list | None] = mapped_column(JSON, nullable=True)

    # Boilerplate stamped onto exports when present (rendered with the same
    # constrained rich-text subset as the proposal body).
    terms: Mapped[str | None] = mapped_column(Text, nullable=True)
    signature: Mapped[str | None] = mapped_column(Text, nullable=True)
    footer: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Proposal templates: JSON list of
    # {id, name, template_type, instructions}. The chosen template's
    # instructions steer the proposal structure for that brand.
    templates: Mapped[list | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Quote(Base):
    """A client proposal drafted by the Quote agent from one or more booth
    conversations. Claude proposes a narrative + line items from the
    transcript(s); the user edits everything, iterates with feedback (each
    refine snapshots the prior state into `versions`), and exports a branded
    PDF/Word doc.

    Org-scoped like every other record. The source is EITHER a single
    conversation OR the aggregate of every conversation for a contact
    (visitor) or company — see `source_type`.
    """
    __tablename__ = "quotes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True, nullable=True
    )

    # What the quote was generated from. Exactly one of the *_id columns is set
    # depending on source_type: conversation | contact | company.
    source_type: Mapped[str] = mapped_column(String(20), default="conversation")
    source_conversation_id: Mapped[int | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"), index=True, nullable=True
    )
    visitor_id: Mapped[int | None] = mapped_column(
        ForeignKey("visitors.id", ondelete="SET NULL"), index=True, nullable=True
    )
    company_id: Mapped[int | None] = mapped_column(
        ForeignKey("companies.id", ondelete="SET NULL"), index=True, nullable=True
    )
    # The brand this proposal was drafted under (Multi-Brand Quote Agent).
    # Nullable so proposals created before brands existed — or drafted with no
    # brand selected — fall back to the org's branding, leaving existing
    # behaviour unchanged. SET NULL so deleting a brand never deletes proposals.
    brand_id: Mapped[int | None] = mapped_column(
        ForeignKey("brands.id", ondelete="SET NULL"), index=True, nullable=True
    )

    title: Mapped[str] = mapped_column(String(300), default="Proposal")
    client_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    client_company: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # draft | final
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)

    # The narrative body of the proposal (plain prose — no markdown).
    proposal_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # JSON list of {description, quantity, unit_price}. Totals are computed.
    line_items: Mapped[list | None] = mapped_column(JSON, nullable=True)
    currency: Mapped[str] = mapped_column(String(8), default="$")
    tax_percent: Mapped[float] = mapped_column(Float, default=0.0)
    discount_percent: Mapped[float] = mapped_column(Float, default=0.0)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Frozen copy of the org branding at draft/export time so an old quote
    # keeps its look even if the org later changes its logo/colors.
    branding_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # JSON list of prior states, newest last: each entry is
    # {saved_at, feedback, proposal_text, line_items, title}.
    versions: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # The conversational thread between the user and the agent: a JSON list of
    # {role: "user"|"assistant", text, at}. Drives the chat workspace. The
    # proposal fields above stay the canonical, export-facing shape (Task #40).
    chat_messages: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # The conversation id(s) this proposal is grounded in (one or many), stored
    # so follow-up chat turns can re-ground in the same source. The legacy
    # source_conversation_id keeps the first id for back-compat displays.
    source_conversation_ids: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Text extracted from documents the user attached in chat (PDF/Word/text),
    # concatenated and capped. Folded into the agent grounding on every turn so
    # later refinements still take the attachments into account.
    attachments_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Display metadata for those attachments: JSON list of {name, chars}. The
    # raw extracted text lives in attachments_text; this is what the UI shows.
    attachments_meta: Mapped[list | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class ImportedMeeting(Base):
    """A meeting imported into the dedicated "Imported Meetings" tab.

    Sources span pasted/uploaded chat logs (Slack, Discord, email, SRT/VTT,
    plain text) normalized by ``conversation_parsers`` and cloud-recording
    transcripts pulled from Zoom / Google Meet / Microsoft Teams. Kept separate
    from the existing Meeting-Intelligence ``MeetingDocument`` so the original
    Meetings page is untouched.

    ``utterances`` is the canonical diarized body: a JSON list of
    ``{speaker, text, start, end}`` (start/end in ms, optional). ``speakers``
    holds the per-speaker summary used by the voiceprint UI: a JSON list of
    ``{speaker, name, talk_time_ms, utterance_count, matched, confidence}``.
    """

    __tablename__ = "imported_meetings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # manual | slack | discord | email | srt | zoom | google_meet | ms_teams
    provider: Mapped[str] = mapped_column(String(32), default="manual", index=True)
    # External id from the source system (Zoom UUID, Meet conference id, …) so
    # repeat syncs dedupe instead of re-importing the same recording.
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)

    title: Mapped[str] = mapped_column(String(400), default="Imported meeting")
    source: Mapped[str | None] = mapped_column(String(64), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    utterances: Mapped[list | None] = mapped_column(JSON, nullable=True)
    speakers: Mapped[list | None] = mapped_column(JSON, nullable=True)
    participants: Mapped[list | None] = mapped_column(JSON, nullable=True)

    # queued | processing | completed | failed
    status: Mapped[str] = mapped_column(String(20), default="completed", index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class CreatedMeeting(Base):
    """A meeting SCHEDULED from this app via a provider's API (Google Meet or
    Zoom) — distinct from ``ImportedMeeting`` (which holds transcripts pulled
    IN). Persisted so an org can see the meetings it created. These are shown
    only while the originating provider stays connected; disconnecting a
    provider hides (but does not delete) its created meetings.
    """

    __tablename__ = "created_meetings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    provider: Mapped[str] = mapped_column(String(32), index=True)  # google_meet | zoom
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)

    title: Mapped[str] = mapped_column(String(400), default="Meeting")
    join_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    html_link: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    start_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    duration_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    attendees: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Zoom passcode (if any) — surfaced in invitation emails. Google Meet has none.
    passcode: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Per-participant invitation tracking: a JSON list of
    # {email, status, invited_at, last_sent_at}. status is "invited" — Zoom/Meet
    # don't report accept/decline, so we only record what we know (who we emailed).
    invitations: Mapped[list | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ProviderMeeting(Base):
    """Meeting METADATA imported from a provider's meeting history (e.g. Zoom),
    distinct from ``ImportedMeeting`` (transcripts pulled in) and
    ``CreatedMeeting`` (scheduled from this app).

    Holds metadata ONLY — title, host, participants, timing, status — and never
    recordings/transcripts/media. This keeps the meeting-import path independent
    so cloud-recording sync can be layered on later without touching it.
    ``participants`` is a JSON list of ``{name, email}`` (best-effort; empty when
    the provider/plan doesn't expose them).
    """

    __tablename__ = "provider_meetings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    provider: Mapped[str] = mapped_column(String(32), index=True)  # zoom (more later)
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)

    title: Mapped[str] = mapped_column(String(400), default="Meeting")
    host_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    host_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    participants: Mapped[list | None] = mapped_column(JSON, nullable=True)

    start_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    end_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    duration_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # scheduled | completed | cancelled
    status: Mapped[str] = mapped_column(String(20), default="completed", index=True)
    join_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class SpeakerVoiceprint(Base):
    """A confirmed speaker in an org's cross-meeting registry.

    ``embedding`` is the L2-normalized lexical voiceprint vector (see
    ``services.voiceprints``) stored as a JSON list of floats. Anonymous
    speaker labels in newly-imported meetings are matched against these so the
    same person is recognized across meetings.
    """

    __tablename__ = "speaker_voiceprints"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    canonical_name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    embedding: Mapped[list | None] = mapped_column(JSON, nullable=True)
    sample_count: Mapped[int] = mapped_column(Integer, default=0)
    # When this voiceprint is the account holder's own profile, user_id links it
    # to that user and is_primary marks it so identification can prefer / flag it.
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=True
    )
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
