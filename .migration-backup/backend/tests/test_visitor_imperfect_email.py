"""Scanned cards must never lose phone/email to strict email validation.

OCR routinely produces technically-invalid emails (a missing TLD, a stray
comma or space where a dot should be). The scan pipeline writes whatever it
read straight onto the Visitor row, so if the API schema validated emails
strictly, serializing that row (`VisitorOut`) or saving an edit
(`VisitorUpdate`) would raise and the whole record — phone included — would
fail. These tests lock in that imperfect emails flow through untouched.
"""
from __future__ import annotations

from datetime import datetime

import pytest

from app.models import Visitor
from app.schemas import (
    CompanyOut,
    VisitorOut,
    VisitorUpdate,
)

# Emails that strict RFC validation (the old EmailStr) rejected but which OCR
# of a real business card commonly produces.
IMPERFECT_EMAILS = [
    "info@acme",          # TLD dropped by OCR / line wrap
    "rajesh@acme,com",    # comma misread for a dot
    "rajesh@acme .com",   # stray space
    "raj@acmeindia",      # no dot at all
]


@pytest.mark.parametrize("email", IMPERFECT_EMAILS)
def test_visitor_out_serializes_imperfect_email_with_phone(email):
    visitor = Visitor(
        id=1, org_id=1, name="Card Person",
        email=email, phone="+91 98765 43210", source="scan",
        contact_type="lead", created_at=datetime(2026, 1, 1),
    )
    out = VisitorOut.model_validate(visitor)
    assert out.email == email
    assert out.phone == "+91 98765 43210"


@pytest.mark.parametrize("email", IMPERFECT_EMAILS)
def test_visitor_update_accepts_imperfect_email(email):
    upd = VisitorUpdate(email=email, phone="+91 90000 11111")
    data = upd.model_dump(exclude_unset=True)
    assert data["email"] == email
    assert data["phone"] == "+91 90000 11111"


def test_company_out_serializes_imperfect_email():
    # Company emails come from the same scanned cards, so they're relaxed too.
    out = CompanyOut.model_validate({
        "id": 1, "name": "Acme", "email": "info@acme", "phone": "+91 20 1234",
        "created_at": datetime(2026, 1, 1),
    })
    assert out.email == "info@acme"
    assert out.phone == "+91 20 1234"
