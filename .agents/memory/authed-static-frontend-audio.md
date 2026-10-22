---
name: Authed media in the static frontend
description: Why protected binary assets (audio) must be fetched as a blob, not put in a src= attribute.
---

# Serving protected binary assets to the static frontend

The whole app is gated behind a bearer token. `auth.js` patches `fetch()` to
attach `Authorization: Bearer <token>` to same-origin `/api/*` calls — but
**native element resource loads do not go through `fetch()`**. An
`<audio src="/api/conversations/{id}/audio">` (or `<img>`, `<video>`, etc.)
issues a browser request with **no** Authorization header, so any endpoint
behind `require_user` returns 401 and the media silently fails to load.

**Rule:** to play/show an auth-protected binary asset, fetch it with the
patched `fetch()`, turn the response into a Blob, and assign
`URL.createObjectURL(blob)` to the element's `src`. Revoke the previous object
URL (`URL.revokeObjectURL`) when swapping assets so blob URLs don't accumulate.

**Why:** seeking still works because the whole clip lives in memory once
fetched, and it keeps tenant isolation intact (the token is enforced on every
fetch). The alternative (a short-lived signed token in the query string) is
only worth it for large files where you can't hold the whole blob in memory.

**How to apply:** any time you add a protected `/api/*` route that returns a
file/stream and the frontend needs to render it in an `<audio>/<img>/<video>`,
use the blob-objectURL pattern (see `frontend/conversations.js` `loadAudioInto`).
Also bound the served path to the configured storage root server-side so a
tampered DB path can't read arbitrary files.
