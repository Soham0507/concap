from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Resolve .env relative to the backend root, not the current working directory.
# Otherwise running uvicorn from a different folder silently misses the file.
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
_ENV_FILE = _BACKEND_ROOT / ".env"


class Settings(BaseSettings):
    openai_api_key: str = ""
    whisper_model: str = "whisper-1"
    # gpt-4o (not -mini) produces materially more specific, action-oriented
    # conversation summaries and more reliable structured extraction.
    analysis_model: str = "gpt-4o"
    embedding_model: str = "text-embedding-3-small"
    # Model used for AI "quick research" via the OpenAI Responses API web_search
    # tool. Must be a model that supports the hosted web_search tool. gpt-4o
    # (not -mini) is materially better at the multi-query agentic search needed
    # to locate an ordinary professional's LinkedIn profile, not just famous ones.
    research_model: str = "gpt-4o"

    # Optional Deepgram for diarization. When set, transcription uses
    # Deepgram with `diarize=true` and the GPT analysis sees a
    # speaker-labeled transcript. When empty, Whisper is used.
    deepgram_api_key: str = ""
    deepgram_model: str = "nova-3"
    stt_provider: str = "auto"  # auto | whisper | deepgram

    # Google Cloud Vision service-account JSON, stored verbatim as a secret.
    # When empty, the scanner endpoints fail with a clear "not configured"
    # 503 instead of crashing the app.
    google_application_credentials_json: str = ""

    # Anthropic (Claude) via Replit AI Integrations — powers the Quote agent.
    # The integration blueprint sets AI_INTEGRATIONS_ANTHROPIC_API_KEY (a dummy
    # placeholder) and AI_INTEGRATIONS_ANTHROPIC_BASE_URL automatically; no own
    # API key is required and usage is billed to Replit credits. base_url is the
    # meaningful "configured?" signal — the api key is intentionally a stub.
    ai_integrations_anthropic_api_key: str = ""
    ai_integrations_anthropic_base_url: str = ""
    # Claude model used to draft + refine proposals. Balanced default per the
    # Anthropic integration's guidance (claude-sonnet-4-6).
    quote_model: str = "claude-sonnet-4-6"

    database_url: str = "sqlite:///./data/booth.db"
    audio_dir: str = "./data/audio"
    max_audio_mb: int = 800

    event_name: str = "Demo Conference 2026"
    booth_name: str = "Booth A1"

    cors_origins: str = "*"

    # Auth. If auth_secret is empty a random one is generated at startup —
    # fine for a single-process dev server, but tokens won't survive a
    # restart and won't work across multiple workers. Set it in .env for
    # anything real.
    auth_secret: str = ""
    auth_token_ttl_hours: int = 168  # 7 days — long enough to span a multi-day event

    # HubSpot OAuth (public app) — per-org connections. When client id/secret
    # and a public base URL are configured, each organization connects its own
    # HubSpot portal via OAuth. Each org's access + refresh tokens are stored
    # encrypted on the Organization row; there is no shared global token.
    hubspot_client_id: str = ""
    hubspot_client_secret: str = ""
    # Public base URL used to build the OAuth redirect URI, e.g.
    # https://app.example.com. When empty we derive it from REPLIT_DEV_DOMAIN
    # at request time so dev works without extra config.
    public_base_url: str = ""
    # Optional dedicated key for encrypting stored HubSpot tokens. Defaults to
    # the auth secret. Rotating it invalidates stored tokens (forces reconnect).
    secret_encryption_key: str = ""

    # Salesforce OAuth (connected app) — per-org connections, mirroring the
    # HubSpot model above. Each org connects its own Salesforce org via OAuth;
    # access + refresh tokens are stored encrypted on the Organization row.
    salesforce_client_id: str = ""
    salesforce_client_secret: str = ""
    # Login host. Use https://test.salesforce.com for sandboxes.
    salesforce_login_url: str = "https://login.salesforce.com"
    # REST API version path segment, e.g. "v60.0".
    salesforce_api_version: str = "v60.0"
    # Salesforce token responses carry no `expires_in`; the session lifetime is
    # an org setting (default 2h). We assume this long and proactively refresh
    # before it, so a sync never rides an expired session.
    salesforce_session_lifetime_seconds: int = 7200

    # Plaud (voice recorder) — per-USER OAuth connection to Plaud's remote MCP
    # server. Each user connects their own Plaud account; access + refresh
    # tokens are stored encrypted on the User row (no shared/global account).
    # The MCP endpoint we speak to as an MCP client over streamable HTTP:
    plaud_mcp_url: str = "https://mcp.plaud.ai/mcp"
    # OAuth client credentials. Optional — when empty we fall back to RFC 7591
    # Dynamic Client Registration at connect time and store the issued client
    # per-user. Explicit account-OAuth aliases prevent case-insensitive settings
    # from interpreting the user's Plaud_Client_ID (Embedded partner key) here.
    # Only set these aliases for a pre-registered PERSONAL-ACCOUNT OAuth app.
    plaud_client_id: str = Field(default="", validation_alias="PLAUD_ACCOUNT_OAUTH_CLIENT_ID")
    plaud_client_secret: str = Field(default="", validation_alias="PLAUD_ACCOUNT_OAUTH_CLIENT_SECRET")
    # OAuth endpoints. Optional overrides — when empty they are discovered from
    # the MCP server's authorization-server metadata at connect/refresh time.
    plaud_authorize_url: str = ""
    plaud_token_url: str = ""
    plaud_registration_url: str = ""
    # Space-separated OAuth scopes to request. Empty = request none (the AS
    # grants its default scope set).
    plaud_scopes: str = ""

    # Meeting-platform OAuth (Imported Meetings tab) — per-org connections to
    # pull cloud-recording transcripts. Each is a standard authorization-code
    # confidential-client app; tokens are stored encrypted on the Organization
    # row, mirroring the HubSpot/Salesforce model. Empty client id/secret means
    # the provider is "not configured" and the connect button is disabled.
    zoom_client_id: str = ""
    zoom_client_secret: str = ""
    # Google Cloud OAuth client (used for Google Meet transcripts via Meet/Drive
    # APIs). The same client can be reused if you already have a Google app.
    google_client_id: str = ""
    google_client_secret: str = ""

    # "Sign in with Google" (login/signup). Optional — falls back to the Meet
    # integration's client above when unset, since one Google Cloud OAuth
    # client can serve both flows (each authorize request only asks for its
    # own scopes, so sign-in only ever requests openid/email/profile). Set
    # these separately only if you want login split from the Meet client.
    google_login_client_id: str = ""
    google_login_client_secret: str = ""
    # Microsoft (Entra ID) app registration for Teams meeting transcripts.
    ms_client_id: str = ""
    ms_client_secret: str = ""
    # Microsoft tenant authority segment. "organizations" = multi-tenant work/
    # school accounts (matches an Azure app set to "Multiple organizations").
    # Use a tenant-id GUID to lock to a single org; avoid "common" (it also
    # offers personal accounts, which can't read Teams transcripts).
    ms_tenant: str = "organizations"
    # Takes precedence over ms_tenant when set. Exists because MS_TENANT is
    # stored as a secret whose value can be hard to change in the UI; this is a
    # plain env var (different name => no secret conflict) we can set freely.
    ms_tenant_override: str = ""
    # Access-token lifetimes (seconds) used to schedule proactive refreshes
    # when the token endpoint omits expires_in.
    meeting_token_lifetime_seconds: int = 3600

    # --- Outbound email (Universal Meeting Invitation Service) -------------
    # Meeting invitations are sent from THIS application's own backend email
    # account over SMTP — NOT the user's connected Google/Microsoft/Zoom
    # account. This makes invitations provider-independent: a meeting created or
    # imported via any provider is invited the same way. Any SMTP-capable email
    # service works (SendGrid, Amazon SES, Mailgun, Resend, Postmark, Gmail /
    # Google Workspace, ...). When unconfigured, invitation sends fail with a
    # clear "email isn't configured" message instead of a provider-specific one.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    # STARTTLS on the standard submission port 587 (the common default). Set
    # smtp_use_ssl=true (and port 465) for implicit TLS instead.
    smtp_use_tls: bool = True
    smtp_use_ssl: bool = False
    # Visible From address/name on invitation emails. from_email falls back to
    # smtp_username when left empty (many providers require From == auth user).
    smtp_from_email: str = ""
    smtp_from_name: str = "Concap AI"

    model_config = SettingsConfigDict(env_file=str(_ENV_FILE), env_file_encoding="utf-8", extra="ignore")

    def email_configured(self) -> bool:
        """True when the backend can send invitation emails — a host plus a
        usable From address (explicit from_email or the auth username)."""
        return bool(self.smtp_host and (self.smtp_from_email or self.smtp_username))

    def resolved_from_email(self) -> str:
        return self.smtp_from_email or self.smtp_username

    def resolved_auth_secret(self) -> str:
        import secrets

        if not self.auth_secret:
            # Stable for the lifetime of this process.
            object.__setattr__(self, "auth_secret", secrets.token_hex(32))
        return self.auth_secret

    def resolved_public_base_url(self) -> str:
        """Base URL for OAuth redirects. Falls back to the Replit dev domain
        so connecting works out of the box in development."""
        import os

        if self.public_base_url:
            return self.public_base_url.rstrip("/")
        dev = os.environ.get("REPLIT_DEV_DOMAIN")
        if dev:
            return f"https://{dev.rstrip('/')}"
        return ""

    def hubspot_oauth_configured(self) -> bool:
        """True when per-org OAuth can run (client id/secret + a base URL)."""
        return bool(
            self.hubspot_client_id
            and self.hubspot_client_secret
            and self.resolved_public_base_url()
        )

    def resolved_google_login_client_id(self) -> str:
        return self.google_login_client_id or self.google_client_id

    def resolved_google_login_client_secret(self) -> str:
        return self.google_login_client_secret or self.google_client_secret

    def google_login_oauth_configured(self) -> bool:
        """True when "Sign in with Google" can run (client id/secret, from
        either the dedicated login settings or the shared Meet client, plus
        a public base URL for the redirect)."""
        return bool(
            self.resolved_google_login_client_id()
            and self.resolved_google_login_client_secret()
            and self.resolved_public_base_url()
        )

    def salesforce_oauth_configured(self) -> bool:
        """True when per-org Salesforce OAuth can run (client id/secret + a
        public base URL for the redirect)."""
        return bool(
            self.salesforce_client_id
            and self.salesforce_client_secret
            and self.resolved_public_base_url()
        )

    def anthropic_configured(self) -> bool:
        """True when the Quote agent can call Claude. Only the base URL matters
        — the api key is a dummy stub set by the AI Integrations blueprint."""
        return bool(self.ai_integrations_anthropic_base_url)

    def plaud_oauth_configured(self) -> bool:
        """True when the per-user Plaud connection can be started. We only need
        a public base URL (to build the OAuth redirect) and the MCP URL — the
        OAuth client is either pre-configured or obtained via Dynamic Client
        Registration, and the endpoints are discovered, both at connect time."""
        return bool(self.resolved_public_base_url() and self.plaud_mcp_url)

    @property
    def plaud_scope_list(self) -> list[str]:
        return [s.strip() for s in self.plaud_scopes.split() if s.strip()]

    @property
    def audio_path(self) -> Path:
        p = Path(self.audio_dir)
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
