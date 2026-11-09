"""Tests for the in-app assistant (/api/chatbot/chat).

Fully offline: the Anthropic key check is forced "configured" and
chatbot_ai.answer is monkeypatched to a deterministic stub that just echoes
the system prompt it was given, so the tests assert on prompt content
(user name, current page, data snapshot) without any network or real
credentials. Routes are called directly (the suite's convention — see
tests/test_quotes.py).
"""
from __future__ import annotations

import pytest

from app.models import Conversation, Organization, Session as CaptureSession, User, Visitor
from app.routers import chatbot as router


def _user(db, org, email="rep@example.com", name="Jamie Rep") -> User:
    u = User(org_id=org.id, email=email, name=name, password_hash="x", role="owner")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _visitor(db, org, name="Jane Doe", company="Acme") -> Visitor:
    v = Visitor(org_id=org.id, name=name, company=company)
    db.add(v)
    db.commit()
    db.refresh(v)
    return v


def _conversation(db, org, visitor, temperature=None, score=None, topic=None, status="analyzed") -> Conversation:
    c = Conversation(
        org_id=org.id,
        visitor_id=visitor.id,
        status=status,
        lead_temperature=temperature,
        lead_score=score,
        topic=topic,
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _session(db, org, name="Day 1 booth capture", status="processed") -> CaptureSession:
    s = CaptureSession(org_id=org.id, name=name, status=status)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


@pytest.fixture
def ai_echo(monkeypatch):
    """Force the AI 'configured' check on and replace chatbot_ai.answer with a
    stub that returns the system prompt verbatim, so tests can assert on its
    content instead of needing a real model response."""
    monkeypatch.setattr(router.chatbot_ai, "describe_anthropic_problem", lambda: None)
    captured = {}

    def _answer(system, history, message):
        captured["system"] = system
        captured["history"] = history
        captured["message"] = message
        return "stubbed reply"

    monkeypatch.setattr(router.chatbot_ai, "answer", _answer)
    return captured


def test_chat_includes_user_name_and_current_page(db, org, ai_echo):
    user = _user(db, org, name="Jamie Rep")

    out = router.chat(
        router.ChatIn(message="Who are my hot leads?", current_page="Conversations (/conversations)"),
        db=db,
        user=user,
    )

    assert out.reply == "stubbed reply"
    assert "Jamie Rep" in ai_echo["system"]
    assert "Conversations (/conversations)" in ai_echo["system"]
    assert ai_echo["message"] == "Who are my hot leads?"


def test_chat_grounds_in_hot_and_warm_leads(db, org, ai_echo):
    user = _user(db, org)
    hot_visitor = _visitor(db, org, name="Priya Patel", company="Acme Corp")
    warm_visitor = _visitor(db, org, name="Sam Lee", company="Globex")
    _conversation(db, org, hot_visitor, temperature="hot", score=92, topic="Enterprise plan")
    _conversation(db, org, warm_visitor, temperature="warm", score=61, topic="Pricing questions")

    router.chat(router.ChatIn(message="hi"), db=db, user=user)

    system = ai_echo["system"]
    assert "Priya Patel" in system
    assert "Acme Corp" in system
    assert "Sam Lee" in system
    assert "92" in system


def test_chat_grounds_in_sessions(db, org, ai_echo):
    user = _user(db, org)
    _session(db, org, name="Expo booth day 2")

    router.chat(router.ChatIn(message="what sessions do I have?"), db=db, user=user)

    assert "Expo booth day 2" in ai_echo["system"]


def test_chat_is_org_scoped(db, org, ai_echo):
    user = _user(db, org)
    other_org = Organization(name="Other Org", org_type="company")
    db.add(other_org)
    db.commit()
    db.refresh(other_org)
    other_visitor = _visitor(db, other_org, name="Leaky Lead")
    _conversation(db, other_org, other_visitor, temperature="hot", score=99)

    router.chat(router.ChatIn(message="hot leads?"), db=db, user=user)

    assert "Leaky Lead" not in ai_echo["system"]


def test_chat_blocked_without_ai(db, org, monkeypatch):
    monkeypatch.setattr(router.chatbot_ai, "describe_anthropic_problem", lambda: "AI not configured")
    user = _user(db, org)

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        router.chat(router.ChatIn(message="hi"), db=db, user=user)
    assert exc.value.status_code == 400


def test_chat_rejects_empty_message(db, org, ai_echo):
    user = _user(db, org)

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        router.chat(router.ChatIn(message="   "), db=db, user=user)
    assert exc.value.status_code == 400
