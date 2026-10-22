---
name: Quote proposal rich-text subset
description: The constrained markdown-like subset used in quote proposal_text/notes and the rule that every render surface must stay in sync.
---

# Quote proposal rich-text formatting

Quote `proposal_text` and `notes` are stored as plain text but use a **constrained
markdown-like subset only**: blank-line-separated paragraphs, `- ` bullet lines,
`## ` sub-headings, and `**bold**` inline emphasis. No other markdown (tables,
numbered lists, links, code fences, single-`*` emphasis) is permitted — the agent
prompt (`quote_ai.py` `_SYSTEM`) enforces this.

**Why:** proposals were dense prose; this subset adds structure without a WYSIWYG
editor and keeps the fields plain-text-storable.

**How to apply:** the canonical parser is `parse_rich_blocks()` in
`backend/app/services/quote_export.py` (tolerant: also accepts `*`/`•` bullets and
1–6 `#` headings; a content-less marker line is dropped, not leaked as prose). Any
render surface MUST mirror it:
- PDF + DOCX exports use `_pdf_render_rich` / `_docx_render_rich`.
- The frontend editor preview re-implements the same logic in `frontend/quotes.js`
  (`renderProposalHTML` / `inlineFmt`) — escape first, then apply `**bold**`, emit
  only `<p>/<h4>/<ul>/<li>/<strong>`.
If you add a new export format or change the subset, update the prompt AND all
mirrors together or they drift.

**Pricing-consistency interaction:** the no-aggregate-money-in-prose rule
(line_items table is the single source of totals) is still prompt-level only — the
bullets change did not add a backend scrub. Keep that PRICING CONSISTENCY block in
`_SYSTEM` intact when editing the prompt.
