---
name: Scanner QR vs OCR merge precedence
description: How business-card QR-decoded fields must combine with OCR/LLM-parsed fields, and why.
---

# QR vs OCR/LLM field precedence (business-card scanner)

When merging a card's QR-decoded fields with the OCR/LLM-parsed fields:

- A **structured** QR (a real vCard/MeCard — it carries identity: name OR
  email OR phone) is authoritative and its fields win outright, including
  website/linkedin.
- A **bare-URL** QR (only a website/linkedin link, no identity — e.g. a
  "save my vCard" link, a digital-card landing page, or the company site)
  must **only gap-fill**. It must NOT overwrite a field the OCR/LLM already
  extracted.

**Why:** QR fields used to *always* override OCR/LLM. Cards very commonly put
a bare "download my card" URL in the QR, which clobbered the correct
website/links the LLM read off the card text. The camera path auto-captures
the instant any QR is detected, so nearly every camera/single scan had a QR
present — this was the user-reported "scanner not fetching proper details"
that hit camera/single-card scans but not bulk uploads.

**How to apply:** centralized in `_merge_fields(ocr_fields, qr_fields)` in
`backend/app/services/scanner.py`; `scan_image` routes all reconciliation
through it. Camera capture also waits ~600ms after QR detection before
grabbing the frame (autofocus settle) to avoid blurry pre-focus images.
