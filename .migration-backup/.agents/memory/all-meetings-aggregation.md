---
name: All Meetings aggregation + Import Conversation
description: How the unified "All Meetings" list and the Import Conversation intake panel are wired, and the tenancy/auth constraints they must keep.
---

# All Meetings aggregation + Import Conversation

The "All Meetings" page is the default meetings landing. It reads one endpoint
that MERGES three separate meeting domains into a single date-sorted list:
Meeting-Intelligence docs, Imported Meetings, and provider-created meetings.

## Rules that must hold
- **Org scoping is per-source, not global.** Every source query filters on
  `user.org_id`; there is no shared/global fallback. A new source added to the
  merge must repeat the org filter or it leaks cross-org.
- **Provider-created meetings are gated by live connection.** CreatedMeeting rows
  only appear while their provider (`zoom`/`google_meet`/`ms_teams`) is still
  `oauth.org_connected`. Disconnecting hides (never deletes) them — mirror this
  if you touch the merge.
- **Provider key vs UI source tag differ:** DB `ms_teams` → UI `microsoft_teams`
  (zoom/google_meet pass through). Keep the map symmetric for the `source=` filter.

## Import Conversation Audio tab
**Why:** auth.js patches `window.fetch` to inject the Bearer token, but NOT
XMLHttpRequest. The Audio upload uses XHR (for a real progress bar), so it MUST
manually set `Authorization: Bearer <localStorage 'booth_auth_token'>` or it 401s.
**How to apply:** any XHR to a protected `/api/*` route needs the manual header;
plain fetch does not. File validation (audio type + size) lives in one `setFile()`
so both the browse and drag/drop paths enforce it; client size cap mirrors the
backend `/api/transcribe` `MAX_MB`.
