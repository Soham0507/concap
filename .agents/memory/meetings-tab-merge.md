---
name: Meetings tab merge
description: Why /meetings and /imported-meetings are presented as one sidebar tab but kept as two pages.
---

# Meetings + Imported Meetings unified under one tab

`/meetings` (Meeting Intelligence) and `/imported-meetings` (providers + imports)
are presented to the user as a single "Meetings" section, but remain **two
separate HTML pages with separate JS**.

**Why not a true single-page merge:** both pages reuse the same element IDs and
classes (e.g. `#m-text`, `#m-title`, `.intake-tab`, `.intake-pane`). Combining
them into one DOM would cause ID collisions and break both scripts.

**How it's wired:**
- `appnav.js` injects ONE sidebar item "Meetings" (`ensureMeetingsNav`) that is
  marked `.active` on both `/meetings` and `/imported-meetings`. The old
  `ensureImportedMeetingsNav` was removed.
- Each page has an in-page `.meet-subtabs` `<nav>` (shared CSS in styles.css)
  with two links to switch between the views; the current one gets
  `.active` + `aria-current="page"`.
