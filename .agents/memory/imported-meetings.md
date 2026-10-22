---
name: Imported Meetings subsystem
description: The separate "Imported Meetings" tab — transcript import (Zoom/Meet/Teams OAuth), conversation parsers, and cross-meeting voiceprints. Decisions and gotchas.
---

# Imported Meetings subsystem

A SEPARATE tab from `/meetings` (the older meeting-intelligence subsystem stays
untouched). Lets an org import call transcripts three ways: paste, file upload
(auto-detected format), and per-org provider OAuth sync. Per-utterance audio
playback was intentionally EXCLUDED from scope.

## Provider OAuth is a single generic abstraction
**Decision:** One `meeting_oauth.py` with a `PROVIDERS` dict (zoom / google_meet
/ ms_teams) drives authorize-url, token-exchange, and refresh for all three —
NOT three separate `*_oauth.py` files like salesforce/hubspot have. Adding a
provider = one dict entry, not a new module.
**Why:** the three flows differ only in endpoint URLs, auth style, and a couple
of scope/param quirks; copy-pasting three modules would triple the maintenance.
**How to apply:** per-provider quirks captured in the dict — Zoom uses HTTP
Basic auth on the token endpoint and ROTATES its refresh token (persist the new
one each refresh); Google needs `access_type=offline`+`prompt=consent` and does
NOT reissue a refresh token (keep the old one); MS Teams puts the tenant in the
token/authorize path and needs `offline_access`. Refresh is serialized per
`(org_id, provider)` via an in-process lock map to avoid double-refresh races.

## OAuth callback must return to /imported-meetings (not /integrations)
**Why:** the callback is a public route (authed by signed state). The frontend
reads `?meeting=connected` / `?meeting_error=...` query params ON the
imported-meetings page to show a toast. An early version redirected to
`/integrations`, so the toast never fired — a silent UX break, not a crash.
**How to apply:** keep the callback redirect target and the frontend's
`handleCallbackParams` param names in lockstep. Covered by
`tests/test_imported_meeting_callback.py` (success redirect + replay rejection +
cross-provider state mismatch).

## Voiceprints are deterministic lexical fingerprints, NOT audio/embeddings
**Decision:** `voiceprints.py` builds a 128-dim L2-normalized vector from a
speaker's text (hashed token/bigram features), cosine-matched against a per-org
registry with `MATCH_THRESHOLD=0.72` and `MIN_SAMPLE_CHARS=40`.
**Why:** transcripts are text-only (no audio retained), so "voiceprint" here
means a speaking-style fingerprint, not acoustic. Fully offline + deterministic,
so tests need no network/mocked embeddings.
**How to apply:** `merge_embeddings(old, count, new)` incrementally folds new
samples into a registry entry and re-normalizes; short samples (< MIN_SAMPLE)
are skipped during matching to avoid noise.

## Parser participant keying
Slack/Discord JSON parsers key `participants` by the platform USER ID (e.g.
"U1"), not the display name — the display name still appears inline in `content`.
Don't assert participant lists contain display names.

## Google Meet does MORE than transcript sync (create + calendar)
**Decision:** beyond pulling recordings (Meet REST `conferenceRecords`), the
google_meet provider also creates meetings and browses calendar via the Google
**Calendar** API — a different host/scope from Meet. Needs the
`calendar.events` scope ADDED to the google_meet scopes list (one scope covers
both create + list); the user must enable Calendar API in Google Cloud, add the
scope to the consent screen, and RECONNECT (re-consent) — existing tokens lack it.
**Why:** there is no "create a Meet" API on the Meet host; the documented path
is a Calendar event with `conferenceData.createRequest` + `hangoutsMeet`.
**How to apply:** create uses `conferenceDataVersion=1` on
`POST /calendar/v3/calendars/primary/events`; LIST must ALSO send
`conferenceDataVersion=1` or the `conferenceData.entryPoints` fallback link is
absent. Join link = `hangoutLink` first, else the `video` entryPoint URI. A 401/403
from Calendar almost always = missing scope → map to a "reconnect to grant
calendar access" message (NOT a transient error), so the UI nudges re-consent.
Endpoints live under `/providers/google_meet/{create-meeting,calendar}` declared
BEFORE `/{meeting_id}`; gated by `require_user` + `org_connected`.

## "Pull recordings" 403 is PERMANENT (Meet REST is Workspace-only)
**Decision:** a 401/403 from the Meet REST `conferenceRecords` host (the
"Pull recordings" sync) maps to a NON-transient, actionable error
(`_meet_error`, mirroring `_calendar_error`) — enable the Meet API + reconnect +
note that Meet REST transcripts/recordings require a Google **Workspace** account
(personal Gmail can't use them). Old code mislabeled it `transient=True`
("conference list failed"), implying a pointless retry.
**Why:** the 403 is Google-side config (Meet API not enabled, scope not granted,
or non-Workspace account), none of which a retry fixes.
**How to apply:** follow the calendar pattern — init `resp = None`, assign before
`raise_for_status()`, route all `httpx.HTTPError/ValueError` through the mapper so
`resp` is available even when a helper raises a plain `HTTPError`. Sync endpoint
turns `MeetingOAuthError` into HTTP 502 with the message as detail.

## Frontend treats provider URLs as untrusted
Provider/API-returned URLs (Meet join links, calendar htmlLink) are run through
a `safeUrl()` http(s)-only guard before any `window.open`/`<a href>` — escaping
alone doesn't stop `javascript:`/`data:` schemes.

## NEVER send `scope` on a Google OAuth token *refresh* (400 Bad Request)
**Decision:** the generic provider refresh must NOT include a `scope` param for
Google. Google rejects a refresh whose scope isn't an exact subset of what was
originally granted, returning a 400 ("Bad Request") — which surfaced as create
meeting failing AFTER the calendar scope was added. Controlled by a per-provider
`refresh_send_scope` flag (Google False; MS Teams keeps sending scope).
**Why:** Google ignores scope-widening on refresh anyway and 400s on mismatch; a
refresh can never ADD scopes — only a fresh re-consent (reconnect) grants new ones.
**How to apply:** after adding ANY new Google scope, users MUST reconnect
(re-consent) AND the scope must be registered on the OAuth consent screen + its
API enabled in Google Cloud, or Google silently drops the sensitive scope and
calls 403 "insufficient authentication scopes". Regression-locked by tests
asserting Google refresh omits scope / MS Teams includes it.

## Zoom "pull recordings" 400 is usually a PLAN/scope issue, not a bug
**Decision:** Zoom's `GET /users/me/recordings` returns HTTP **400** (not 401/403)
with body `{code:200, message:"Only available for Paid account: …"}` for Basic
(free) plans — they have no cloud recording. Map it to a non-transient "requires a
paid Zoom plan" message; surface Zoom's JSON `{code,message}` instead of the bare
status. A 401/403 here = missing `cloud_recording:read` scope → reconnect.
**Why:** create-meeting (201) + userinfo (200) succeeding while recordings 400s
proves auth/`me` are fine; the failure is account-tier/scope, which retries can't
fix — old code marked it `transient=True` and looped 3×.
**How to apply:** also send an explicit `to` date and keep the `from`/`to` span
≤ one month (Zoom 400s on wider ranges) — clamp `since_days` even though the router
allows up to 365 (a month-by-month chunked fetch is the future fix for full range).

## Empty Google Meet calendar ≠ recordings broken (two separate systems)
Recordings import (Meet REST `conferenceRecords` sync) and the calendar browse
(Calendar API `events.list`, Meet-link filtered) are independent — sync can return
200 + transcripts while the calendar panel shows "No meetings". The Meet-link
filter accepts `hangoutLink` OR any `conferenceData.entryPoints` URI containing
`meet.google.com` (not only `entryPointType=="video"`). Default lookback is
past 30 / next 21 days (frontend copy must match the backend window).

## Zoom can also create meetings (not just pull recordings)
`create_zoom_meeting` POSTs `api.zoom.us/v2/users/me/meetings` (type=2 scheduled,
UTC start_time, bounded duration) → join_url. Needs the connected Zoom app to
carry the `meeting:write` scope (Zoom user-level apps carry scopes in the app
config, not the authorize URL — so scopes=[] for zoom). 401/403 → "reconnect
after enabling meeting:write". The frontend create-meeting modal is generic over
provider; ALL providers (incl. Zoom + Teams) now show the attendees field.

## Google calendar meetings auto-show in a left-column panel (not just the modal)
**Decision:** the connected Google account's scheduled Meet meetings render in an
always-present left-column panel (`#calendar-card`, "On your calendar"), populated
by `loadCalendarPanel()` from `GET /providers/google_meet/calendar`. The older
"Calendar" modal button on the provider card is kept too (both share `calRow` +
the same endpoint). **Why:** users expect scheduled meetings to appear after
connecting, without hunting for a modal. **How to apply:** the panel auto-loads
because `init()` calls `loadProviders()` (previously only fired on Providers-tab
click); `loadProviders` derives `google_meet.connected` and calls
`loadCalendarPanel(connected)`. Panel is hidden when disconnected / on provider
load failure. This is distinct from the "Scheduled" panel (`#created-card`), which
shows in-app `CreatedMeeting` rows only.

## Created meetings persist but are connection-gated (display only while connected)
Meetings scheduled FROM the app (Google Meet + Zoom + MS Teams) persist in `CreatedMeeting`
(org-scoped, distinct from transcript-holding `ImportedMeeting`). They are
hidden — NOT deleted — when their provider disconnects: the list endpoint
filters to currently-`org_connected` providers, so reconnecting re-reveals them.
**Why:** user wants created meetings to show only while their meet/zoom account
is connected. **How to apply:** gating lives ONLY in the read endpoint (server
is source of truth); never delete on disconnect. Frontend right-panel detail
must track `selectedCreatedId` so an empty CREATED list (post-disconnect) clears
the panel — selecting the persisted row after create (not the ephemeral API
result) is what keeps that selection state consistent.

## Created-meeting invitations are PROVIDER-SPECIFIC (native calendar vs backend SMTP)
**Decision:** how attendees get notified depends on the provider
(`_PROVIDER_NATIVE_INVITES = {"google_meet","ms_teams"}` in the router):
- **Google Meet / MS Teams (native):** the backend sends NO email. The provider's
  own calendar emails attendees. Google = Calendar event PATCH/POST with
  `sendUpdates=all` (`conferenceDataVersion=1`); Teams = Graph `/me/events`
  create+PATCH and Outlook auto-sends. Invite/resend/edit just (re)PATCH the event
  with the attendee list so the calendar re-notifies, then record locally.
- **Zoom (backend SMTP):** Zoom's API can't invite, so the backend sends a branded
  HTML email + RFC-5545 ICS via `email_sender.send_invitation` (`smtplib`),
  configured by `SMTP_HOST/PORT/USERNAME/PASSWORD/FROM_EMAIL/FROM_NAME/USE_TLS/USE_SSL`
  (`Settings.email_configured()`/`resolved_from_email()`). Reply-To = organizer.
**Why:** the spec required provider-specific delivery — Google/Outlook already send
polished native calendar invites with accept/decline, so duplicating them over SMTP
is wrong; only Zoom needs the backend to email. (Replit Mail was rejected earlier:
it only sends to the Repl owner's own verified address — can't email attendees. The
old "universal backend SMTP for all three" design was replaced by this.)
**How to apply:** each endpoint validates ONLY its own provider's connection
(`_require_provider`); provider push goes through `_push_provider_update`. The
unused `gmail.send` Google scope was REMOVED (native invites use `calendar.events`,
not Gmail) — Google users must reconnect. `_send_invites` (Zoom only) builds email +
ICS (ICS only with a start time); errors `EmailNotConfigured`/`EmailSendError`
(subclass `EmailError`) → `{sent:0,error}` → HTTP 502. ICS uid =
`concap-created-{row.id}@concap.ai`, `sequence=1` on updates so calendars refresh.

## Zoom invite "from" the connected account: display/Reply-To only, NOT the envelope From
**Decision:** Zoom invitations are attributed to the connected Zoom account (its
email = `oauth.status(org,provider)["account_label"]`) via the sender DISPLAY name,
`Reply-To`, and the `.ics` ORGANIZER — falling back to the app user, then org brand.
The physical envelope From address STAYS the configured SMTP account.
**Why:** a mail server (Gmail especially) rejects/rewrites a From that isn't the
authenticated SMTP account (SPF/DKIM/DMARC) — you cannot "send as" an arbitrary
Zoom user's address through one shared SMTP login. Google Meet/Teams truly send
from the connected account only because we're OAuth-authenticated AS that account;
Zoom has no email-send API at all, so the app's SMTP is the only transport.
**How to apply:** the connected email only exists if the Zoom OAuth app carries the
`user:read` scope (else `/users/me` 401/403 → blank `account_label`, shown as
"Connected" with no email on the card). To get a real per-user From address you'd
need per-user SMTP creds or a service with verified-sender/subuser support.

## Invitation invariant: native re-notify is all-or-nothing; Zoom records only after the email sends
**Decision:** `CreatedMeeting.invitations` (JSON list of
`{email,status:"invited",invited_at,last_sent_at}`). For **Zoom**, a record is
persisted ONLY after its SMTP send succeeds — `/invite`, `/resend`, and the
attendee-add path of edit raise 502 and persist NOTHING on send failure (the Zoom
edit emails added invitees BEFORE rebuilding/committing invitation records, so a
failure never leaves a phantom un-emailed participant). For **native (Google/Teams)**,
records are written once the provider PATCH succeeds (the calendar did the emailing).
`attendee_count` derives from `invitations` only — NEVER the raw `attendees` list.
**Native re-notification is ALL-OR-NOTHING:** `sendUpdates=all` / Outlook auto-send
re-notifies EVERY attendee, so a subset `/resend` can't be honored natively — the
router re-notifies all invited and reports `sent=len(all invited)` honestly.
**Why:** per-participant status means "they were notified"; for Zoom that means "we
emailed them", for native it means "the calendar invited them". Recording someone we
never reached, or claiming a subset resend when the calendar pinged everyone, would
both be lies.
**How to apply:** PATCH `attendees` = REPLACE semantics (edit form carries the full
list): added addresses notified+added, removed dropped (no cancellation email), kept
ones retain timestamps. Schedule change (title/start/duration): native = provider
PATCH re-notifies all; Zoom = best-effort "update" SMTP email to all invited. Status
+ `can_join` are time-derived server-side; frontend auto-refreshes every 60s.
NOTE (tests): provider create/update uses `httpx` (mock `httpx.post/patch` or the
`meeting_providers.*` fn). Native tests assert NO backend email is sent. Zoom tests
must stub email (monkeypatch `email_sender.get_settings` to a configured stub +
`email_sender.smtplib.SMTP` to a no-op) or the SMTP path raises 502.

## Connected account email/label is lazily backfilled on status read
**Decision:** the provider `account_label` (connected email/UPN shown on the card)
is captured at connect time, but `providers_status` ALSO calls
`ensure_account_label(db, org, provider)` per provider to backfill it when missing.
**Why:** connections made before the label feature existed (or where the
connect-time fetch failed — e.g. Zoom showed "Connected" with no email while Meet/
Teams worked) never got a label and there was no other refresh path; users would
otherwise have to disconnect/reconnect. **How to apply:** `ensure_account_label`
is best-effort (swallows MeetingOAuthError/httpx errors), only runs when connected
+ label missing, and uses `get_valid_access_token` then `_fetch_account_label`. An
in-process throttle (`_should_attempt_label_backfill`, 30-min window per org+provider)
stops a permanently-unfetchable label from hitting userinfo on every status poll.
Zoom's email comes from `GET /users/me` (`email` field) — this only works if the
connected Zoom app carries a `user:read` scope; without it the fetch 401/403s and
the label stays blank (nothing the backend can do but try). The frontend renders
the label generically (`provCard`: `Connected · {account_label}`) for all providers.

## Page IA: 4 primary tabs; Meetings tab = provider sub-tabs + 40/60 split
**Decision:** the page is organized as 4 PRIMARY top-level tabs — Paste | Upload |
Meetings | Speakers (`.ptab`/`.primary-pane`, `switchPrimary()`). The Meetings tab
holds provider sub-tabs (Zoom | Microsoft Teams | Google Meet, `.prov-tab`,
`selectedProvider`) over a 40/60 split: LEFT = the SELECTED provider's connection
card (`renderProviderPanel` renders ONE card, not all three) + that provider's
`#created-card` scheduled meetings (`renderCreatedList` filters `CREATED` by
`selectedProvider`) + `#calendar-card` (Google Meet only); RIGHT = always-visible
`#meeting-list` (ALL imported, provider-independent) + the shared `#detail-card`
viewer. **Why:** the old single-card "intake tabs" + flat list layout didn't scale
to per-provider connection state. **How to apply:** the detail viewer (`#detail-body`)
is SHARED by openMeeting / openCreatedMeeting / renderCreatedMeeting and now lives
INSIDE the Meetings pane — so paste/upload import must `switchPrimary("meetings")`
before `openMeeting`, and the OAuth callback lands on Meetings too. Provider status
is fetched once into `PROVIDERS_STATUS` and reused (no per-card refetch).

## Zoom metadata "Import Meetings" UI was REMOVED from the frontend
The `provmtg-card` / `#provmtg-list` / `loadProviderMeetings` / `importMeetings`
frontend surface is GONE — Zoom's card now shows "Pull recordings" like the others.
The backend `ProviderMeeting` model + `/providers/.../import-meetings` endpoint and
`METADATA_FETCHERS` still exist (next section), but nothing in the UI calls them.
Don't reintroduce a `provmtg-card` expecting it to be wired.

## Zoom "Import Meetings" = metadata-only history (separate from recordings) [BACKEND ONLY]
Zoom's card shows "Import Meetings" (others keep "Pull recordings"). It imports
meeting-history METADATA ONLY into `ProviderMeeting` (org-scoped, distinct from
transcript-holding `ImportedMeeting`/`CreatedMeeting`) — no recordings/transcripts.
Source = `GET /users/me/meetings` (needs only `meeting:read`, works on free plans):
`type=previous_meetings`→completed, `type=scheduled`→scheduled. Host name/email via
best-effort `GET /users/me`. **Participants always [] from the list endpoint**
(per-meeting participant report needs a paid/report scope). end_at derived from
start+duration. **Why:** designed so recording sync can be layered later without
touching this path — fetchers live in `METADATA_FETCHERS` dict + `fetch_provider_meetings`
dispatcher; import endpoint is Zoom-only via that guard (non-zoom→400).
**How to apply:** `since_days` window applies ONLY to completed meetings (filter on
start_at); scheduled/upcoming always kept. Cancelled status is supported by the model
but Zoom's list endpoint never surfaces cancellations. Re-import dedupes/updates by
`external_id` and assigns fetched values EXPLICITLY (not `or`-fallback) so cleared
fields don't go stale — except title (kept if provider omits it).
