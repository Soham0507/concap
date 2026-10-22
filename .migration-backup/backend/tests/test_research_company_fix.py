"""Research must correct a wrong/stale company read off a scanned card.

The company name OCR'd from a business card is often blank, stale, or wrong.
When AI research confidently identifies the person's CURRENT employer (via their
LinkedIn), the endpoint must prefer it: research the correct company, correct
the stored value, re-link the company, and return it so the UI can update the
editable field.

Runs offline — research_svc is mocked, DB is in-memory SQLite.
"""
from __future__ import annotations

from app.models import Company, User, Visitor
from app.routers import scan as router


def _user(db, org) -> User:
    u = User(org_id=org.id, email="rep@example.com", name="Rep", password_hash="x")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _patch_research(monkeypatch, *, current_company: str):
    monkeypatch.setattr(router.research_svc, "research_available", lambda: True)
    monkeypatch.setattr(
        router.research_svc,
        "research_person",
        lambda **kw: {
            "linkedin_url": "https://www.linkedin.com/in/fockel",
            "current_company": current_company,
            "summary": "David is a Senior Account Director at PEAK Technologies.",
            "sources": ["https://linkedin.com/in/fockel"],
        },
    )
    monkeypatch.setattr(
        router.research_svc,
        "research_company",
        lambda name, website=None: {
            "summary": f"{name} does things.",
            "competitors": [],
            "industry": "Logistics & Transportation",
            "website": "https://example-peak.com",
            "sources": [],
        },
    )


def test_research_corrects_wrong_scanned_company(db, org, monkeypatch):
    # Scan produced the wrong company; a company row exists and the visitor is
    # linked to it (the original scan behavior).
    wrong = Company(org_id=org.id, name="Greenex Environmental")
    db.add(wrong)
    db.commit()
    db.refresh(wrong)
    v = Visitor(
        org_id=org.id, name="David Fockel", company="Greenex Environmental",
        company_id=wrong.id, contact_type="lead",
    )
    db.add(v)
    db.commit()
    db.refresh(v)

    _patch_research(monkeypatch, current_company="PEAK Technologies")
    out = router.research_contact(visitor_id=v.id, db=db, user=_user(db, org))

    assert out.current_company == "PEAK Technologies"
    db.refresh(v)
    assert v.company == "PEAK Technologies"
    # Re-linked away from the wrong company row.
    assert v.company_id != wrong.id
    assert out.company_summary and "PEAK Technologies" in out.company_summary
    # Industry / website auto-filled from company research and returned for UI.
    assert out.industry == "Logistics & Transportation"
    assert out.website == "https://example-peak.com"
    assert v.industry == "Logistics & Transportation"
    assert v.website == "https://example-peak.com"


def test_research_fills_empty_company(db, org, monkeypatch):
    # Card had no company at all; research's confirmed current employer fills it.
    v = Visitor(org_id=org.id, name="David Fockel", company="", contact_type="lead")
    db.add(v)
    db.commit()
    db.refresh(v)

    _patch_research(monkeypatch, current_company="PEAK Technologies")
    out = router.research_contact(visitor_id=v.id, db=db, user=_user(db, org))

    assert out.current_company == "PEAK Technologies"
    db.refresh(v)
    assert v.company == "PEAK Technologies"
    assert v.company_id is not None
    assert out.company_summary and "PEAK Technologies" in out.company_summary


def test_corrected_company_clears_stale_industry_website(db, org, monkeypatch):
    # Company is corrected but research can't confirm industry/website. The
    # scanned values belonged to the WRONG company, so they must be cleared.
    v = Visitor(
        org_id=org.id, name="David Fockel", company="Greenex Environmental",
        industry="Energy & Utilities", website="https://greenex.example",
        contact_type="lead",
    )
    db.add(v)
    db.commit()
    db.refresh(v)

    monkeypatch.setattr(router.research_svc, "research_available", lambda: True)
    monkeypatch.setattr(
        router.research_svc, "research_person",
        lambda **kw: {"linkedin_url": "", "current_company": "PEAK Technologies", "summary": "", "sources": []},
    )
    monkeypatch.setattr(
        router.research_svc, "research_company",
        lambda name, website=None: {"summary": "", "competitors": [], "industry": "", "website": "", "sources": []},
    )
    out = router.research_contact(visitor_id=v.id, db=db, user=_user(db, org))

    db.refresh(v)
    assert v.company == "PEAK Technologies"
    assert v.industry is None
    assert v.website is None
    # "" signals the UI to clear the field/pill.
    assert out.industry == ""
    assert out.website == ""


def test_unchanged_company_does_not_clobber_industry_website(db, org, monkeypatch):
    # Same company: existing non-empty industry/website must be left alone even
    # though research returns its own values (gap-fill only).
    v = Visitor(
        org_id=org.id, name="Jane Doe", company="PEAK Technologies",
        industry="Consulting", website="https://my-existing.example",
        contact_type="lead",
    )
    db.add(v)
    db.commit()
    db.refresh(v)

    _patch_research(monkeypatch, current_company="PEAK Technologies")
    out = router.research_contact(visitor_id=v.id, db=db, user=_user(db, org))

    db.refresh(v)
    assert v.industry == "Consulting"
    assert v.website == "https://my-existing.example"
    # Nothing applied → untouched, signalled as None.
    assert out.industry is None
    assert out.website is None


def test_research_keeps_company_when_unconfirmed(db, org, monkeypatch):
    # When research can't confirm a current company, leave the scanned value.
    v = Visitor(
        org_id=org.id, name="Jane Doe", company="Acme Corp", contact_type="lead",
    )
    db.add(v)
    db.commit()
    db.refresh(v)

    _patch_research(monkeypatch, current_company="")
    out = router.research_contact(visitor_id=v.id, db=db, user=_user(db, org))

    db.refresh(v)
    assert v.company == "Acme Corp"
    assert out.current_company is None
