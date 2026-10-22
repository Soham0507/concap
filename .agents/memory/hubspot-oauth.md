---
name: HubSpot per-org OAuth
description: Design constraints + HubSpot platform facts for the multi-tenant HubSpot OAuth connection
---

# HubSpot per-org OAuth

Each Organization connects its own HubSpot portal via an OAuth public app; tokens
are stored encrypted (Fernet) on the org row. There is **no shared/global token
fallback** — an org with no OAuth connection simply does not sync (any sync attempt
raises `HubSpotNotConfigured` → 501), and the Integrations page nudges it to connect.

**Why:** a single global `HUBSPOT_ACCESS_TOKEN` fallback routed every
not-yet-connected workspace's data into one shared portal (cross-tenant leak), and
the env-secret was sticky in running deployments even after deletion. The fallback
was removed entirely from code so connection is the only path to sync — a hard
tenant-isolation guarantee: org A can never touch org B's (or a shared) portal.

## HubSpot platform facts (not in our code)
- **Legacy "public app" UI is disabled for new HubSpot developer accounts.** New
  multi-account OAuth apps must be created via the Projects/CLI workflow
  (`hs project create` → Public app template → `hs project upload`). The OAuth
  mechanics are identical (same authorize/token endpoints, client id/secret,
  redirect URL, scopes) — only the app-creation path changed.
- Authorize: `https://app.hubspot.com/oauth/authorize`; token + refresh:
  `https://api.hubapi.com/oauth/v1/token`; revoke: DELETE
  `https://api.hubapi.com/oauth/v1/refresh-tokens/{refresh_token}`.
- The redirect URL registered in HubSpot must EXACTLY match
  `PUBLIC_BASE_URL` + `/api/hubspot/oauth/callback`, or HubSpot rejects the callback.

## Design decisions
- **Why the callback is on a separate UNPROTECTED router and auths via signed
  state:** the frontend's `auth.js` patches `window.fetch` to attach the bearer
  to `/api/*`, but the OAuth callback is a top-level browser redirect (no fetch,
  no bearer). So `/api/hubspot/oauth/callback` can't use the bearer guard; it
  authenticates with an HMAC-signed `state` (signed with the auth secret).
- **Why `/oauth/start` returns JSON `{authorize_url}` instead of a 302:** it's
  called via authenticated fetch, and a 302 from fetch won't drive a top-level
  navigation. The frontend does `window.location = authorize_url`.
- **State is single-use.** `verify_state` only checks signature + TTL; a leaked
  valid state could otherwise be replayed to attach an attacker portal. So
  `/oauth/start` persists a nonce on `organizations.hubspot_oauth_state` and the
  callback matches + clears it (`consume_state`). Starting a new connection
  overwrites/invalidates older in-flight states.
- **Refresh failures are classified transient vs permanent.** Only a definitive
  4xx (invalid_grant) flips `hubspot_needs_reconnect`; network errors / 5xx / 429
  are `HubSpotOAuthError(transient=True)` and re-raised without locking the org
  out, so a HubSpot blip doesn't force every org to reconnect.
- Per-org token is bound for the ~25 internal `_request` call sites via
  contextvars (`use_org_context`), reset in `finally`. With no token bound the
  call raises `HubSpotNotConfigured` — there is no global fallback.
- Per-org toggles `auto_sync`/`create_deals` govern behavior; default on for
  unmigrated rows. Auto-sync only fires for OAuth-connected orgs.
- **Deleting a secret can't be done with the env-secrets tooling** —
  `deleteEnvVars` only removes env vars; secrets are global and report success but
  persist. They must be removed by the user via the Secrets pane in the GUI.
- Operator visibility into which orgs are connected vs not is via the server-side
  script `python -m app.scripts.hubspot_connections` — deliberately NOT a tenant
  API, since `require_admin` is org-scoped (no platform role) and a cross-org
  report would leak other tenants' metadata to any org admin.
