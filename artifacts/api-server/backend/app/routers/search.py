"""Semantic search across saved conversations.

Embed the user's query with the same model used at ingest, then rank the
caller-org's conversations by cosine similarity to the query embedding.
Returns lightweight result rows the dashboard can render without a second
fetch.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from ..database import get_db
from ..models import Conversation, User, Visitor
from ..services.embeddings import cosine, embed_text
from .auth import require_user

router = APIRouter(prefix="/api/search", tags=["search"])


class SearchRequest(BaseModel):
    query: str
    limit: int = 10


class SearchHit(BaseModel):
    conversation_id: int
    score: float
    topic: str | None
    visitor_name: str | None
    visitor_company: str | None
    summary: str | None
    lead_score: int | None
    lead_temperature: str | None
    created_at: str


@router.post("", response_model=list[SearchHit])
def semantic_search(
    payload: SearchRequest,
    db: DBSession = Depends(get_db),
    user: User = Depends(require_user),
) -> list[SearchHit]:
    q = (payload.query or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="query is required")
    limit = max(1, min(50, int(payload.limit or 10)))

    try:
        q_vec = embed_text(q)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Embedding failed: {exc}") from exc
    if not q_vec:
        raise HTTPException(
            status_code=400,
            detail="Cannot embed an empty query (or OPENAI_API_KEY is not set).",
        )

    # Only conversations in the caller's org. Skip rows without an embedding
    # (legacy data — they'll be backfilled the next time they're re-analyzed).
    rows = list(
        db.scalars(
            select(Conversation)
            .where(Conversation.org_id == user.org_id)
            .where(Conversation.embedding.is_not(None))
        )
    )

    scored: list[tuple[float, Conversation]] = []
    for c in rows:
        score = cosine(q_vec, c.embedding)
        if score > 0.0:
            scored.append((score, c))
    scored.sort(key=lambda x: x[0], reverse=True)

    hits: list[SearchHit] = []
    for score, c in scored[:limit]:
        v = db.get(Visitor, c.visitor_id) if c.visitor_id else None
        analysis = c.analysis or {}
        hits.append(SearchHit(
            conversation_id=c.id,
            score=round(float(score), 4),
            topic=c.topic,
            visitor_name=v.name if v else None,
            visitor_company=v.company if v else None,
            summary=(analysis.get("summary") or "")[:400] or None,
            lead_score=c.lead_score,
            lead_temperature=c.lead_temperature,
            created_at=c.created_at.isoformat() if c.created_at else "",
        ))
    return hits
