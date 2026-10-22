---
name: Consent & Privacy Profile Score
description: How the org Privacy Score is scoped and what counts toward the consent-requested numerator.
---

# Consent & Privacy Profile Score

Org-level Consent & Privacy Profile: a Privacy Score, badges, trust rating, weekly/monthly trends, notifications.

- **Scope is per-ORG, not per-user.** Conversations have no creator user_id in the data model, so the score is computed across all of an org's `status=="analyzed"` conversations. Computed live from each conversation's `analysis.consent` block — no extra storage, so it updates as soon as a conversation is analyzed.
- **Score = consent_requested / total * 100.** A DECLINE counts toward the numerator (consent was still *requested* — the rep asked first), matching `_normalize_consent` which sets `consent_requested=True` on confirm OR decline. Only `not_requested` (incl. pre-feature conversations with no consent block) is excluded from the numerator.
  - **Why:** an early cut excluded declines; code review flagged it as off-spec and product-wrong (it penalized reps for asking and being told no). The metric measures the *asking* behavior, not the outcome.
  - **How to apply:** any change to the numerator must stay consistent across BOTH the org-level loop and the `_trend` numerator in `services/privacy_score.py`, and the stat `consent_requested` is the superset (confirmed + declined + requested-only).
- Pre-feature conversations lack a consent block → counted as `not_requested` so the denominator stays honest. Re-analyzing refines them.
