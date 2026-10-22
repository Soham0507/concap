"""Tests for org branding settings (logo + company details for proposals).

Fully offline: uses the in-memory SQLite `db`/`org` fixtures from conftest.py.
Routes are called directly (the suite's convention) rather than through a
TestClient.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.models import Organization, User
from app.routers import branding as router


def _user(db, org, role="owner", email="owner@example.com") -> User:
    u = User(org_id=org.id, email=email, name="Owner", password_hash="x", role=role)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def test_get_branding_defaults(db, org):
    user = _user(db, org)
    out = router.get_branding(db=db, user=user)
    assert out["company_name"] is None
    assert out["currency"] == "$"
    assert "ai_configured" in out


def test_update_branding_persists(db, org):
    admin = _user(db, org, role="owner")
    body = router.BrandingIn(
        company_name="Acme Inc.",
        address="123 Market St",
        email="hello@acme.com",
        phone="+1 555 0100",
        website="acme.com",
        primary_color="#141414",
        accent_color="#FF5B2E",
        currency="€",
    )
    out = router.update_branding(body, db=db, user=admin)
    assert out["company_name"] == "Acme Inc."
    assert out["currency"] == "€"
    assert out["accent_color"] == "#FF5B2E"

    org_row = db.get(Organization, org.id)
    assert org_row.brand_company_name == "Acme Inc."
    assert org_row.brand_updated_at is not None


def test_update_rejects_non_image_logo(db, org):
    admin = _user(db, org)
    body = router.BrandingIn(logo_data_url="data:text/plain;base64,Zm9v")
    with pytest.raises(HTTPException) as ei:
        router.update_branding(body, db=db, user=admin)
    assert ei.value.status_code == 400


def test_update_rejects_oversized_logo(db, org):
    admin = _user(db, org)
    huge = "data:image/png;base64," + ("A" * (router.MAX_LOGO_CHARS + 1))
    body = router.BrandingIn(logo_data_url=huge)
    with pytest.raises(HTTPException) as ei:
        router.update_branding(body, db=db, user=admin)
    assert ei.value.status_code == 400


def test_empty_logo_string_clears(db, org):
    admin = _user(db, org)
    org.brand_logo_data_url = "data:image/png;base64,AAAA"
    db.commit()
    out = router.update_branding(router.BrandingIn(logo_data_url=""), db=db, user=admin)
    assert out["logo_data_url"] is None


def test_org_branding_dict_handles_missing_org():
    d = router.org_branding_dict(None)
    assert d == {"currency": "$"}
