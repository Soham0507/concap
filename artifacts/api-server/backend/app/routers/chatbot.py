"""In-app assistant — a single /chat endpoint that lets a signed-in user ask
about their own org's conversations, hot/warm leads, and long-capture
sessions in plain language.

Org-scoped like the rest of the app. Each turn re-gathers a fresh snapshot
of the org's recent data (no server-side chat persistence — the widget keeps
the thread client-side and replays it), grounds Claude in that snapshot plus
the user's display name and the page they're currently viewing, and returns
a short reply.
"""
from __future__ import annotations

from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from ..database import get_db
from ..models import Conversation, Session as CaptureSession, User, Visitor
from ..services import chatbot_ai
from .auth import require_user

router = APIRouter(prefix="/api/chatbot", tags=["chatbot"])

# Caps on how much org data gets folded into a single prompt — enough for
# Claude to answer "who are my hot leads" or "what's in my latest session"
# without the snapshot (or the bill) growing unbounded.
_LEAD_LIMIT = 15
_RECENT_LIMIT = 10
_SESSION_LIMIT = 10


class ChatMessageIn(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatIn(BaseModel):
    message: str
    # Human-readable label of the page the user is currently on, e.g.
    # "Conversations (/conversations)". Sent by the widget on every turn so
    # the assistant stays aware of where the user is even as they navigate.
    current_page: str | None = None
    history: list[ChatMessageIn] = []


class ChatOut(BaseModel):
    reply: str


def _lead_lines(db: DBSession, org_id: int | None, temperature: str) -> list[str]:
    rows = db.execute(
        select(Conversation, Visitor)
        .join(Visitor, Visitor.id == Conversation.visitor_id)
        .where(Conversation.org_id == org_id, Conversation.lead_temperature == temperature)
        .order_by(Conversation.created_at.desc())
        .limit(_LEAD_LIMIT)
    ).all()
    lines = []
    for conv, visitor in rows:
        bits = [visitor.name or "Unknown contact"]
        if visitor.company:
            bits.append(f"at {visitor.company}")
        if conv.lead_score is not None:
            bits.append(f"(score {conv.lead_score})")
        if conv.topic:
            bits.append(f"— {conv.topic}")
        lines.append(f"conversation #{conv.id}: " + " ".join(bits))
    return lines


def _recent_conversation_lines(db: DBSession, org_id: int | None) -> list[str]:
    rows = db.execute(
        select(Conversation, Visitor)
        .join(Visitor, Visitor.id == Conversation.visitor_id)
        .where(Conversation.org_id == org_id)
        .order_by(Conversation.created_at.desc())
        .limit(_RECENT_LIMIT)
    ).all()
    lines = []
    for conv, visitor in rows:
        bits = [visitor.name or "Unknown contact", f"status={conv.status}"]
        if conv.lead_temperature:
            bits.append(f"temperature={conv.lead_temperature}")
        if conv.topic:
            bits.append(f"— {conv.topic}")
        lines.append(f"conversation #{conv.id} ({conv.created_at:%Y-%m-%d}): " + " ".join(bits))
    return lines


def _session_lines(db: DBSession, org_id: int | None) -> list[str]:
    rows = db.scalars(
        select(CaptureSession)
        .where(CaptureSession.org_id == org_id)
        .order_by(CaptureSession.created_at.desc())
        .limit(_SESSION_LIMIT)
    )
    lines = []
    for sess in rows:
        bits = [f"status={sess.status}"]
        if sess.event_name:
            bits.append(f"event={sess.event_name}")
        if sess.staff_name:
            bits.append(f"staff={sess.staff_name}")
        lines.append(f"session #{sess.id} \"{sess.name}\" ({sess.created_at:%Y-%m-%d}): " + " ".join(bits))
    return lines


def _build_system_prompt(user: User, current_page: str | None, db: DBSession) -> str:
    display_name = user.display_name or user.name or user.email

    hot = _lead_lines(db, user.org_id, "hot")
    warm = _lead_lines(db, user.org_id, "warm")
    recent = _recent_conversation_lines(db, user.org_id)
    sessions = _session_lines(db, user.org_id)

    def _block(title: str, items: list[str]) -> str:
        if not items:
            return f"{title}: none found."
        return f"{title}:\n" + "\n".join(f"- {line}" for line in items)

    page_note = f'They are currently on the "{current_page}" page.' if current_page else ""

    return (
        "You are Concap AI's in-app assistant, embedded as a chat widget inside the "
        "Concap booth-conversation-capture app. You help the signed-in user quickly "
        "find Conversations, Hot leads, Warm leads, and long-capture Sessions in "
        "their own organization's data.\n\n"
        f"The signed-in user's name is {display_name}. {page_note}\n\n"
        "Answer ONLY from the data snapshot below — it is already scoped to this "
        "user's organization. If the answer isn't in the snapshot, say you don't "
        "have that data rather than guessing, and suggest which page would have it "
        "(Conversations, All Meetings, Companies, Contacts, or Quotes). Keep replies "
        "short and conversational, use the visitor's name when referencing a lead, "
        "and mention the conversation or session id when it helps the user find the "
        "record in the app. Reply in plain text only — this widget renders raw text, "
        "not markdown, so never use **bold**, *italics*, backticks, or # headers; "
        "use plain sentences and dashes for lists instead.\n\n"
        "--- Data snapshot (most recent first, capped lists) ---\n"
        f"{_block('Hot leads', hot)}\n\n"
        f"{_block('Warm leads', warm)}\n\n"
        f"{_block('Recent conversations', recent)}\n\n"
        f"{_block('Recent sessions', sessions)}"
    )


@router.post("/chat", response_model=ChatOut)
def chat(
    body: ChatIn,
    db: DBSession = Depends(get_db),
    user: User = Depends(require_user),
) -> ChatOut:
    problem = chatbot_ai.describe_anthropic_problem()
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    message = (body.message or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="message is required")

    system = _build_system_prompt(user, body.current_page, db)
    history = [{"role": m.role, "content": m.content} for m in body.history]
    reply = chatbot_ai.answer(system, history, message)
    return ChatOut(reply=reply)
