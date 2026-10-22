import logging
from pathlib import Path

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import get_settings

logger = logging.getLogger("booth.db")

settings = get_settings()

is_sqlite_url = settings.database_url.startswith("sqlite")
connect_args = {"check_same_thread": False} if is_sqlite_url else {}


def _ensure_sqlite_dir(database_url: str) -> None:
    """Create the parent directory for a file-backed SQLite database.

    SQLite raises "unable to open database file" if the directory holding the
    .db file doesn't exist — it will NOT create intermediate directories. On a
    fresh deploy the `data/` folder is gitignored and therefore absent from the
    build, so without this the very first boot crashes during init_db, the
    readiness gate never opens, and every API call 500s/503s after publishing.
    Creating the directory here (idempotently) makes a clean publish self-heal.
    """
    try:
        db_path = make_url(database_url).database
    except Exception:  # noqa: BLE001 — fall back to no-op on exotic URLs
        return
    # ":memory:" / shared-cache in-memory DBs have no on-disk path.
    if not db_path or db_path == ":memory:":
        return
    parent = Path(db_path).expanduser().parent
    if parent and not parent.exists():
        parent.mkdir(parents=True, exist_ok=True)
        logger.info("Created SQLite data directory: %s", parent)


if is_sqlite_url:
    _ensure_sqlite_dir(settings.database_url)

# Managed Postgres (Helium / Neon / RDS) closes idle connections from the
# server side after a few minutes. Without pool_pre_ping, the next request
# gets handed a now-dead connection and crashes with
# "SSL connection has been closed unexpectedly". pool_pre_ping issues a
# cheap SELECT 1 on checkout to validate the connection, and pool_recycle
# proactively replaces connections older than 30 minutes — well under any
# provider's idle timeout. Neither matters for SQLite.
engine_kwargs: dict = {"connect_args": connect_args, "future": True}
if not is_sqlite_url:
    engine_kwargs["pool_pre_ping"] = True
    engine_kwargs["pool_recycle"] = 1800

engine = create_engine(settings.database_url, **engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


# SQLite ignores FK constraints unless explicitly turned on per connection.
# Without this, ON DELETE SET NULL / CASCADE silently no-ops and orphan rows
# can pile up. Postgres enforces FKs by default, so this is a no-op there.
if is_sqlite_url:
    @event.listens_for(Engine, "connect")
    def _sqlite_enable_fk(dbapi_connection, _record):  # type: ignore[no-redef]
        cur = dbapi_connection.cursor()
        try:
            cur.execute("PRAGMA foreign_keys=ON")
        finally:
            cur.close()


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from . import models  # noqa: F401 — register models on Base.metadata
    Base.metadata.create_all(bind=engine)
    _self_heal_schema()


def _self_heal_schema() -> None:
    """SQLAlchemy's create_all() never alters existing tables. We ALTER TABLE
    in-place when a column the model expects is missing, so adding a new
    column to a model doesn't require manual migrations on existing booth
    tablets or Helium Postgres databases.

    Only safely-nullable columns belong here. Anything that needs a non-null
    default, a data backfill, or an index drop should still go through a
    real migration (Alembic).
    """
    is_sqlite = settings.database_url.startswith("sqlite")
    is_pg = "postgres" in settings.database_url

    if not (is_sqlite or is_pg):
        return

    # (table, column, ddl-fragment). Only add safely-nullable columns here.
    needed = [
        ("conversations", "client_capture_id", "VARCHAR(64)"),
        ("conversations", "session_id", "INTEGER"),
        ("conversations", "session_start_seconds", "FLOAT"),
        ("conversations", "session_end_seconds", "FLOAT"),
        # Multi-tenancy
        ("users", "org_id", "INTEGER"),
        ("users", "role", "VARCHAR(20)"),
        ("users", "must_change_password", "BOOLEAN"),
        ("visitors", "org_id", "INTEGER"),
        ("conversations", "org_id", "INTEGER"),
        ("sessions", "org_id", "INTEGER"),
        # AI auto-detection
        ("sessions", "diarized_segments", "JSON"),
        ("sessions", "ai_proposal", "JSON"),
        # Semantic search + topic labelling
        ("conversations", "topic", "VARCHAR(200)"),
        ("conversations", "embedding", "JSON"),
        # Event/category master
        ("conversations", "event_day_id", "INTEGER"),
        ("sessions", "event_day_id", "INTEGER"),
        ("events", "start_date", "TIMESTAMP"),
        # Scanner / contact fields
        ("visitors", "website", "VARCHAR(255)"),
        ("visitors", "gst_number", "VARCHAR(30)"),
        ("visitors", "address", "TEXT"),
        ("visitors", "contact_type", "VARCHAR(20) DEFAULT 'lead'"),
        ("visitors", "scan_image_path", "VARCHAR(300)"),
        ("visitors", "scan_raw_text", "TEXT"),
        ("visitors", "scan_metadata", "JSON"),
        # AI enrichment (LinkedIn + quick research)
        ("visitors", "linkedin_url", "VARCHAR(500)"),
        ("visitors", "person_summary", "TEXT"),
        ("companies", "summary", "TEXT"),
        ("companies", "competitors", "JSON"),
        ("companies", "research_updated_at", "TIMESTAMP"),
        # Company link (companies table itself is created by create_all)
        ("visitors", "company_id", "INTEGER"),
        ("conversations", "company_id", "INTEGER"),
        # HubSpot mirror columns
        ("visitors", "hubspot_contact_id", "VARCHAR(64)"),
        ("visitors", "hubspot_synced_at", "TIMESTAMP"),
        ("companies", "hubspot_company_id", "VARCHAR(64)"),
        ("companies", "hubspot_synced_at", "TIMESTAMP"),
        ("conversations", "hubspot_note_id", "VARCHAR(64)"),
        ("conversations", "hubspot_deal_id", "VARCHAR(64)"),
        ("conversations", "hubspot_synced_at", "TIMESTAMP"),
        ("conversations", "hubspot_sync_error", "TEXT"),
        # HubSpot OAuth (per-org connection) columns on organizations. Booleans
        # are added nullable (no default) for cross-DB safety; None is read as
        # the default at the application layer.
        ("organizations", "hubspot_access_token_enc", "TEXT"),
        ("organizations", "hubspot_refresh_token_enc", "TEXT"),
        ("organizations", "hubspot_token_expires_at", "TIMESTAMP"),
        ("organizations", "hubspot_portal_id", "VARCHAR(64)"),
        ("organizations", "hubspot_connected_at", "TIMESTAMP"),
        ("organizations", "hubspot_oauth_state", "VARCHAR(64)"),
        ("organizations", "hubspot_needs_reconnect", "BOOLEAN"),
        ("organizations", "hubspot_auto_sync", "BOOLEAN"),
        ("organizations", "hubspot_create_deals", "BOOLEAN"),
        ("organizations", "hubspot_disabled", "BOOLEAN"),
        ("organizations", "hubspot_sync_contacts", "BOOLEAN"),
        ("organizations", "hubspot_sync_companies", "BOOLEAN"),
        ("organizations", "hubspot_sync_notes", "BOOLEAN"),
        ("organizations", "hubspot_sync_transcript", "BOOLEAN"),
        ("organizations", "hubspot_sync_tasks", "BOOLEAN"),
        ("organizations", "hubspot_sync_insights", "BOOLEAN"),
        ("conversations", "hubspot_task_ids", "JSON"),
        # Salesforce mirror columns (per-org OAuth + per-record ids), all
        # nullable so the in-place migration needs no backfill.
        ("visitors", "salesforce_contact_id", "VARCHAR(64)"),
        ("visitors", "salesforce_synced_at", "TIMESTAMP"),
        ("companies", "salesforce_account_id", "VARCHAR(64)"),
        ("companies", "salesforce_synced_at", "TIMESTAMP"),
        ("conversations", "salesforce_note_id", "VARCHAR(64)"),
        ("conversations", "salesforce_opportunity_id", "VARCHAR(64)"),
        ("conversations", "salesforce_synced_at", "TIMESTAMP"),
        ("conversations", "salesforce_sync_error", "TEXT"),
        ("organizations", "salesforce_access_token_enc", "TEXT"),
        ("organizations", "salesforce_refresh_token_enc", "TEXT"),
        ("organizations", "salesforce_token_expires_at", "TIMESTAMP"),
        ("organizations", "salesforce_instance_url", "VARCHAR(255)"),
        ("organizations", "salesforce_org_id", "VARCHAR(64)"),
        ("organizations", "salesforce_connected_at", "TIMESTAMP"),
        ("organizations", "salesforce_oauth_state", "VARCHAR(64)"),
        ("organizations", "salesforce_needs_reconnect", "BOOLEAN"),
        ("organizations", "salesforce_auto_sync", "BOOLEAN"),
        ("organizations", "salesforce_create_opportunities", "BOOLEAN"),
        ("organizations", "salesforce_disabled", "BOOLEAN"),
        # Meeting-platform OAuth (per-org connections for the Imported Meetings
        # tab). All nullable so the in-place migration needs no backfill.
        ("organizations", "zoom_access_token_enc", "TEXT"),
        ("organizations", "zoom_refresh_token_enc", "TEXT"),
        ("organizations", "zoom_token_expires_at", "TIMESTAMP"),
        ("organizations", "zoom_account_label", "VARCHAR(255)"),
        ("organizations", "zoom_connected_at", "TIMESTAMP"),
        ("organizations", "zoom_oauth_state", "VARCHAR(64)"),
        ("organizations", "zoom_needs_reconnect", "BOOLEAN"),
        ("organizations", "zoom_disabled", "BOOLEAN"),
        ("organizations", "gmeet_access_token_enc", "TEXT"),
        ("organizations", "gmeet_refresh_token_enc", "TEXT"),
        ("organizations", "gmeet_token_expires_at", "TIMESTAMP"),
        ("organizations", "gmeet_account_label", "VARCHAR(255)"),
        ("organizations", "gmeet_connected_at", "TIMESTAMP"),
        ("organizations", "gmeet_oauth_state", "VARCHAR(64)"),
        ("organizations", "gmeet_needs_reconnect", "BOOLEAN"),
        ("organizations", "gmeet_disabled", "BOOLEAN"),
        ("organizations", "teams_access_token_enc", "TEXT"),
        ("organizations", "teams_refresh_token_enc", "TEXT"),
        ("organizations", "teams_token_expires_at", "TIMESTAMP"),
        ("organizations", "teams_account_label", "VARCHAR(255)"),
        ("organizations", "teams_connected_at", "TIMESTAMP"),
        ("organizations", "teams_oauth_state", "VARCHAR(64)"),
        ("organizations", "teams_needs_reconnect", "BOOLEAN"),
        ("organizations", "teams_disabled", "BOOLEAN"),
        # Meeting management: passcode + per-participant invitation tracking on
        # app-created meetings. Both nullable so the migration needs no backfill.
        ("created_meetings", "passcode", "VARCHAR(64)"),
        ("created_meetings", "invitations", "JSON"),
        # Default HubSpot owner for synced Tasks (null = unassigned).
        ("organizations", "hubspot_default_owner_id", "VARCHAR(64)"),
        # Plaud OAuth (per-user connection) columns on users. All nullable so
        # the in-place migration can add them with no backfill.
        ("users", "plaud_access_token_enc", "TEXT"),
        ("users", "plaud_refresh_token_enc", "TEXT"),
        ("users", "plaud_token_expires_at", "TIMESTAMP"),
        ("users", "plaud_connected_at", "TIMESTAMP"),
        ("users", "plaud_oauth_state", "VARCHAR(64)"),
        ("users", "plaud_code_verifier", "VARCHAR(128)"),
        ("users", "plaud_client_id", "VARCHAR(255)"),
        ("users", "plaud_client_secret_enc", "TEXT"),
        ("users", "plaud_needs_reconnect", "BOOLEAN"),
        ("users", "plaud_account_email", "VARCHAR(255)"),
        ("users", "plaud_account_name", "VARCHAR(255)"),
        ("users", "plaud_last_synced_at", "TIMESTAMP"),
        # Meeting-intelligence: source-system summary kept alongside our MOM.
        ("meeting_intelligence_documents", "external_id", "VARCHAR(128)"),
        ("meeting_intelligence_documents", "source_summary", "TEXT"),
        ("meeting_intelligence_documents", "source_summary_json", "JSON"),
        # Plaud recording -> Conversation bridge (standard Concap analysis).
        ("plaud_recordings", "conversation_id", "INTEGER"),
        # Branding (Quote agent) columns on organizations. The quotes table
        # itself is created by create_all; only existing-table columns belong
        # here. All nullable so the in-place migration needs no backfill.
        ("organizations", "brand_company_name", "VARCHAR(200)"),
        ("organizations", "brand_logo_data_url", "TEXT"),
        ("organizations", "brand_address", "TEXT"),
        ("organizations", "brand_email", "VARCHAR(200)"),
        ("organizations", "brand_phone", "VARCHAR(50)"),
        ("organizations", "brand_website", "VARCHAR(255)"),
        ("organizations", "brand_primary_color", "VARCHAR(20)"),
        ("organizations", "brand_accent_color", "VARCHAR(20)"),
        ("organizations", "brand_currency", "VARCHAR(8)"),
        ("organizations", "brand_updated_at", "TIMESTAMP"),
        # Conversational quote agent: chat thread + the multi-conversation
        # grounding set. The quotes table itself is created by create_all; only
        # these existing-table columns need the in-place add. Both nullable.
        ("quotes", "chat_messages", "JSON"),
        ("quotes", "source_conversation_ids", "JSON"),
        # Quote-agent document attachments: extracted text + display metadata.
        ("quotes", "attachments_text", "TEXT"),
        ("quotes", "attachments_meta", "JSON"),
        # Multi-Brand Quote Agent: which brand a proposal was drafted under. The
        # brands table itself is created by create_all; only this existing-table
        # column needs the in-place add. Nullable so old quotes need no backfill.
        ("quotes", "brand_id", "INTEGER"),
        # Primary User Voice Profile: identity fields on users + consent stamp,
        # and the user link / primary flag on the speaker registry. All nullable
        # so the in-place migration needs no backfill.
        ("users", "display_name", "VARCHAR(120)"),
        ("users", "job_title", "VARCHAR(160)"),
        ("users", "company_name", "VARCHAR(200)"),
        ("users", "department", "VARCHAR(160)"),
        ("users", "voice_consent_at", "TIMESTAMP"),
        ("speaker_voiceprints", "user_id", "INTEGER"),
        ("speaker_voiceprints", "is_primary", "BOOLEAN"),
    ]

    inspector = inspect(engine)
    # Track columns we just created this pass so one-shot backfills run
    # exactly once — at the upgrade boundary — instead of every boot. Without
    # this, e.g. unlinking a transcript via PATCH /conversations/{id}/company
    # would be silently undone on next restart by the visitor-derived backfill.
    newly_added: set[tuple[str, str]] = set()
    with engine.begin() as conn:
        for table, column, ddl in needed:
            if not inspector.has_table(table):
                continue
            existing = {c["name"] for c in inspector.get_columns(table)}
            if column in existing:
                continue
            newly_added.add((table, column))
            logger.warning("Adding missing column %s.%s", table, column)
            if is_pg:
                conn.execute(text(
                    f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {ddl}"
                ))
            else:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
            if column == "client_capture_id":
                conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS ix_conversations_client_capture_id "
                    "ON conversations(client_capture_id)"
                ))
            if column == "event_day_id" and table == "conversations":
                # Index for the join in list_conversations.
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS ix_conversations_event_day_id "
                    "ON conversations(event_day_id)"
                ))
                # Postgres lets us retro-add a real FK with ON DELETE SET NULL
                # so deleting an event cleans its references. SQLite can't add
                # FKs to existing tables — we fall back to enforcing the
                # set-null in the event delete handler (services-side).
                if is_pg:
                    conn.execute(text(
                        "DO $$ BEGIN "
                        "IF NOT EXISTS (SELECT 1 FROM pg_constraint "
                        "WHERE conname = 'fk_conversations_event_day_id') THEN "
                        "ALTER TABLE conversations ADD CONSTRAINT fk_conversations_event_day_id "
                        "FOREIGN KEY (event_day_id) REFERENCES event_days(id) "
                        "ON DELETE SET NULL; "
                        "END IF; END $$;"
                    ))
            if column == "event_day_id" and table == "sessions":
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS ix_sessions_event_day_id "
                    "ON sessions(event_day_id)"
                ))
                # Same SQLite-can't-add-FK story as conversations.event_day_id —
                # the event delete handler enforces the set-null there.
                if is_pg:
                    conn.execute(text(
                        "DO $$ BEGIN "
                        "IF NOT EXISTS (SELECT 1 FROM pg_constraint "
                        "WHERE conname = 'fk_sessions_event_day_id') THEN "
                        "ALTER TABLE sessions ADD CONSTRAINT fk_sessions_event_day_id "
                        "FOREIGN KEY (event_day_id) REFERENCES event_days(id) "
                        "ON DELETE SET NULL; "
                        "END IF; END $$;"
                    ))
            if column == "company_id" and table == "conversations":
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS ix_conversations_company_id "
                    "ON conversations(company_id)"
                ))
                # Same SQLite-can't-add-FK story as event_day_id. The
                # conversation-link router enforces ownership at write time.
                if is_pg:
                    conn.execute(text(
                        "DO $$ BEGIN "
                        "IF NOT EXISTS (SELECT 1 FROM pg_constraint "
                        "WHERE conname = 'fk_conversations_company_id') THEN "
                        "ALTER TABLE conversations ADD CONSTRAINT fk_conversations_company_id "
                        "FOREIGN KEY (company_id) REFERENCES companies(id) "
                        "ON DELETE SET NULL; "
                        "END IF; END $$;"
                    ))

    _backfill_default_org()
    _backfill_companies_from_visitors()
    # One-shot: only seed conversations.company_id from the visitor when the
    # column was just added. Skipping it on subsequent boots means deliberate
    # unlinks (PATCH .../company with null) are durable across restarts.
    if ("conversations", "company_id") in newly_added:
        _backfill_conversation_company_from_visitor()


def _backfill_default_org() -> None:
    """Existing rows (created before multi-tenancy) have NULL org_id. Put
    them all into one 'Legacy workspace' org so nothing becomes invisible
    after the upgrade. The earliest user becomes its owner.
    """
    from .models import Conversation, Organization, ROLE_OWNER, Session, User, Visitor

    with SessionLocal() as db:
        orphan_users = db.query(User).filter(User.org_id.is_(None)).all()
        orphan_visitors = db.query(Visitor).filter(Visitor.org_id.is_(None)).count()
        orphan_convs = db.query(Conversation).filter(Conversation.org_id.is_(None)).count()
        orphan_sessions = db.query(Session).filter(Session.org_id.is_(None)).count()

        if not (orphan_users or orphan_visitors or orphan_convs or orphan_sessions):
            return

        org = db.query(Organization).filter(Organization.name == "Legacy workspace").first()
        if org is None:
            org = Organization(name="Legacy workspace", org_type="company")
            db.add(org)
            db.flush()

        for i, u in enumerate(sorted(orphan_users, key=lambda x: x.id)):
            u.org_id = org.id
            if not u.role:
                u.role = ROLE_OWNER if i == 0 else "member"
        db.query(Visitor).filter(Visitor.org_id.is_(None)).update({Visitor.org_id: org.id})
        db.query(Conversation).filter(Conversation.org_id.is_(None)).update({Conversation.org_id: org.id})
        db.query(Session).filter(Session.org_id.is_(None)).update({Session.org_id: org.id})
        db.commit()
        logger.warning("Backfilled legacy rows into org #%s 'Legacy workspace'", org.id)


def _backfill_companies_from_visitors() -> None:
    """Promote each unique visitor.company string into a real Company row
    (per-org) and set visitor.company_id. Idempotent — visitors with a
    company_id already set are skipped, and companies are matched by
    case-insensitive name within the org.
    """
    from .models import Company, Visitor

    with SessionLocal() as db:
        orphans = (
            db.query(Visitor)
            .filter(Visitor.company.is_not(None), Visitor.company_id.is_(None))
            .all()
        )
        if not orphans:
            return

        # Cache existing companies per (org_id, lowercased name) so we don't
        # do N queries when many visitors share a company.
        existing: dict[tuple[int | None, str], Company] = {}
        for c in db.query(Company).all():
            existing[(c.org_id, c.name.strip().lower())] = c

        created = 0
        for v in orphans:
            name = (v.company or "").strip()
            if not name:
                continue
            key = (v.org_id, name.lower())
            company = existing.get(key)
            if company is None:
                company = Company(
                    org_id=v.org_id,
                    name=name,
                    website=v.website,
                    industry=v.industry,
                    address=v.address,
                    gst_number=v.gst_number,
                )
                db.add(company)
                db.flush()
                existing[key] = company
                created += 1
            v.company_id = company.id
        db.commit()
        if created:
            logger.warning("Backfill: promoted %s company string(s) into Company rows", created)


def _backfill_conversation_company_from_visitor() -> None:
    """Seed Conversation.company_id from the linked visitor's company_id for
    existing rows so the new direct-link query path mirrors what the legacy
    visitor-transitive path used to return.

    Idempotent — only touches rows where conversations.company_id IS NULL
    and the visitor has a company_id. Done in raw SQL so a single statement
    covers any number of orgs without an N+1.
    """
    with engine.begin() as conn:
        conn.execute(text(
            "UPDATE conversations "
            "SET company_id = ("
            "  SELECT visitors.company_id FROM visitors "
            "  WHERE visitors.id = conversations.visitor_id"
            ") "
            "WHERE conversations.company_id IS NULL "
            "AND EXISTS ("
            "  SELECT 1 FROM visitors "
            "  WHERE visitors.id = conversations.visitor_id "
            "  AND visitors.company_id IS NOT NULL"
            ")"
        ))
