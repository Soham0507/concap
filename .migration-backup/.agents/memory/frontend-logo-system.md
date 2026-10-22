---
name: Frontend logo/brand mark system
description: How the brand mark is rendered across the static frontend and where to change it without missing pages.
---

# Frontend logo / brand mark

The brand "C" mark is rendered in two parallel, structurally-identical systems:

- **App pages** (dashboard, login, signup, scan, meetings, … + the mobile topbar injected by `frontend/appnav.js`): markup is `.concap-logo > .concap-logo-mark`. Every app page links `frontend/styles.css`, but each ALSO carries a per-page inline `<style>` block redefining `.concap-logo-mark`. Override centrally from `styles.css` using a **descendant selector** `.concap-logo .concap-logo-mark` (and `…::before/::after { content: none }`) — its higher specificity out-ranks the single-class inline rules regardless of source order. One edit covers all app pages + topbar.
- **Landing page** (`frontend/landing.html`): markup is `.logo > .logo-mark`, and the file is **self-contained — it does NOT link `styles.css`**. The central override cannot reach it; edit landing's inline CSS directly.

**Why:** the logo CSS is duplicated inline per page, so a naive single-file change silently misses pages; and landing is fully standalone.

**How to apply (theme gotcha):** both systems have a **light theme** (app: `[data-theme="light"]`, pale sidebar `#EFEBE0`; landing: `[data-theme="light"]`, cream `--bg`). The knockout (white) mark vanishes on light surfaces, so each system needs a `[data-theme="light"]` override pointing at an **ink** variant of the mark. Don't assume landing is "dark only" — it has a working theme toggle.

Assets live in `frontend/` (served at `/static/...` by the FastAPI static mount; `attached_assets/` is NOT web-served). Favicon: `<link rel="icon">` was added to every HTML head, plus a backend `/favicon.ico` + `/favicon.svg` fallback route, plus `manifest.webmanifest` PWA icons — keep all of these in sync when the mark changes.
