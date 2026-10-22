---
name: Frontend sidebar nav composition
description: How the authenticated sidebar is assembled across appnav.js injection + per-page hardcoded HTML, and why pages drop menu items.
---

The authenticated sidebar is built from TWO sources, and missing items come from this split:

- `appnav.js` injects app-wide (anchored, stable order): **Conversations** (after Dashboard), **Multi-conversation**/long-capture (after Conversations), **Meetings** (after Conversations), **Quote agent** (after Meetings), **Branding** (after Integrations). Each guards against duplicates by href.
- Everything else is **hardcoded per-page HTML** and NOT injected: **Dashboard**, **Quick transcribe**, the **CRM** group (Scan card, Companies, Contacts), and **Settings → Integrations**.

**Why:** per-page sidebars were historically copy-pasted and inconsistent; some pages stripped their nav down (e.g. long-capture.html once hardcoded only Dashboard), so the non-injected items silently disappeared on those pages.

**How to apply:** the canonical full sidebar lives in `conversations.html`. When a page's menu looks incomplete, copy that nav block into the page; appnav.js fills in the injected items in the right sections as long as Dashboard (anchor for Conversations) and Integrations (anchor for Branding) are present. Don't hardcode any injected link (/conversations, /long-capture, /meetings, /quotes, /branding) or it can double up.
