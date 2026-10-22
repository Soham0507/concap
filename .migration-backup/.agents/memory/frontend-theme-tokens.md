---
name: Frontend theme tokens (light/dark)
description: How per-page reskins must consume the app's CSS variables so the light/dark toggle keeps working.
---

# Reskinning a page must reuse the app's theme tokens — never hardcode a palette

**Rule:** When restyling any frontend page, take colors from the existing CSS
variables in `frontend/styles.css`, not literal hex. The app toggles themes via
`[data-theme="light"]` / dark on `<html>` (set by appnav.js), and every token has
a value in BOTH themes.

Available token families (all defined for dark `:root`/`[data-theme="dark"]` AND
`[data-theme="light"]`):
- surfaces/text: `--bg --surface --surface-alt --surface-hover --surface-elevated --text --text-muted --text-subtle --border --border-strong`
- brand accent: `--accent --accent-hover --accent-soft --accent-soft-text --accent-glow --accent-gradient --shadow-accent`
- semantic (theme-tuned, contrast-safe): `--success/-soft/-soft-text`, `--info/…`, `--danger/…`, `--warning/…`
- shape/shadow: `--radius-sm/-/-lg/-xl`, `--shadow-xs/-sm/-md/-lg`

**Why:** A prior reskin of `imported-meetings.html` redefined `--bg/--surface/--accent`
etc. with hardcoded emerald + near-white values scoped to `main.content`. That forced
a light+emerald look in BOTH modes → dark mode broke (light-on-light). It also hardcoded
status-chip hues (green/blue/slate) that were unreadable on dark surfaces.

**How to apply:**
- Do NOT override the theme tokens themselves on a container to "retheme" a page.
  Only override layout/component props; let colors flow from the real tokens.
- Status/semantic colors → use `--success/--info/--danger/--warning` (+`-soft`/`-soft-text`),
  NOT raw hex. Neutral chips → `--text-muted` + `--surface-alt`.
  "created/success" boxes and "connected" pills should be `--success*` (green), not `--accent`.
- The app's real accent is ORANGE (`#FF5B2E` dark / `#D85A30` light). A screenshot
  reference in a different accent (e.g. emerald) is for LAYOUT/hierarchy only — respect
  the existing design system for color.
- After a reskin, confirm both modes: nothing white-on-white or black-on-black.
