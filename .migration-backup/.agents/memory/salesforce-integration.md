---
name: Salesforce integration
description: Per-org Salesforce OAuth + conversation sync; how it mirrors HubSpot and where it deliberately differs.
---

# Salesforce integration

Per-org Salesforce integration built to mirror the HubSpot one. Same shape:
per-org encrypted tokens (Fernet), signed single-use OAuth state, per-org-locked
refresh with transient-vs-permanent classification, contextvar credential
binding for the sync service, `sync_conversation_safe` persisting a
`*_sync_error` for the UI. No shared/global token fallback.

## Where Salesforce deliberately differs from HubSpot
- **No `expires_in` in token/refresh responses.** Expiry is computed locally
  from `settings.salesforce_session_lifetime_seconds` (default 7200). Anything
  asserting/relying on a server-provided lifetime is wrong for Salesforce.
- **`instance_url` is the REST API base**, returned on both code-exchange and
  refresh. It must be persisted on the org and re-read on refresh (it can
  change). The sync service binds it via contextvar alongside the token.
- **Org id comes from the identity URL** (`id` field, e.g.
  `https://login.salesforce.com/id/00Dxx.../005xx...`) — parsed in
  `complete_connection`, not from a separate account-info network call (HubSpot
  fetches portal info separately).
- **Refresh responses usually omit a new refresh token** — only overwrite the
  stored refresh token when one is actually present, else preserve the old one.
- OAuth error class is `SalesforceOAuthError` (has `.transient`); login host is
  `https://login.salesforce.com`, api version `v60.0`.

## Sync mapping
SOQL search (escaped via `_soql_escape`) → upsert Account, then Contact with
`AccountId` link, classic Note, optional Opportunity + OpportunityContactRole.
Industry map + temperature→stage helpers. 404 on a cached id triggers re-create.

## Testing gotchas (SQLite)
- `org.salesforce_token_expires_at` comes back **naive** from SQLite after
  `db.refresh`; normalize with `oauth._aware(...)` before comparing to an
  aware `datetime.now(timezone.utc)`.
- Router callback params are FastAPI `Query(...)` objects. When calling
  `salesforce_oauth_callback(...)` directly in a test and exercising the
  provider-error branch, pass `error_description=None` explicitly — otherwise
  the unset `Query(None)` sentinel is truthy and `error_description or error`
  hands a non-str into `quote()`.
- conftest autouse `settings` fixture must set `salesforce_client_id/secret`
  (login_url/api_version/session_lifetime have defaults but set them too).
