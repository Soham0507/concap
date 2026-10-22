---
name: Conversation list/detail title source
description: Where the conversation "title" (topic) comes from and the two-source fallback both views must use.
---
The conversation display title is the analysis **topic**, and it lives in TWO places:
the denormalized `Conversation.topic` column AND inside the `analysis` JSON blob
(`analysis["topic"]`). Older/legacy rows often have the column NULL but the blob set.

**Rule:** any view that shows the conversation title must use the same fallback:
`conv.topic or analysis.get("topic")`, then fall back to visitor name, then `Conversation #id`.
The detail view (frontend) already did `c.topic || a.topic`; the LIST endpoint must do the
same server-side (it returns `topic` on ConversationListItem). Using only the column made the
list show the raw auto-generated visitor name ("Transcription: Puck V…") while the detail
showed the real topic ("flex boxes and collaboration").

**Why:** topic was added as a column after some conversations were already analyzed, so the
column backfill is incomplete; the blob is the authoritative source.

**Stale-list gotcha (the real reason "still not changed" persisted):** `/api/*` GET responses
had no Cache-Control headers, so the browser/PWA service-worker HTTP layer could heuristically
serve a *pre-`topic`* `/api/conversations` payload. The DETAIL view masked this because the
frontend falls back to the analysis blob client-side (`c.topic || a.topic`), so even a stale
detail response still renders the topic — but the LIST has no blob to fall back to and showed
the visitor name. Fix: `_no_cache_static` middleware now no-stores `/api/*` too, and bump
`frontend/sw.js` SHELL_CACHE version to evict already-cached entries on SW activation.
**Rule of thumb:** any API payload SHAPE change (new field) needs a SW cache-key bump, or
clients keep rendering the old shape until a hard refresh.
