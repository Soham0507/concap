"""Org branding settings — the logo + company details the Quote agent stamps
onto generated proposals.

Org-scoped: every member reads their org's branding; only owner/admin may
change it (it's an org-wide setting). The logo is stored as a data: URI on the
Organization row so it travels with the DB and needs no separate file store.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import Organization, User, utcnow
from .auth import require_admin, require_user

router = APIRouter(prefix="/api/branding", tags=["branding"])

# Hard cap on the stored logo data URI. ~1.5 MB of base64 ≈ a ~1.1 MB image —
# plenty for a logo and small enough to keep the row and exports light.
MAX_LOGO_CHARS = 1_500_000


class BrandingIn(BaseModel):
    company_name: str | None = None
    logo_data_url: str | None = None
    address: str | None = None
    email: str | None = None
    phone: str | None = None
    website: str | None = None
    primary_color: str | None = None
    accent_color: str | None = None
    currency: str | None = None


def _branding_out(org: Organization) -> dict:
    return {
        "company_name": org.brand_company_name,
        "logo_data_url": org.brand_logo_data_url,
        "address": org.brand_address,
        "email": org.brand_email,
        "phone": org.brand_phone,
        "website": org.brand_website,
        "primary_color": org.brand_primary_color,
        "accent_color": org.brand_accent_color,
        "currency": org.brand_currency or "$",
        "updated_at": (org.brand_updated_at.isoformat() + "Z") if org.brand_updated_at else None,
        "ai_configured": get_settings().anthropic_configured(),
    }


def org_branding_dict(org: Organization | None) -> dict:
    """Plain branding dict (no updated_at) for the export renderers / quote
    snapshots. Safe on a missing org."""
    if org is None:
        return {"currency": "$"}
    return {
        "company_name": org.brand_company_name,
        "logo_data_url": org.brand_logo_data_url,
        "address": org.brand_address,
        "email": org.brand_email,
        "phone": org.brand_phone,
        "website": org.brand_website,
        "primary_color": org.brand_primary_color,
        "accent_color": org.brand_accent_color,
        "currency": org.brand_currency or "$",
    }


@router.get("")
def get_branding(
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    org = db.get(Organization, user.org_id) if user.org_id else None
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    return _branding_out(org)


@router.put("")
def update_branding(
    body: BrandingIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    org = db.get(Organization, user.org_id) if user.org_id else None
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")

    logo = body.logo_data_url
    if logo is not None and logo != "":
        if not logo.startswith("data:image/"):
            raise HTTPException(status_code=400, detail="Logo must be an image data URL")
        if len(logo) > MAX_LOGO_CHARS:
            raise HTTPException(
                status_code=400,
                detail="Logo image is too large — please use one under ~1 MB.",
            )

    org.brand_company_name = (body.company_name or "").strip() or None
    # Empty string clears the logo; None leaves it untouched is not supported
    # here — the form always sends the full state, so empty means "remove".
    org.brand_logo_data_url = logo or None
    org.brand_address = (body.address or "").strip() or None
    org.brand_email = (body.email or "").strip() or None
    org.brand_phone = (body.phone or "").strip() or None
    org.brand_website = (body.website or "").strip() or None
    org.brand_primary_color = (body.primary_color or "").strip() or None
    org.brand_accent_color = (body.accent_color or "").strip() or None
    org.brand_currency = (body.currency or "").strip() or "$"
    org.brand_updated_at = utcnow()
    db.commit()
    db.refresh(org)
    return _branding_out(org)
