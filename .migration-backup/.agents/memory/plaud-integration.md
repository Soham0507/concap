---
name: Plaud per-user MCP OAuth + sync
description: How the Plaud voice-recorder integration connects per USER (not per org) and feeds Meeting Intelligence.
---

# Plaud integration

## Confirmed product scope
Build Plaud Embedded using the user's Developer Portal credentials and a native
mobile companion, with recordings and results visible on the website. Keep the
existing personal-account importer separate and leave its data intact.

**Why:** The user explicitly changed their earlier choice and confirmed the
developer-keys-plus-mobile-companion path. Portal/Embedded credentials are not
interchangeable with the personal-account import's OAuth client.

**How to apply:** Keep credential names and authentication flows distinct.
Embedded device pairing/transfer requires the native iOS/Android SDK; do not
pretend a browser preview can pair with the recorder. Neither integration should
attach private recordings to the shared preview identity. The account-import
implementation notes below describe the legacy MCP path, not Embedded partner
authentication.

Syncs Plaud voice recordings into Meeting Intelligence via a per-USER OAuth
connection to Plaud's remote MCP server (`https://mcp.plaud.ai/mcp`).

## Per-USER, not per-org
- Mirrors the HubSpot per-org OAuth pattern (signed single-use state, PKCE S256,
  encrypted tokens, transient-vs-permanent refresh, per-principal lock) but keys
  every token/column on the **User** row, not the Organization.
  **Why:** Plaud accounts belong to individuals; one org has many recorder owners.
- **How to apply:** when extending, keep all token state on `User.plaud_*`. Do NOT
  add an org-wide/shared Plaud account or a global token fallback (explicitly out
  of scope, unlike some other integrations).

## OAuth specifics that differ from HubSpot
- `plaud_oauth.make_state(user_id, nonce)` has NO org arg; `authorize_url(db, user)`.
- AS metadata is discovered from the MCP origin at runtime, BUT config overrides
  (`plaud_authorize_url` + `plaud_token_url` + `plaud_client_id`) short-circuit
  discovery; an optional dynamic client registration (DCR) is the fallback when no
  static client is configured.
  **How to apply (tests):** set those three settings in conftest so the suite never
  hits the network for discovery or DCR. See `test_plaud_*` mirroring `test_hubspot_*`.
- Refresh failure classification: only a definitive 4xx flips
  `user.plaud_needs_reconnect`; network/5xx/429 stay connected to retry next sync.

## Sync → Meeting Intelligence
- `plaud_mcp` (async streamable-HTTP MCP client, Bearer token) exposes
  `list_files / get_transcript / get_note / get_current_user` with sync wrappers
  (`asyncio.run`) and defensive structured-vs-text parsing + tool-name aliases.

## Parsing Plaud's real MCP shapes (blank-meetings root cause)
- **Symptom→diagnosis shortcut:** `POST /api/plaud/sync` returns **200** but the
  Meetings page is blank. A failed DB insert would 500, so 200 + empty
  `/meetings/intelligence/documents` ⇒ `imported=0` ⇒ every recording was
  **skipped as empty**, i.e. transcript/note parsed to `""` (NOT a DB/tenancy bug).
- **Two reasons text comes back empty even though the MCP calls succeed:**
  1. The transcript/note is **nested** (`{data|result:{...}}`) or split into a
     **segment list** (`segments/sentences/utterances` of `{text|content|sentence}`).
     Fix = recursive `_coerce_text`/`_dig_text` (depth-capped) that digs envelopes +
     joins segment text, not just top-level `transcript/summary` keys.
  2. The per-file tool's **argument name isn't guaranteed** to be `file_id`. Resolve
     the tool OBJECT and map the id onto its `inputSchema.properties` (file_id/fileId/
     id/recording_id/...) via `_file_id_args`; `_call_file` uses it.
- **Real transcript/note shape (confirmed from prod logs):** the per-file tools
  return a **list of "data block" dicts** `{data_type, data_title, data_content,
  data_link, data_error_code, download_link_map}`. The TEXT lives in
  **`data_content`** — NOT `text`/`content`/`transcript`. `_coerce_text` special-cases
  this list (`_looks_like_plaud_blocks`/`_plaud_blocks_text`): concatenate each block's
  `data_content`, skipping empty blocks and **bare links** (audio/file blocks put a URL
  in `data_content`; `_is_bare_link` filters them so a URL never imports as transcript).
  **Why:** the original generic key search missed `data_content` → every recording read
  as 0 chars → "imported=0, N empty"; this was the root cause of the blank-Meetings bug.
- **Debugging without prod DB access** (deploy is VM+SQLite, can't query prod): added
  PII-safe `_shape()` logs (types/keys/**per-field value lengths**, never values) in
  list_files/get_* + a sync summary log
  (`imported/skipped_existing/skipped_empty/errors/total_seen`).
  Read these via `fetch_deployment_logs` after a re-sync to confirm the real shape.
  **Why:** never log transcript/note VALUES (PII); keys+lengths are enough to fix.
- Sync creates **TWO** records per recording: (a) a `MeetingDocument`
  (`meeting_source="plaud"`, `status="queued"`) the `meeting_worker` turns into
  minutes, AND (b) a `Conversation` (+ placeholder `Visitor` `source="plaud"`)
  that runs the STANDARD Concap pipeline so the recording also shows in
  Conversations + Dashboard. The conversation's transcript is set up-front;
  `plaud_sync` schedules `_run_pipeline_in_background(conv_id)` (imported from
  `routers.conversations`) via FastAPI `BackgroundTasks` AFTER commit.
  **Why:** users expect Plaud recordings to behave like any other lead capture,
  not just appear as MOM docs.
- The Plaud AI note/summary is stored on the doc's `source_summary` /
  `source_summary_json` (UI "Plaud summary"), `external_id` = Plaud recording id.
- **Conversation dedup:** `Conversation.client_capture_id == f"plaud:{org_id}:{file_id}"`
  (org-namespaced — `client_capture_id` is globally unique, so the org prefix
  prevents any cross-tenant collision if Plaud file ids ever repeat). `PlaudRecording.conversation_id`
  (nullable FK, in `_self_heal_schema`) maps recording→conversation.
- **Backfill:** a `PlaudRecording` with `conversation_id IS NULL` (imported before
  the conversation bridge existed) gets a Conversation on the next sync, REUSING
  the meeting doc's `transcript_text` (no Plaud re-fetch). Return dict adds
  `conversations_created`.
- **Dedup (import):** `PlaudRecording` unique on `(user_id, plaud_file_id)`. Re-sync
  skips already-imported ids (but still backfills missing conversations).
  Recordings with neither a long-enough transcript nor summary are skipped as empty.

## Pagination (pull NEWER recordings)
- `plaud_mcp.list_files` walks pages via `_list_all_files`: inspects the list
  tool's `inputSchema.properties` for a page arg (`page`/`page_no`/...) + size arg
  (`page_size`/`limit`/...). No page arg ⇒ single call (old behaviour, no regression).
- **Stop conditions:** empty page, OR a page that adds NO new recording ids (server
  ignored the page arg → would loop forever). Do **NOT** stop on a short page —
  the server may cap `page_size` below our request (200) yet still have more pages.
  Hard cap `_MAX_PAGES`. **Why:** original `list_files` was single-call and missed
  newer recordings sitting on later pages.
- **Pagination MUST be best-effort / non-fatal.** The real Plaud MCP server
  REJECTS the page/page_size args, which surfaces as
  `PlaudMCPError: Plaud MCP transport error: unhandled errors in a TaskGroup
  (1 sub-exception)` and broke sync entirely after pagination shipped. Guards:
  (1) `_list_all_files` catches per-page call errors — page-1 failure re-raises,
  later-page failure keeps what was collected; (2) `list_files` falls back to a
  plain no-arg call (`_list_files_plain`, the original behaviour) on any
  non-auth `PlaudMCPError`. **Auth errors must NOT trigger the fallback** — they
  re-raise so the router flips `plaud_needs_reconnect`.
- **Unwrap ExceptionGroups for auth detection.** anyio/MCP wraps failures in a
  TaskGroup ExceptionGroup whose `str()` is just "unhandled errors in a TaskGroup",
  so a buried 401/403 is invisible to a top-level `str(exc)` check. `_iter_exc`
  walks `.exceptions` + `__cause__`/`__context__`; `_is_auth_error`/`_best_message`
  use it (so a hidden 401 still flips reconnect, and users see the real inner error).
- **MUST catch `BaseException`, not `Exception`, around the streamable-HTTP
  session.** `streamablehttp_client` runs inside an anyio task group; on failure
  the group cancels its sibling tasks, so the error arrives as a
  **`BaseExceptionGroup`** carrying a `CancelledError` (a BaseException) alongside
  the real cause (e.g. `OSError [Errno 5] Input/output error`). `BaseExceptionGroup`
  is **NOT** a subclass of `Exception`, so a plain `except Exception` lets it escape
  RAW — past the router's `except PlaudMCPError` AND past `list_files`' no-arg
  pagination fallback — bubbling up as an unhandled 500 that shows only the buried
  inner message. **Why this matters:** the symptom looked like a network bug
  ("[Errno 5]") but was really an exception-typing bug; once `_with_session`
  catches BaseException (re-raising KeyboardInterrupt/SystemExit + standalone
  non-group CancelledError, wrapping the rest), the fallback chain actually runs
  and sync recovers. Same fix applied to `_list_all_files`' per-page handler.

## Placeholder visitors are NOT real contacts — hide them on Contacts
- The per-recording placeholder `Visitor` (`source="plaud"`, name = recording
  title) and quick-transcribe placeholders (`source="transcription"`, name =
  audio filename) are conversation OWNERS, not people. The Contacts page
  (`frontend/contacts.js`) hides them by default via `isSynthetic` /
  `SYNTHETIC_SOURCES = ["transcription","plaud"]`; the "Show auto-created from
  transcripts & recordings" toggle reveals them.
  **Why:** otherwise recording titles ("Welcome to Plaud.ai", timestamps, etc.)
  flood Contacts as junk leads.
  **How to apply:** any NEW auto-created/placeholder visitor source must be added
  to `SYNTHETIC_SOURCES` (and ideally the source-filter dropdown) or it will leak
  into the contacts list.

## Out of scope (do not add without a new task)
Generic device layer, raw audio download, org-wide shared accounts, real-time push.
