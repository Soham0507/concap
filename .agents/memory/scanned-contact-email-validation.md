---
name: Scanned contact email must not use strict EmailStr
description: Why Visitor/Company email fields are plain str, not pydantic EmailStr
---

Contact/CRM email fields (Visitor* and Company* schemas) are intentionally
plain `str`, NOT pydantic `EmailStr`.

**Why:** business-card emails come from OCR, which routinely produces
technically-invalid-but-useful values — a dropped TLD from line wrap
(`info@acme`), a comma misread for a dot (`rajesh@acme,com`), a stray space.
The scan pipeline writes whatever it parsed straight onto the Visitor/Company
row (bypassing the schema). If the response/update schema then validated
strictly, `VisitorOut.model_validate(row)` and the list endpoint would raise
and 500 the whole record — taking phone and every other field down with it —
and edits would 422. So strict email validation silently lost phone+email for
exactly the cards users care about. The app's principle is "never crash on an
imperfect card", so card-sourced data must never be rejected.

**How to apply:** keep account/identity emails (auth.py login/signup/invite,
org.py member email) strict with `EmailStr` — those are typed by humans into
forms. Only the scanned CRM fields are relaxed. If you add a new schema that
carries a scanned/OCR'd email, use `str`, not `EmailStr`.
