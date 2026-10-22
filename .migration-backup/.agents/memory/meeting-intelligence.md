---
name: Meeting Intelligence subsystem
description: How bulk transcript/audio -> MOM extraction + cross-meeting summary is wired (worker, tenancy, summary aggregation).
---

# Meeting Intelligence

Bulk meeting transcripts (text AND audio) -> per-meeting Minutes-of-Meeting
(MOM) with evidence quotes, plus a combined cross-meeting batch summary.

## Shape
- `MeetingBatch` + `MeetingDocument` (org_id + creator user_id scoped). New
  tables are created by `init_db` `create_all` — no migration needed for
  brand-new tables (the self-heal only ALTERs existing ones).
- A single background daemon thread (started from app startup, gated on
  `_db_ready` so it never queries tables before the migration finishes) polls
  for `queued` docs, lazily transcribes audio docs, runs OpenAI extraction,
  renders deterministic markdown, and rolls up batch counters.

## Decisions / gotchas
- **Tenancy:** list/get filter by `org_id` (org-wide visibility, not per-user);
  cross-org access returns **404 not 403** (anti-enumeration). Same convention
  the rest of the app uses.
- **Worker claim** is an optimistic compare-and-set (`UPDATE ... WHERE
  status='queued'`, proceed only on rowcount>0). Safe on SQLite + Postgres for
  the single-worker model. Stuck `processing` rows are reaped after a stale
  threshold.
- **Summary aggregation** dedupes list items by `text.lower().strip()`, fans in
  the source meetings, and aligns evidence quotes by **index** into the per-doc
  `evidence_quotes[<list_key>]` arrays — this index alignment is the extraction
  contract; keep extraction output index-aligned with its quote arrays.
- **Upload size caps (security):** audio AND text uploads must both stream with
  a hard byte cap — an unbounded `await f.read()` on text was an OOM/DoS vector
  (flagged in review). Extensionless files are rejected, not read as text.
- **Frontend markdown** is rendered by a hand-rolled renderer in meetings.js
  that escapes everything before building HTML (no raw HTML injection). Authed
  pages follow the app convention: binary/protected assets via blob+objectURL,
  but MOM markdown is plain JSON so normal fetch is fine.

## Long-capture auto-detect (multi-conversation splitting)
- **Completeness, NOT context, is the bottleneck:** `autodetect.propose_sessions`
  must never hard-truncate, but also must keep each LLM call SMALL. gpt-4o fits a
  ~98k-char transcript in context yet is "lazy": single-pass it covers the start,
  skips the middle, and drops whole meetings. Verified on a real ~100-min/745-utt
  transcript — single-pass found 8 customer meetings (missed Boeing); chunking at
  ~28k chars/call found all 11. So budgets are deliberately SMALL (28k single +
  chunk, ~180s overlap); `_chunk_utterances` splits, `_merge_overlapping_sessions`
  dedups seams. **Why:** more, smaller calls = far better meeting recall.
- **Merge guard:** dedup is time-overlap (>=0.5 of shorter span) AND semantic —
  two different *known* companies never merge even if spans overlap at a seam;
  Unknown fragments fall back to time-only. Keep timestamps GLOBAL (chunks carry
  absolute seconds) so `_normalize_proposal` clamps correctly and merge works.

- **Over-segmentation cleanup (coalesce + drop noise):** shrinking the autodetect
  chunk size fixes under-detection but causes the opposite failure — one meeting
  split into *abutting* pieces (no time overlap, so the overlap-merge misses them)
  plus tiny crosstalk slivers as standalone "meetings". Cure: a coalesce pass that
  runs AFTER overlap-merge on BOTH detection paths (the single-pass path must run
  it too — historically it returned with no post-processing). **Why two distinct,
  conservative fold reasons matter:** (1) "continuation" = same KNOWN company or
  shared visitor-speaker id across a short gap; (2) "sliver" = one side tiny AND
  the *other* side clearly substantial (dual size gate) so two comparable short
  blocks are never fused and two long blocks never fuse via the sliver rule. Merge
  a sliver's TIME/topics but NOT its speaker ids, else a bridge fragment
  transitively links two genuinely distinct meetings. Drop leftover ultra-short
  blocks only when they're empty (no company, no topics) — a short block that
  extracted real content may be a legitimate brief meeting.
- **Validate on the app's OWN diarized_segments, not the pasted transcript:** the
  real Deepgram diarization of an uploaded recording differs in length/utterance
  count from a hand-pasted transcript of "the same" audio, so segment boundaries
  and counts differ. Reproduce detection bugs by loading `sessions.diarized_segments`
  for the actual session and running `propose_sessions` on THAT.
- **Expected "meeting count" includes internal/staff meetings:** users count
  staff_only/internal discussions as numbered meetings too, so don't equate the
  target count with customer-only sessions.
- **A stored session proposal is a SNAPSHOT:** re-viewing a confirmed long-capture
  session shows the proposal computed at process time. Detector code changes only
  affect NEW detection runs — to see improvements the user must re-run auto-detect
  on that session; confirmed Conversation rows are appended, not recomputed.
