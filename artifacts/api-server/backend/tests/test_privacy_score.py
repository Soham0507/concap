"""Tests for the Consent & Privacy Profile feature.

Fully offline: uses the in-memory SQLite `db`/`org`/`user` fixtures from
conftest.py. Routes are called directly (the suite's convention) rather than
through a TestClient.
"""
from __future__ import annotations

from datetime import datetime, timezone

from app.models import Conversation, Visitor
from app.routers import privacy as privacy_router
from app.services.analysis import _normalize_consent
from app.services.privacy_score import compute_privacy_profile


# --- consent normalization -------------------------------------------------

def test_normalize_consent_defaults_to_not_requested():
    out = _normalize_consent(None)
    assert out["consent_status"] == "not_requested"
    assert out["consent_requested"] is False
    assert out["consent_confirmed"] is False


def test_normalize_consent_confirm_implies_requested():
    out = _normalize_consent({"consent_confirmed": True})
    assert out["consent_requested"] is True
    assert out["consent_status"] == "confirmed"


def test_normalize_consent_decline_clears_confirmed_and_implies_requested():
    out = _normalize_consent({"consent_confirmed": True, "consent_declined": True})
    assert out["consent_declined"] is True
    assert out["consent_confirmed"] is False
    assert out["consent_requested"] is True
    assert out["consent_status"] == "declined"


def test_normalize_consent_requested_only():
    out = _normalize_consent({"consent_requested": True})
    assert out["consent_status"] == "requested"


# --- helpers ---------------------------------------------------------------

def _conv(db, org, consent=None, *, status="analyzed", created_at=None):
    analysis = {}
    if consent is not None:
        analysis["consent"] = consent
    v = Visitor(org_id=org.id, name="Visitor")
    db.add(v)
    db.commit()
    db.refresh(v)
    c = Conversation(
        org_id=org.id,
        visitor_id=v.id,
        status=status,
        analysis=analysis or None,
        created_at=created_at or datetime.now(timezone.utc),
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


# --- score math ------------------------------------------------------------

def test_empty_org_has_zero_score(db, org):
    profile = compute_privacy_profile(db, org.id)
    assert profile["privacy_score"] == 0.0
    assert profile["stats"]["total_recorded"] == 0
    assert profile["trust_rating"] == "No data yet"


def test_score_counts_requested_over_total(db, org):
    _conv(db, org, {"consent_confirmed": True})  # requested+confirmed
    _conv(db, org, {"consent_requested": True})  # requested
    _conv(db, org, {"consent_declined": True})   # declined -> still requested
    _conv(db, org, None)                          # missing block -> not_requested
    profile = compute_privacy_profile(db, org.id)
    s = profile["stats"]
    assert s["total_recorded"] == 4
    # A decline still means consent was asked first, so it counts as requested.
    assert s["consent_requested"] == 3
    assert s["consent_confirmed"] == 1
    assert s["consent_declined"] == 1
    assert s["consent_missing"] == 1
    assert profile["privacy_score"] == 75.0


def test_all_declined_still_counts_as_requested(db, org):
    # The rep always asked permission; every prospect declined. The
    # consent-request rate is 100% even though nobody agreed.
    _conv(db, org, {"consent_declined": True})
    _conv(db, org, {"consent_declined": True})
    profile = compute_privacy_profile(db, org.id)
    assert profile["privacy_score"] == 100.0
    assert profile["stats"]["consent_requested"] == 2
    assert profile["stats"]["consent_declined"] == 2
    assert profile["stats"]["consent_confirmed"] == 0


def test_missing_consent_block_counts_as_not_requested(db, org):
    _conv(db, org, None)
    _conv(db, org, None)
    profile = compute_privacy_profile(db, org.id)
    assert profile["privacy_score"] == 0.0
    assert profile["stats"]["consent_missing"] == 2


def test_non_analyzed_conversations_excluded(db, org):
    _conv(db, org, {"consent_confirmed": True})
    _conv(db, org, {"consent_confirmed": True}, status="pending")
    profile = compute_privacy_profile(db, org.id)
    assert profile["stats"]["total_recorded"] == 1


def test_org_isolation(db, org):
    from app.models import Organization

    other = Organization(name="Other Org", org_type="company")
    db.add(other)
    db.commit()
    db.refresh(other)
    _conv(db, org, {"consent_confirmed": True})
    _conv(db, other, {"consent_declined": True})
    profile = compute_privacy_profile(db, org.id)
    assert profile["stats"]["total_recorded"] == 1
    assert profile["privacy_score"] == 100.0


# --- badges ----------------------------------------------------------------

def _badge(profile, key):
    return next(b for b in profile["badges"] if b["key"] == key)


def test_privacy_champion_requires_score_and_volume(db, org):
    # 19 confirmed convs: score 100 but below the 20-convo floor.
    for _ in range(19):
        _conv(db, org, {"consent_confirmed": True})
    profile = compute_privacy_profile(db, org.id)
    assert profile["privacy_score"] == 100.0
    assert _badge(profile, "privacy_champion")["earned"] is False
    assert _badge(profile, "community_trust_builder")["earned"] is True
    assert _badge(profile, "ethical_communicator")["earned"] is True


def test_privacy_champion_earned_at_volume(db, org):
    for _ in range(20):
        _conv(db, org, {"consent_confirmed": True})
    profile = compute_privacy_profile(db, org.id)
    assert _badge(profile, "privacy_champion")["earned"] is True


def test_low_score_earns_no_badges(db, org):
    _conv(db, org, {"consent_confirmed": True})
    _conv(db, org, None)
    _conv(db, org, None)  # score ~33
    profile = compute_privacy_profile(db, org.id)
    assert all(b["earned"] is False for b in profile["badges"])


# --- trends ----------------------------------------------------------------

def test_trends_have_expected_bucket_counts(db, org):
    _conv(db, org, {"consent_confirmed": True})
    profile = compute_privacy_profile(db, org.id)
    assert len(profile["trends"]["weekly"]) == 8
    assert len(profile["trends"]["monthly"]) == 6
    # The current bucket holds the conversation we just created.
    assert profile["trends"]["weekly"][-1]["total"] == 1
    assert profile["trends"]["weekly"][-1]["rate"] == 100.0


# --- endpoint --------------------------------------------------------------

def test_endpoint_returns_profile(db, org, user):
    _conv(db, org, {"consent_requested": True})
    out = privacy_router.privacy_profile(db=db, user=user)
    assert out["stats"]["total_recorded"] == 1
    assert out["privacy_score"] == 100.0
    assert "badges" in out and "trends" in out and "notifications" in out
