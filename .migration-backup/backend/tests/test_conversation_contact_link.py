"""Relinking a conversation to a contact + listing a contact's conversations.

These exercise Task #23's two endpoints by calling the router functions
directly (the suite's established pattern — see test_scan_bulk.py). The focus
is tenant isolation: a conversation or contact from another org must be
invisible (404), and relinking must never attach another tenant's data.
"""
from __future__ import annotations

from datetime import datetime

import pytest
from fastapi import HTTPException

from app.models import Company, Conversation, Organization, User, Visitor
from app.routers.conversations import link_conversation_to_contact
from app.routers.visitors import list_visitor_conversations
from app.schemas import ConversationLinkContact


def _org(db, name="Org"):
    o = Organization(name=name, org_type="company")
    db.add(o)
    db.commit()
    db.refresh(o)
    return o


def _user(db, org):
    u = User(org_id=org.id, email=f"rep@{org.id}.example", name="Rep", password_hash="x")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _visitor(db, org, name="Person", company_id=None, company=None):
    v = Visitor(org_id=org.id, name=name, company=company, company_id=company_id,
                source="manual", contact_type="lead", created_at=datetime(2026, 1, 1))
    db.add(v)
    db.commit()
    db.refresh(v)
    return v


def _company(db, org, name="Acme"):
    c = Company(org_id=org.id, name=name, created_at=datetime(2026, 1, 1))
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _conversation(db, org, visitor, company_id=None, **extra):
    conv = Conversation(org_id=org.id, visitor_id=visitor.id, company_id=company_id,
                        status="completed", created_at=datetime(2026, 1, 2), **extra)
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return conv


def test_relink_moves_conversation_and_reinherits_company(db):
    org = _org(db)
    user = _user(db, org)
    company = _company(db, org, "Globex")
    old = _visitor(db, org, "Old Owner")
    new = _visitor(db, org, "New Owner", company_id=company.id)
    conv = _conversation(db, org, old)

    out = link_conversation_to_contact(
        conv.id, ConversationLinkContact(visitor_id=new.id), db=db, user=user
    )

    assert out.visitor_id == new.id
    # Company is re-resolved from the new contact's company.
    assert out.company_id == company.id


def test_relink_to_contact_without_company_clears_company(db):
    org = _org(db)
    user = _user(db, org)
    company = _company(db, org)
    owner = _visitor(db, org, "Owner", company_id=company.id)
    plain = _visitor(db, org, "No Company Person")
    conv = _conversation(db, org, owner, company_id=company.id)

    out = link_conversation_to_contact(
        conv.id, ConversationLinkContact(visitor_id=plain.id), db=db, user=user
    )

    assert out.visitor_id == plain.id
    assert out.company_id is None


def test_relink_rejects_cross_tenant_visitor(db):
    org_a = _org(db, "A")
    org_b = _org(db, "B")
    user_a = _user(db, org_a)
    conv = _conversation(db, org_a, _visitor(db, org_a, "Mine"))
    intruder = _visitor(db, org_b, "Theirs")

    with pytest.raises(HTTPException) as exc:
        link_conversation_to_contact(
            conv.id, ConversationLinkContact(visitor_id=intruder.id), db=db, user=user_a
        )
    assert exc.value.status_code == 404


def test_relink_rejects_cross_tenant_conversation(db):
    org_a = _org(db, "A")
    org_b = _org(db, "B")
    user_b = _user(db, org_b)
    conv = _conversation(db, org_a, _visitor(db, org_a, "Mine"))
    mine_b = _visitor(db, org_b, "B Person")

    with pytest.raises(HTTPException) as exc:
        link_conversation_to_contact(
            conv.id, ConversationLinkContact(visitor_id=mine_b.id), db=db, user=user_b
        )
    assert exc.value.status_code == 404


def test_list_visitor_conversations_returns_only_that_contacts(db):
    org = _org(db)
    user = _user(db, org)
    company = _company(db, org, "Initech")
    target = _visitor(db, org, "Target", company_id=company.id)
    other = _visitor(db, org, "Other")
    _conversation(db, org, target, company_id=company.id, topic="Pricing",
                  analysis={"summary": "Discussed pricing."})
    _conversation(db, org, target)
    _conversation(db, org, other)  # belongs to someone else

    rows = list_visitor_conversations(target.id, db=db, user=user)

    assert len(rows) == 2
    top = rows[0]  # newest first; the second-created one
    # The one with topic/summary carries them through.
    by_topic = {r.topic: r for r in rows}
    assert by_topic["Pricing"].summary == "Discussed pricing."
    assert by_topic["Pricing"].company_name == "Initech"


def test_list_visitor_conversations_never_leaks_foreign_company_name(db):
    # A conversation carrying a dangling cross-tenant company_id (e.g. left by
    # a bug) must not surface that other tenant's company name.
    org_a = _org(db, "A")
    org_b = _org(db, "B")
    user_a = _user(db, org_a)
    foreign = _company(db, org_b, "Secret Corp")
    person = _visitor(db, org_a, "A Person")
    _conversation(db, org_a, person, company_id=foreign.id)

    rows = list_visitor_conversations(person.id, db=db, user=user_a)

    assert len(rows) == 1
    assert rows[0].company_id is None
    assert rows[0].company_name is None


def test_list_visitor_conversations_rejects_cross_tenant(db):
    org_a = _org(db, "A")
    org_b = _org(db, "B")
    user_b = _user(db, org_b)
    target = _visitor(db, org_a, "A Person")

    with pytest.raises(HTTPException) as exc:
        list_visitor_conversations(target.id, db=db, user=user_b)
    assert exc.value.status_code == 404
