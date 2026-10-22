---
name: MS Teams OAuth tenant
description: Why Teams "connect" fails with consumer/sign-in/AADSTS90019 errors and how the tenant authority must be set.
---

# Microsoft Teams OAuth — tenant authority

The Teams OAuth authority is built into
`https://login.microsoftonline.com/{tenant}/oauth2/v2.0/{authorize,token}`.
`_ms_tenant_segment()` resolves precedence `ms_tenant_override -> ms_tenant ->
"organizations"` (pydantic default for `ms_tenant` is `"organizations"`), and
strips empty/whitespace values so a blank tenant can't build a broken authority.

## MS_TENANT secret is effectively un-editable → use MS_TENANT_OVERRIDE
The `MS_TENANT` **secret** value got stuck on a single-tenant GUID and could not
be changed: the secret-prompt UI pre-fills the existing value and saves it
unchanged, and you can't set a same-named plain env var (Replit blocks env vars
that collide with an existing secret, and there's no delete-secret tool). Fix:
added `ms_tenant_override` (env `MS_TENANT_OVERRIDE`, a *different* name → no
conflict) that takes precedence. Set `MS_TENANT_OVERRIDE=organizations` (shared
scope = dev+prod) to force multi-tenant regardless of the stuck secret.
**Why:** lets us control the authority when the secret can't be edited.
**How to apply:** to change the Teams tenant, set/clear `MS_TENANT_OVERRIDE`, not
`MS_TENANT`; republish for production to pick it up.

## Pick the authority to match the Azure app's "Supported account types"
- **Single tenant** ("this org only") → `MS_TENANT` = the org Directory (tenant)
  ID (a GUID). Only that org's accounts can sign in.
- **Multi-tenant** ("Multiple organizations") → `MS_TENANT` = `organizations`.
  Any company/work account from any tenant can sign in. **This app is
  multi-tenant**, so use `organizations`.
- Never use `common` here: it also offers personal Gmail/Outlook accounts, which
  a work-only app rejects, and Teams transcripts don't exist for personal
  accounts anyway.

## Error → cause map
- `unauthorized_client ... not enabled for consumers` / "We can't sign you in
  right now, try again later" → `common`/`consumers` authority against a
  work-only app, OR signing in with a **personal Gmail/Outlook account**. Fix:
  use a work/school account; set authority to `organizations` (multi-tenant) or
  the tenant GUID (single).
- `AADSTS90019: No tenant-identifying information` → the authority has an **empty
  tenant segment** (`login.microsoftonline.com//oauth2/...`). The running
  instance has `MS_TENANT=""`. Almost always **production running a stale
  deployment**: prod is a separate env that only picks up secret changes on
  **republish**. Fix: republish; the empty-guard now also prevents it.

## Other requirements
- Redirect URI (Web): `{PUBLIC_BASE_URL}/api/imported-meetings/providers/ms_teams/oauth/callback`
- Delegated Graph scopes: OnlineMeetings.Read, OnlineMeetingTranscript.Read.All,
  Calendars.Read, User.Read, offline_access (transcript scope needs admin
  consent). `Calendars.Read` is REQUIRED for the "pull recordings" flow's
  `GET /me/events` call — without it Graph returns **403 Forbidden** on the
  events query. Adding a scope requires the user to disconnect + reconnect
  (re-consent) so the new access token carries it.
- Secrets `MS_CLIENT_ID`/`MS_CLIENT_SECRET`/`MS_TENANT` are global, but the
  **deployment only applies new secret values on republish**.
- Multi-tenant apps without a verified publisher: external orgs' non-admin users
  can't self-consent ("Add MPN ID to verify publisher") — needs their admin's
  consent or publisher verification. Own-org admins can always consent.
