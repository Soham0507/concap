"""Consent & Privacy Profile scoring.

Computes an organization's Consent & Privacy Profile entirely on the fly from
the consent block that `analysis.py` stores on each analyzed conversation. No
extra storage is needed, so the score reflects every processed conversation the
moment its analysis lands.

Scope note: conversations are not attributed to an individual user in the data
model, so the score is computed per-organization (across all the org's analyzed
conversations). Conversations analyzed before consent detection existed simply
lack a consent block; those are counted as "consent not requested" so the
denominator stays honest. Re-analyzing an old conversation refines its
classification.
"""
from __future__ import annotations

from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Conversation

# Badge thresholds (see the product spec).
_PRIVACY_CHAMPION_MIN_SCORE = 90
_PRIVACY_CHAMPION_MIN_CONVOS = 20
_TRUST_BUILDER_MIN_SCORE = 80
_ETHICAL_COMM_MIN_SCORE = 70

BADGES = [
    {
        "key": "privacy_champion",
        "name": "Privacy Champion",
        "description": "Consistently requests consent before recording conversations.",
    },
    {
        "key": "community_trust_builder",
        "name": "Community Trust Builder",
        "description": "Promotes transparency and trust in communication.",
    },
    {
        "key": "ethical_communicator",
        "name": "Ethical Communicator",
        "description": "Demonstrates responsible use of AI and recording tools.",
    },
]


def _consent_block(conv: Conversation) -> dict[str, Any]:
    analysis = conv.analysis if isinstance(conv.analysis, dict) else {}
    block = analysis.get("consent") if isinstance(analysis, dict) else None
    if not isinstance(block, dict):
        return {}
    return block


def _status(block: dict[str, Any]) -> str:
    status = str(block.get("consent_status") or "").strip().lower()
    if status in {"requested", "confirmed", "not_requested", "declined"}:
        return status
    # Fall back to deriving from the booleans for safety.
    if block.get("consent_declined"):
        return "declined"
    if block.get("consent_confirmed"):
        return "confirmed"
    if block.get("consent_requested"):
        return "requested"
    return "not_requested"


def _rate(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return round(numerator / denominator * 100, 1)


def _trust_rating(score: float, total: int) -> str:
    if total == 0:
        return "No data yet"
    if score >= 90:
        return "Excellent"
    if score >= 75:
        return "Good"
    if score >= 50:
        return "Fair"
    return "Needs improvement"


def _earned_badges(score: float, total: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for badge in BADGES:
        earned = False
        if badge["key"] == "privacy_champion":
            earned = score >= _PRIVACY_CHAMPION_MIN_SCORE and total >= _PRIVACY_CHAMPION_MIN_CONVOS
        elif badge["key"] == "community_trust_builder":
            earned = score >= _TRUST_BUILDER_MIN_SCORE
        elif badge["key"] == "ethical_communicator":
            earned = score >= _ETHICAL_COMM_MIN_SCORE
        out.append({**badge, "earned": earned})
    return out


def _period_key(dt: datetime, *, weekly: bool) -> str:
    if weekly:
        iso = dt.isocalendar()
        return f"{iso[0]}-W{iso[1]:02d}"
    return f"{dt.year}-{dt.month:02d}"


def _trend(rows: list[tuple[datetime, str]], *, weekly: bool, buckets: int) -> list[dict[str, Any]]:
    """Build an ordered consent-rate time series for the most recent N periods."""
    now = datetime.now(timezone.utc)
    # Seed the buckets we want to show (most recent N), oldest first, so the
    # series is contiguous even for periods with zero conversations.
    seeded: "OrderedDict[str, list[int]]" = OrderedDict()
    for i in range(buckets - 1, -1, -1):
        if weekly:
            ref = now - timedelta(weeks=i)
        else:
            # Step back i months by anchoring to the first of the month.
            month = now.month - i
            year = now.year
            while month <= 0:
                month += 12
                year -= 1
            ref = now.replace(year=year, month=month, day=1)
        seeded[_period_key(ref, weekly=weekly)] = [0, 0]  # [requested, total]

    for created_at, status in rows:
        if created_at is None:
            continue
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        key = _period_key(created_at, weekly=weekly)
        if key not in seeded:
            continue
        seeded[key][1] += 1
        # Consent was requested for requested/confirmed/declined (a decline
        # still required asking first) — mirror the org-level numerator.
        if status in {"requested", "confirmed", "declined"}:
            seeded[key][0] += 1

    return [
        {"period": key, "consent_requests": v[0], "total": v[1], "rate": _rate(v[0], v[1])}
        for key, v in seeded.items()
    ]


def _notifications(score: float, total: int, monthly: list[dict[str, Any]], badges: list[dict[str, Any]]) -> list[str]:
    msgs: list[str] = []
    if total == 0:
        msgs.append("Record a few conversations to start building your Consent & Privacy score.")
        return msgs

    this_month = monthly[-1] if monthly else None
    if this_month and this_month["total"] > 0:
        msgs.append(
            f"You requested consent in {this_month['rate']:.0f}% of your conversations this month."
        )

    earned = [b for b in badges if b["earned"]]
    if earned:
        top = earned[0]
        msgs.append(f"Your {top['name']} badge has been earned.")

    if score < _ETHICAL_COMM_MIN_SCORE:
        msgs.append("Requesting consent before recording can improve your trust score.")
    return msgs


def compute_privacy_profile(db: Session, org_id: int | None) -> dict[str, Any]:
    """Return the full Consent & Privacy Profile for an organization."""
    rows = db.scalars(
        select(Conversation).where(
            Conversation.org_id == org_id,
            Conversation.status == "analyzed",
        )
    ).all()

    total = len(rows)
    requested = confirmed = declined = missing = recording_before = privacy_explained = 0
    trend_rows: list[tuple[datetime, str]] = []

    for conv in rows:
        block = _consent_block(conv)
        status = _status(block)
        # A decline still means consent WAS requested (the rep asked first),
        # so it counts toward the consent-requested numerator just like a
        # plain request or a confirmation. Confirmed/declined are also tracked
        # separately for the breakdown stats.
        if status == "confirmed":
            requested += 1
            confirmed += 1
        elif status == "requested":
            requested += 1
        elif status == "declined":
            requested += 1
            declined += 1
        else:  # not_requested (includes pre-feature conversations with no block)
            missing += 1
        if block.get("recording_before_consent"):
            recording_before += 1
        if block.get("privacy_explained"):
            privacy_explained += 1
        trend_rows.append((conv.created_at, status))

    score = _rate(requested, total)
    badges = _earned_badges(score, total)
    weekly = _trend(trend_rows, weekly=True, buckets=8)
    monthly = _trend(trend_rows, weekly=False, buckets=6)

    return {
        "privacy_score": score,
        "trust_rating": _trust_rating(score, total),
        "stats": {
            "total_recorded": total,
            "consent_requested": requested,
            "consent_confirmed": confirmed,
            "consent_declined": declined,
            "consent_missing": missing,
            "recording_before_consent": recording_before,
            "privacy_explained": privacy_explained,
        },
        "badges": badges,
        "trends": {
            "weekly": weekly,
            "monthly": monthly,
            "compliance_percentage": score,
        },
        "notifications": _notifications(score, total, monthly, badges),
    }
