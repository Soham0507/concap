# Booth Conversation Capture (MVP)

A single-tablet web app that captures consent, registers booth visitors, records the conversation, and runs OpenAI Whisper + GPT to produce a structured lead profile (intent, budget, urgency, pain points, competitors, sentiment, next action, lead score).

This is the MVP slice of the larger system architecture you sketched. It deliberately ships **without** real-time transcription, speaker diarization, CRM webhooks, offline sync, face recognition, or a vector DB — those are roadmap items, not v1.

## What's in the box

```
booth/
├── backend/                FastAPI + SQLAlchemy + OpenAI (+ optional Deepgram, ffmpeg)
│   ├── app/
│   │   ├── main.py         App entrypoint, static mount, global error handler
│   │   ├── config.py       Env-driven settings (resolves .env from backend root)
│   │   ├── database.py     SQLAlchemy engine + self-healing SQLite migrations
│   │   ├── models.py       Visitor, Consent, Conversation, Session, SessionMarker
│   │   ├── schemas.py      Pydantic request/response models
│   │   ├── routers/        visitors, consent, conversations, captures, sessions
│   │   └── services/
│   │       ├── transcription.py   Whisper + Deepgram (diarization) providers
│   │       ├── analysis.py        GPT lead extraction (diarization-aware)
│   │       ├── segmentation.py    ffmpeg-based audio slicing by markers
│   │       └── pipeline.py        Per-conversation orchestrator
│   ├── requirements.txt
│   └── .env.example
└── frontend/               Static PWA + dashboard + long-capture (no build step)
    ├── booth.html          Per-visitor: register → record → submit
    ├── long-capture.html   Session: upload → mark visitors → process
    ├── dashboard.html      Conversation list + AI summary + sessions panel
    ├── styles.css
    ├── booth.js            (ES module, imports queue.js)
    ├── long-capture.js     Marker management for sessions
    ├── dashboard.js
    ├── queue.js            IndexedDB offline queue + drain logic
    ├── sw.js               Service Worker (shell cache + background sync)
    └── manifest.webmanifest  PWA manifest
```

## Setup (Windows / PowerShell)

```powershell
cd C:\development\AI\booth\backend
py -3.13 -m venv .venv               # Python 3.12 or 3.13 — 3.14 ecosystem is still patchy
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

Copy-Item .env.example .env
notepad .env   # paste OPENAI_API_KEY, adjust EVENT_NAME / BOOTH_NAME

# Install ffmpeg once (required only for long-capture mode):
winget install Gyan.FFmpeg

uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Then open:
- Per-visitor booth:    <http://localhost:8000/booth>
- Long-capture session: <http://localhost:8000/long-capture>
- Dashboard:            <http://localhost:8000/dashboard>

The first request auto-creates `data/booth.db` (SQLite) and the `data/audio/` folder. The DB self-heals on startup when the model adds new columns, so you don't need to drop the DB between updates.

## Mic access

`MediaRecorder` only grants mic access on **secure origins** — that means `http://localhost`, `https://`, or a trusted self-signed cert. On a tablet at the venue you'll need either:
- A proper HTTPS reverse proxy (Caddy, nginx, Cloudflare Tunnel), or
- Add the LAN IP to `chrome://flags/#unsafely-treat-insecure-origin-as-secure` on the booth device (dev only).

## The conversation lifecycle

```
created → uploaded → transcribing → analyzing → analyzed
                                              └→ error
```

Audio upload returns immediately; transcription and analysis run as a FastAPI `BackgroundTask`. The dashboard polls every 4 seconds and the detail view auto-refreshes while a conversation is in flight.

## API surface

| Method | Path                                       | Purpose                                                                                |
| ------ | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| GET    | `/api/health`                              | Liveness + whether `OPENAI_API_KEY` is set. **Public** (no auth).                       |
| POST   | `/api/auth/signup` · `/login` · `GET /me` · `/change-password` | Auth. signup/login **public**; me/change-password need a token. |
| —      | `/api/org`, `/api/org/members`             | Org + member management (see "Organizations & multi-tenancy").                          |
| GET    | `/api/config`                              | Branding + consent text. **Requires auth.**                                            |
| POST   | `/api/captures`                            | **One-shot, idempotent capture used by the offline queue** — see "Offline mode" below. |
| GET    | `/api/captures/{client_capture_id}`        | Look up a conversation by the client-generated capture UUID.                           |
| POST   | `/api/visitors`                            | Create visitor. Dedupes on email/phone — returns existing visitor if matched.          |
| GET    | `/api/visitors`                            | List visitors.                                                                         |
| POST   | `/api/consent`                             | Record consent. Stores IP + user-agent + signed timestamp. Required before recording.  |
| POST   | `/api/conversations`                       | Create a conversation. Rejected unless that visitor has a `recording_consent` row.     |
| POST   | `/api/conversations/{id}/audio`            | Upload audio (`multipart/form-data`). Kicks off background transcription + analysis.   |
| POST   | `/api/conversations/{id}/process`          | Re-run the Whisper + GPT pipeline on the existing audio.                               |
| GET    | `/api/conversations`                       | List conversations with visitor name, status, lead score, temperature.                 |
| GET    | `/api/conversations/{id}`                  | Full conversation incl. transcript + structured analysis JSON.                         |
| GET    | `/api/conversations/export/csv`            | All leads as a flat CSV (one row per conversation).                                    |
| POST   | `/api/sessions`                            | Create a long-capture session.                                                         |
| GET    | `/api/sessions`                            | List all sessions with markers + derived conversation IDs.                             |
| GET    | `/api/sessions/{id}`                       | Single session detail.                                                                 |
| POST   | `/api/sessions/{id}/audio`                 | Upload the long recording (`multipart/form-data`, up to 500 MB).                       |
| POST   | `/api/sessions/{id}/markers`               | Add a `visitor_start` / `visitor_end` / `note` marker with optional visitor metadata.   |
| DELETE | `/api/sessions/{id}/markers/{marker_id}`   | Remove a marker (in case of mistakes).                                                 |
| POST   | `/api/sessions/{id}/process`               | Slice the audio at marker pairs, create Conversation rows, run STT + GPT per segment.   |

The granular `POST /api/visitors → /consent → /conversations → /audio` chain is still exposed for non-booth clients (e.g. a future CRM-side admin tool). The booth UI itself only uses `/api/captures`.

## The GPT analysis schema

Stored under `Conversation.analysis` (JSONB-equivalent). Every field is always present, with `"unknown"` / `[]` / `0` defaults if the transcript yielded no signal:

```json
{
  "summary": "string",
  "intent": "string",
  "products_discussed": ["..."],
  "pain_points": ["..."],
  "budget_range": "string",
  "urgency": "immediate | within_3_months | this_year | exploratory | unknown",
  "timeline": "string",
  "competitors_mentioned": ["..."],
  "buying_role": "decision_maker | influencer | end_user | researcher | unknown",
  "sentiment": "positive | neutral | negative | mixed",
  "key_quotes": ["..."],
  "next_action": "string",
  "lead_score": 0-100,
  "lead_temperature": "hot | warm | cold"
}
```

`lead_score` is clamped and `lead_temperature` is re-derived defensively in code, so even a misbehaving model can't poison the dashboard.

## Long-capture mode (full-day single recording)

When booth staff use a standalone recorder (Zoom H-series, Sony ICD, the conference's own mic feed, etc.) instead of the tablet's microphone, you end up with one continuous audio file containing every visitor conversation back-to-back, plus crowd noise, music, idle gaps, and internal staff chatter.

The long-capture pipeline handles this:

```
Recording device → upload file → manual visitor markers → ffmpeg slice → STT per segment → GPT analysis per segment → N Conversation rows on the dashboard
```

### Flow

1. Open <http://localhost:8000/long-capture>.
2. Create a session (name + booth rep).
3. Upload the recording (.wav / .mp3 / .m4a / .webm / .ogg / .flac, up to 500 MB).
4. Scrub through the audio; for each visitor, fill in their details, click **Set start** at the beginning of the conversation, then **Set end** at the end. The page lists markers as you add them.
5. Click **Process session**. The server slices the audio with ffmpeg at every marker pair, creates one Conversation row per visitor window, and runs the existing Whisper/Deepgram + GPT pipeline on each slice.
6. Results appear in the dashboard alongside any direct booth captures, marked with the source session ID.

### Why hybrid markers instead of fully-automatic segmentation

Your original spec correctly identified this: full-day expo recordings are noisy enough that automatic visitor-boundary detection (silence thresholds, speaker-change detection without prior speaker enrollment) is unreliable. The hybrid approach — rep marks visitor start/end while talking to them, AI handles diarization + transcription + analysis within those windows — produces enterprise-grade results with off-the-shelf models.

### AI auto-detect (propose → review → confirm)

Instead of manually marking every visitor, the long-capture page has an **Auto-detect visitors (AI)** button. It:

1. Transcribes the whole recording with **Deepgram** (diarization + word timestamps). Mandatory — `DEEPGRAM_API_KEY` must be set; Whisper can't diarize.
2. Runs a GPT pass over the speaker-labeled transcript that splits the day into discrete visitor conversations: company guess, rep-vs-visitor speaker roles, start/end seconds, topics, and a `customer` vs `staff_only` classification (internal chatter is flagged and excluded by default).
3. Stores the result as a **proposal** on the session (`status: proposed`). Nothing is created yet.
4. You **review and edit** the proposal table (untick non-visitors, fix company/name/times), then **Confirm** — confirmed rows become `Conversation`/CRM records.

Confirming **reuses the already-obtained diarized transcript** — no second STT pass and no ffmpeg — so it's fast and cheap. Endpoints: `POST /api/sessions/{id}/auto-detect`, `POST /api/sessions/{id}/confirm`.

Human-in-the-loop is deliberate: boundary detection in expo crowd noise misfires, and auto-creating CRM leads from wrong boundaries pollutes the pipeline. ~30s of review per booth-day is far more accurate than fully unattended.

**Not included (deferred):** persistent cross-session **voiceprint** rep identification ("Voice A = Naveen" forever). That needs a speaker-enrollment subsystem + an embedding model (pyannote/SpeechBrain) and is a separate project. Current behavior: GPT infers rep-vs-visitor *roles*; rep speakers are tagged `(rep)` in the transcript so lead analysis attributes statements correctly.

### Speaker diarization (Deepgram opt-in)

The transcription layer is provider-pluggable. By default it uses OpenAI Whisper, which produces a single plain-text transcript with no speaker labels. For long-capture sessions where you need to distinguish the booth rep from the visitor, set `DEEPGRAM_API_KEY` in `.env` and either:

- `STT_PROVIDER=auto` (default) — Deepgram is used whenever its key is configured.
- `STT_PROVIDER=deepgram` — force Deepgram.
- `STT_PROVIDER=whisper` — force Whisper even if Deepgram is set.

When Deepgram is active, the dashboard shows a speaker-labeled transcript like:

```
[00:00–00:05] Speaker 0: Welcome to the booth. What brings you here today?
[00:06–00:18] Speaker 1: We're looking for ERP for three manufacturing plants...
```

The GPT analysis prompt is aware of diarized input — it identifies which speaker is the visitor and attributes statements correctly. Budget/timeline/pain-point extraction becomes far more accurate because the model no longer conflates rep questions with visitor answers.

### What's NOT in long-capture mode (and why)

- **Real-time recording in the tablet browser.** Browsers regularly kill background MediaRecorder streams. Use an external recorder.
- **Automatic visitor-boundary detection.** Possible with VAD + speaker-change detection, but error rates in noisy expo audio make it a worse experience than manual markers.
- **PyAnnote local diarization.** Multi-gigabyte PyTorch install. Deepgram does it in one API call.
- **RNNoise / Krisp pre-processing.** Modern cloud STT models include strong noise suppression internally; an extra denoising step costs more than it gains.

These remain reasonable v2 work items if you outgrow the current setup.

## Organizations & multi-tenancy

Every account belongs to an **Organization**. Data (visitors, conversations, sessions, consent) is scoped to an org — a query in one org can never see another org's data. Visitor email/phone dedup is also per-org (the same email in two companies = two visitors).

**Signup creates an org:**

- **Individual** — a private workspace of one. The signer is the owner. Cannot have additional members.
- **Company** — a named organization. The signer is the owner and can invite teammates.

**Roles (privilege order):**

| Role     | Can do                                                                 |
| -------- | ---------------------------------------------------------------------- |
| `owner`  | Everything in the org + grant the `admin` role. Created at signup.      |
| `admin`  | Invite members, change member roles (member↔admin), enable/disable.    |
| `member` | Full capture + view of all org-shared data. No member management.      |

All members share one org-wide data pool (your chosen model: shared visibility, not per-user).

**Inviting members** (owner/admin, company orgs only): the Members page (`/members`, owner/admin only) creates the account with a generated one-time temporary password, shown **once** to the inviter to hand over securely (no email delivery in this MVP). The invitee has `must_change_password=true` and is forced through `/change-password` on first login before they can use the app.

| Method | Path                          | Role        | Purpose                                  |
| ------ | ----------------------------- | ----------- | ---------------------------------------- |
| GET    | `/api/org`                    | any member  | Org info.                                |
| GET    | `/api/org/members`            | any member  | List org members.                        |
| POST   | `/api/org/members`            | owner/admin | Invite (returns temp password once).     |
| PATCH  | `/api/org/members/{id}`       | owner/admin | Change role / enable / disable.          |
| POST   | `/api/auth/change-password`   | any member  | Set a new password (clears the flag).    |

The DB self-heals on startup: new columns are added in place, and any rows that predate multi-tenancy are backfilled into a single **"Legacy workspace"** org (earliest user becomes its owner) so nothing disappears after the upgrade.

## HubSpot integration (per-org OAuth)

Each **Organization connects its own HubSpot portal** via an OAuth public app, so a multi-tenant deployment talks to many portals with full isolation. Access + refresh tokens are stored **encrypted at rest** (Fernet) on the org row and never appear in any API response or log. There is **no shared/global token fallback** — an org must connect its own portal via OAuth to sync anything, and the Integrations page nudges it to connect.

**Connection states (the `/integrations` page):**

- **Connected (OAuth)** — the org has its own portal; conversations sync with its token, auto-refreshed ~5 min before expiry.
- **Reconnect needed** — a refresh hit a definitive failure (revoked/rotated grant). Transient errors (network, HTTP 5xx, 429) do **not** flip this — the next sync retries.
- **Disconnected** — the org explicitly disconnected; its tokens are cleared and it will not sync until it reconnects.
- **Not connected / not configured** — no per-org connection, or OAuth isn't set up on the server.

There is **no cross-org connection API** (the app has no platform-operator role — exposing every org's state to any org admin would leak tenant metadata). Operators instead run `python -m app.scripts.hubspot_connections` from `backend/` to see, across all orgs, which have connected their own portal and which still need to.

**Endpoints:**

| Method | Path                          | Role        | Purpose                                          |
| ------ | ----------------------------- | ----------- | ------------------------------------------------ |
| GET    | `/api/hubspot/status`         | any member  | This org's connection state (never exposes tokens). |
| GET    | `/api/hubspot/oauth/start`    | owner/admin | Returns the HubSpot `authorize_url` to redirect to. |
| GET    | `/api/hubspot/oauth/callback` | public¹     | OAuth redirect target; authed by signed state.   |
| PUT    | `/api/hubspot/settings`       | owner/admin | Toggle per-org `auto_sync` / `create_deals`.     |
| POST   | `/api/hubspot/disconnect`     | owner/admin | Disconnect (clears + best-effort revokes OAuth tokens). |

¹ The callback is a top-level browser redirect with no bearer header, so it lives on an unprotected router and authenticates via a signed, single-use, expiring `state` (HMAC over `AUTH_SECRET`). `/oauth/start` returns JSON rather than a 302 because it's called via authenticated `fetch`.

### Setup

HubSpot has **disabled the legacy public-app UI for new developer accounts** — create the OAuth app via the Projects/CLI workflow instead:

```
npm install -g @hubspot/cli@latest
hs init            # log into your app developer account
hs project create  # choose the "Public app" template
hs project upload
```

In the app's **Auth** config set:

- **Redirect URL:** `<PUBLIC_BASE_URL>/api/hubspot/oauth/callback` (must match `PUBLIC_BASE_URL` exactly).
- **Scopes:** `oauth`, `crm.objects.contacts.read/write`, `crm.objects.companies.read/write`, `crm.objects.deals.read/write`, `crm.schemas.contacts.read`, `crm.schemas.companies.read`, `crm.schemas.deals.read`, `crm.objects.owners.read`.

Then set these secrets:

| Variable                 | Purpose                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `HUBSPOT_CLIENT_ID`      | OAuth app Client ID.                                                     |
| `HUBSPOT_CLIENT_SECRET`  | OAuth app Client secret.                                                 |
| `PUBLIC_BASE_URL`        | Base URL the redirect points to (falls back to `REPLIT_DEV_DOMAIN` in dev). |
| `SECRET_ENCRYPTION_KEY`  | Fernet key for token encryption at rest. Optional — derived from `AUTH_SECRET` if unset. |

⚠️ **Encryption-key rotation:** changing `SECRET_ENCRYPTION_KEY` (or `AUTH_SECRET`, when it's the fallback source) makes existing encrypted tokens undecryptable — affected orgs are marked **reconnect needed** and must reconnect via OAuth.

Until `HUBSPOT_CLIENT_ID`/`HUBSPOT_CLIENT_SECRET`/`PUBLIC_BASE_URL` are set, the Integrations page shows "not set up" and no org can connect — syncing stays off until OAuth is configured and each org connects its own portal.

## Authentication

The entire app is gated behind login. Signup is open (anyone with the URL can register a new org); within a company, additional users are **invited by an owner/admin** (not open self-serve).

### Design

- **No new dependencies.** Passwords are hashed with stdlib `hashlib.pbkdf2_hmac` (PBKDF2-SHA256, 200k iterations). Tokens are a hand-rolled HMAC-SHA256 JWT (`app/services/auth.py`). This avoids `bcrypt`/`passlib`/`PyJWT` and their native build chains — relevant on Python 3.14 where Rust/C wheels are still patchy.
- **Token storage:** the JWT lives in `localStorage`. `frontend/auth.js` is loaded as a classic script before every page/module script, so it patches `window.fetch` *before* the first API call and transparently attaches `Authorization: Bearer <token>` to same-origin `/api/*` requests (except `/api/auth/*`).
- **Page guard:** protected pages redirect to `/login` if there's no locally-valid token. `/login` and `/signup` are the only public pages.
- **Server is the real gate:** every router except `/api/auth/*` is mounted with a `require_user` dependency. `/api/health` stays public for ops liveness checks.

### Endpoints

| Method | Path               | Purpose                                                    |
| ------ | ------------------ | ---------------------------------------------------------- |
| POST   | `/api/auth/signup` | Create account, returns `{ token, user }`. First = admin.  |
| POST   | `/api/auth/login`  | Returns `{ token, user }`.                                 |
| GET    | `/api/auth/me`     | Current user (requires token).                             |

### Setup

Set `AUTH_SECRET` in `.env` to a long random string:

```powershell
python -c "import secrets; print(secrets.token_hex(32))"
```

If you leave it blank, a random secret is generated on each startup — every restart logs everyone out, and it breaks across multiple workers. Fine for local dev, not for a real deployment. `AUTH_TOKEN_TTL_HOURS` defaults to 168 (7 days) so a multi-day event doesn't expire mid-floor.

### Auth + the offline queue

Because the whole app is gated (your chosen scope), the offline capture queue is auth-aware: a queued capture that flushes with an expired/missing token gets an `Auth required` error and **stays queued** (state `pending`) instead of being discarded. Once the rep signs back in, the periodic drain replays it. The fetch patch deliberately does *not* redirect to `/login` on a 401 from `/api/captures`, so a background drain never yanks a rep off the capture screen mid-conversation.

### First run

1. Start the server, open any page → you're redirected to `/login`.
2. Click **Create one**, register. You're now the admin and land on `/booth`.
3. The signed-in email + a **Sign out** link appear in the sidebar footer.

## Offline mode

Venue Wi-Fi is hostile. The booth UI is built as a PWA that keeps working with **zero connectivity**, including across full page reloads.

How it works:

1. **Service Worker** (`/sw.js`) caches the app shell on first visit. Once installed, opening `/booth` on the tablet works even with the network cable pulled.
2. **Capture flow runs entirely client-side.** Consent, visitor details, and the audio recording are all collected in memory — no server calls during the four-step flow itself.
3. **Submission goes to an IndexedDB queue** (`queue.js`), not directly to the server. Each entry includes a client-generated UUID and the audio Blob.
4. **The queue auto-drains** to `POST /api/captures` whenever:
   - The page loads.
   - The browser fires `online`.
   - A 20-second timer ticks (captive-portal Wi-Fi often lies about `online`, so we don't trust it alone).
   - The Service Worker fires a Background Sync event (Chromium browsers).
5. **The capture endpoint is idempotent on `client_capture_id`.** If a response is lost in transit and the queue retries, the server returns the existing conversation instead of double-inserting. Safe to retry forever.

The topbar shows two status pills:
- `online` / `offline` — `navigator.onLine` reflecting the OS view of connectivity.
- `N queued` / `N failed` — current state of the IDB queue. `failed` only appears for 4xx errors that won't get better with retry (e.g. a 413 audio-too-large); the booth rep can decide whether to discard or wait for a code fix.

Permanent failures stay in the queue with state `failed` so nothing is silently dropped. There is no UI yet to discard them — `indexedDB.deleteDatabase("booth-capture")` from DevTools is the escape hatch.

### What still requires the network at boot

- The very first visit (must load + cache the SW). Pre-warm the tablet on the office Wi-Fi the day before the event.
- `/api/config` for the consent text. If it fails, a generic fallback consent string is used so the flow still proceeds — but for compliance, you should make sure the cached shell has the right consent text from a prior online load.

## Compliance posture

- Consent is a **gate**: the API refuses to create a conversation without a stored `recording_consent` row for the visitor.
- The consent record stores the exact text the visitor agreed to, the version, IP, user-agent, and a server-side timestamp. That is the minimum you need to be able to demonstrate consent later.
- Marketing consent is captured separately so you can honor "yes record me, no don't email me."
- Visitor + Consent + Conversation cascade-delete in the schema — implementing a "delete my data" request is `DELETE /visitors/{id}` away (not exposed yet; add when needed).

## Why these design calls

- **SQLite by default, Postgres-ready.** `DATABASE_URL` switches between them with no code change. SQLite is fine for one booth, one tablet, hundreds of leads per day.
- **No real-time transcription.** Streaming Whisper adds significant complexity for marginal value at v1 — the rep doesn't need to read the transcript while they're talking to the visitor.
- **No webcam.** Audio is enough for lead intelligence; video doubles the consent burden and the storage cost.
- **No CRM connector yet.** CSV export covers Zoho/HubSpot/Salesforce import flows on day one. Add a webhook adapter when a specific CRM is chosen.
- **Static frontend, no build step.** A booth-side PWA needs to be debuggable in 30 seconds. Adding webpack/Vite is dead weight at this stage.

## Roadmap (the v2 list)

In rough order of value:

1. ~~**Speaker diarization**~~ — *done* via Deepgram, opt-in by env var. See "Speaker diarization" above.
2. **CRM webhook** — `POST /api/leads/forward` that fans out to Zoho/HubSpot/Salesforce with a simple adapter pattern.
3. **QR / badge scan input** — replace the manual form with a QR scanner that pre-fills visitor fields from a badge ID lookup. For long-capture mode, a badge scanner that emits timestamped events to `POST /api/sessions/{id}/markers` would let you skip the manual scrubbing step entirely.
4. ~~**Offline mode**~~ — *done.* See "Offline mode" above.
5. ~~**Long-capture (full-day single recording)**~~ — *done.* See "Long-capture mode" above.
6. **Business card OCR** — `POST /api/visitors/from-card` taking an image; OCR via Google Vision, then optional LinkedIn enrichment.
6. **Multi-rep tracking** — auth + `staff_id` foreign key, plus "which rep closed the most warm leads" analytics.
7. **Heatmap analytics** — peak-hour conversions, product-interest distribution, sentiment-by-industry.
8. **Re-identification across days** — already mostly there via email/phone dedup; surface "this visitor talked to us yesterday too" in the UI.

Anything past step 5 is over-engineering until you've actually used v1 at one event.
