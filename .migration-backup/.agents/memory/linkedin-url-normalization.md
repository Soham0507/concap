---
name: LinkedIn URL normalization
description: Why scheme-less linkedin_url breaks links, and where normalization lives.
---

A `linkedin_url` stored without a scheme (`linkedin.com/in/x`) is a **relative**
link in the browser and 404s when used as an `<a href>`. This happens because
the contacts edit modal placeholder suggested the bare form and printed cards
often omit the scheme.

**Rule:** normalization (prefix `https://` when no scheme) lives in
`backend/app/schemas.py` via `_normalize_linkedin` + a `field_validator` on
`VisitorIn` / `VisitorUpdate` (inherited by `VisitorOut`).

**Why here:** `VisitorOut` uses `from_attributes`, so the validator runs on BOTH
write and ORM-read — already-stored bare values are fixed on display with no
data migration, covering contacts/companies/scan in one place.

**How to apply:** don't re-add per-template normalization in JS (companies.js
historically did its own). Trust the schema. The scan research path
(`ResearchOut` in routers/scan.py) is already clean because `research_person`
and scanner `_normalize_url` prefix the scheme upstream.
