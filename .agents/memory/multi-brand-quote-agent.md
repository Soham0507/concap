---
name: Multi-Brand Quote Agent
description: How brands plug into the Quote agent — optionality guarantee, the snapshot-vs-live split, and the brand-delete integrity rule.
---

# Multi-Brand Quote Agent

Org-scoped `Brand` (identity/look/voice/assets_text/templates JSON) layered on top of the
single org-wide branding. A quote optionally carries `brand_id` (nullable).

## Optionality / backward-compat (the hard guarantee)
- Orgs with **no brands** behave exactly as before: `_resolve_brand` returns None →
  export uses `org_branding_dict`, no BRAND section in the AI prompt.
- Once an org has a **default brand**, a quote with no explicit `brand_id` resolves to
  that default (by design — see session plan). There is intentionally **no** "force
  org-branding" escape hatch; the composer's "No brand (org default)" option just sends
  no `brand_id` and lands on the default. Don't "fix" this without a spec change.

## Snapshot (frozen) vs live context (fresh) — the key split
- **Export** reads `quote.branding_snapshot` = `brand_branding_dict(brand)` frozen at
  creation (+ `template_id`). So exports stay stable even if the brand later changes or
  is deleted. `brand_branding_dict` must stay in sync with `branding.org_branding_dict`.
- **AI** context (`_brand_ai_context`) is rebuilt **fresh from the live Brand each turn**
  (voice/description/assets_text/selected template) so refinements track edits.
  `assets_text` is grounding DATA only — the prompt forbids inventing prices from it.

## Brand-delete integrity (non-obvious)
**Why:** Fresh DBs get `quotes.brand_id` FK `ON DELETE SET NULL` from the model, but DBs
upgraded via `database.py`'s self-heal ALTER add a **plain INTEGER column with no FK** —
and SQLite (the deploy target) doesn't enforce FKs anyway. So deleting a brand would
leave a dangling `quote.brand_id`.
**How to apply:** `delete_brand` explicitly `UPDATE quotes SET brand_id=NULL` for that
brand before deleting. The frozen `branding_snapshot` is untouched, so the export still
renders. Any future cross-table FK added via the ALTER path needs the same app-level
cleanup.

## Tenancy / authz
Writes (create/update/delete/assets/default) require admin; reads require user.
Cross-tenant id → 404 (never 403). First brand auto-defaults; deleting the default
promotes another; `set_default` clears the others.
