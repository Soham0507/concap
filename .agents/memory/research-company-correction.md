---
name: Research corrects scanned company
description: Why scan card-company is unreliable and how AI research overrides it
---

A scanned business card's company field is unreliable — OCR mistakes or the LLM
hallucinating an org. The person's name is usually right; the company often is
not (e.g. card scan → "Greenex Environmental" for a PEAK Technologies employee).

**Rule:** person research is the authority on the *current* employer. The person
prompt returns `current_company` (LinkedIn-verified, empty if unsure). When it is
non-empty and differs (case-insensitive) from the scanned company, prefer it:
research THAT company for the summary, overwrite `visitor.company`, and re-link
`visitor.company_id` to the corrected Company row.

**Why:** before this, company research used the wrong scanned name (→ "No company
summary found"), and the company link only set when `company_id` was None, so a
wrong scan-time link persisted. The correct employer was only visible buried in
the free-text person summary, never in the structured field.

**How to apply:** any flow that both researches a person and resolves their
company must derive the effective company from research first, then relink even
when a (wrong) link already exists. Empty scanned company + confirmed
current_company counts as a change and must fill/link.

**Address → city/state/country:** scanned cards carry one combined address line
but Company stores city/state/country separately. They are derived (India-aware,
deterministic) at company upsert time and gap-filled (never clobber manual
values). Parsing is STRICTLY PIN-anchored — city only from the 6-digit-PIN token
or the single token before it; no PIN ⇒ no city. Prefer returning None over a
guess so a wrong auto-fill can't get stuck behind the no-clobber rule.

**Dependent fields (industry, website):** company research also returns these.
When the company is unchanged, only gap-fill (never clobber an existing value).
When the company was *corrected*, REPLACE them — and clear them when research
returns nothing, because the scanned values belonged to the wrong company.
Apply these to the visitor BEFORE the company upsert so the Company row inherits
them. API convention: return the applied value as a string (""=cleared) so the
UI mirrors it; null/None means "left untouched".
