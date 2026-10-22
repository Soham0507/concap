"""AI research must survive the manual "Save contact" that follows it.

The scan review screen runs research (which persists company/person research
server-side) and then the user clicks Save, which PUTs the edited form. These
tests prove that the subsequent save does NOT silently revert the research:
the LinkedIn URL, person summary, corrected company link, and company
summary/competitors all stick. They also cover the contacts-page edit path,
where person research must be preserved even though the modal doesn't resend it.

Runs offline — research_svc is mocked, DB is in-memory SQLite.
"""
from __future__ import annotations

from app.models import Company, User, Visitor
from app.routers import scan as scan_router
from app.routers import visitors as visitors_router
from app.schemas import VisitorUpdate


def _user(db, org) -> User:
    u = User(org_id=org.id, email="rep@example.com", name="Rep", password_hash="x")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _patch_research(monkeypatch, *, current_company: str, linkedin: str):
    monkeypatch.setattr(scan_router.research_svc, "research_available", lambda: True)
    monkeypatch.setattr(
        scan_router.research_svc, "research_person",
        lambda **kw: {
            "linkedin_url": linkedin,
            "current_company": current_company,
            "summary": "David is a Senior Account Director at PEAK Technologies.",
            "sources": ["https://linkedin.com/in/fockel"],
        },
    )
    monkeypatch.setattr(
        scan_router.research_svc, "research_company",
        lambda name, website=None: {
            "summary": f"{name} does logistics things.",
            "competitors": [{"name": "Rival Co", "note": "same market"}],
            "industry": "Logistics & Transportation",
            "website": "https://example-peak.com",
            "sources": [],
        },
    )


def test_save_after_research_preserves_everything(db, org, monkeypatch):
    """Research corrects the company; the follow-up Save (with the form synced
    to the researched values) must keep the LinkedIn URL, summary, corrected
    company link, and company summary/competitors."""
    user = _user(db, org)
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

    _patch_research(
        monkeypatch,
        current_company="PEAK Technologies",
        linkedin="https://www.linkedin.com/in/fockel",
    )
    scan_router.research_contact(visitor_id=v.id, db=db, user=user)
    db.refresh(v)
    peak_id = v.company_id

    # The scan review form mirrors research (renderResearch syncs the fields),
    # so the Save sends the researched values back.
    payload = VisitorUpdate(
        name="David Fockel",
        company="PEAK Technologies",
        industry="Logistics & Transportation",
        website="https://example-peak.com",
        linkedin_url="https://www.linkedin.com/in/fockel",
        contact_type="lead",
    )
    visitors_router.update_visitor(visitor_id=v.id, payload=payload, db=db, user=user)
    db.refresh(v)

    assert v.linkedin_url == "https://www.linkedin.com/in/fockel"
    assert v.person_summary and "PEAK Technologies" in v.person_summary
    assert v.company == "PEAK Technologies"
    assert v.company_id == peak_id
    peak = db.get(Company, v.company_id)
    assert peak.summary and "logistics" in peak.summary.lower()
    assert peak.competitors


def test_contacts_edit_without_resending_research_keeps_it(db, org, monkeypatch):
    """Editing a contact on the contacts page (which doesn't resend person
    research) must not wipe the LinkedIn URL or AI summary already stored."""
    user = _user(db, org)
    v = Visitor(
        org_id=org.id, name="Jane Doe", company="Acme Corp", contact_type="lead",
        linkedin_url="https://www.linkedin.com/in/janedoe",
        person_summary="Jane leads sales at Acme.",
    )
    db.add(v)
    db.commit()
    db.refresh(v)

    # Contacts modal now resends linkedin_url (populated from the record), and
    # never resends person_summary — both must survive a routine edit.
    payload = VisitorUpdate(
        name="Jane Doe",
        designation="VP Sales",
        company="Acme Corp",
        linkedin_url="https://www.linkedin.com/in/janedoe",
        contact_type="customer",
    )
    visitors_router.update_visitor(visitor_id=v.id, payload=payload, db=db, user=user)
    db.refresh(v)

    assert v.designation == "VP Sales"
    assert v.contact_type == "customer"
    assert v.linkedin_url == "https://www.linkedin.com/in/janedoe"
    assert v.person_summary == "Jane leads sales at Acme."


def test_save_with_empty_linkedin_field_does_not_invent_one(db, org):
    """A contact with no LinkedIn stays empty through a save (no clobber, no
    accidental value)."""
    user = _user(db, org)
    v = Visitor(org_id=org.id, name="No Link", company="Acme", contact_type="lead")
    db.add(v)
    db.commit()
    db.refresh(v)

    payload = VisitorUpdate(name="No Link", company="Acme", linkedin_url=None, contact_type="lead")
    visitors_router.update_visitor(visitor_id=v.id, payload=payload, db=db, user=user)
    db.refresh(v)
    assert (v.linkedin_url or "") == ""
