"""Combined-address → city / state / country splitting.

A scanned card prints one address line, but Company stores city/state/country
separately. These tests lock in the deterministic, India-aware parser plus its
integration into the company upsert used by scan/visitor saves.
"""
from __future__ import annotations

from app.models import Company
from app.routers.companies import upsert_company_for_scan
from app.services.address import parse_address


def test_parses_indian_address_with_pin():
    city, state, country = parse_address("M403, Mega Center, Hadapsar, Pune - 411028")
    assert city == "Pune"
    assert state == "Maharashtra"
    assert country == "India"


def test_explicit_state_name_wins_over_pin_inference():
    city, state, country = parse_address("12 MG Road, Bengaluru, Karnataka 560001")
    assert city == "Bengaluru"
    assert state == "Karnataka"
    assert country == "India"


def test_pin_with_space_is_recognised():
    _, state, country = parse_address("Andheri East, Mumbai - 400 069")
    assert state == "Maharashtra"
    assert country == "India"


def test_blank_or_unparseable_returns_none():
    assert parse_address("") == (None, None, None)
    assert parse_address(None) == (None, None, None)


def test_no_pin_yields_no_city_or_state():
    # Without a PIN we won't guess a city/state from arbitrary tokens.
    city, state, country = parse_address("Bandra West, Mumbai")
    assert city is None
    assert state is None
    assert country is None


def test_state_with_pin_but_no_city_returns_none_city():
    # The only token on the PIN line is the state — don't mis-label it a city.
    city, state, country = parse_address("Maharashtra - 411028")
    assert city is None
    assert state == "Maharashtra"
    assert country == "India"


def test_country_token_on_pin_line_falls_back_to_prior_place():
    city, state, country = parse_address("Hadapsar, Pune, India - 411028")
    assert city == "Pune"
    assert state == "Maharashtra"
    assert country == "India"


def test_explicit_state_without_pin_sets_state_only():
    # State name printed but no PIN: state is still detected; city stays None
    # (PIN-anchored only) and country is unknown without a PIN or the word.
    city, state, country = parse_address("MG Road, Bengaluru, Karnataka")
    assert city is None
    assert state == "Karnataka"
    assert country is None


def test_upsert_fills_company_city_state_country(db, org):
    company = upsert_company_for_scan(
        db, org.id,
        name="PreCloud Technologies",
        address="M403, Mega Center, Hadapsar, Pune - 411028",
    )
    assert company is not None
    db.commit()
    db.refresh(company)
    assert company.city == "Pune"
    assert company.state == "Maharashtra"
    assert company.country == "India"


def test_upsert_does_not_clobber_existing_location(db, org):
    existing = Company(
        org_id=org.id, name="PreCloud Technologies",
        city="Mumbai", state="Maharashtra", country="India",
    )
    db.add(existing)
    db.commit()

    company = upsert_company_for_scan(
        db, org.id,
        name="PreCloud Technologies",
        address="M403, Mega Center, Hadapsar, Pune - 411028",
    )
    db.commit()
    db.refresh(company)
    # Manual value preserved; only blank fields would be enriched.
    assert company.city == "Mumbai"
