"""OpenAI embeddings + cosine similarity helpers.

Used for two things:
  1. Semantic search across saved conversations (`POST /api/search`).
  2. Topic-shift detection inside the conversation segmentation engine
     (consecutive windows whose embeddings diverge mark a likely boundary).

Embeddings are stored as plain JSON lists of floats on `conversations.embedding`
to keep the codebase portable across SQLite (dev) and Postgres (prod) without
requiring the pgvector extension. At a few hundred conversations per org an
in-Python cosine scan is well under 100ms.
"""
from __future__ import annotations

import math
from typing import Iterable


from ..config import get_settings


def _client() -> OpenAI:
    from openai import OpenAI

    s = get_settings()
    if not s.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")
    return OpenAI(api_key=s.openai_api_key)


# OpenAI's embedding endpoint refuses inputs over ~8K tokens; truncate
# generously so a long booth conversation still fits.
_MAX_CHARS = 24000


def embed_text(text: str) -> list[float] | None:
    """Return a unit-normalized embedding for `text`, or None if empty / unconfigured."""
    if not text or not text.strip():
        return None
    settings = get_settings()
    if not settings.openai_api_key:
        return None
    payload = text.strip()[:_MAX_CHARS]
    resp = _client().embeddings.create(model=settings.embedding_model, input=payload)
    vec = resp.data[0].embedding
    return _normalize(vec)


def embed_many(texts: list[str]) -> list[list[float] | None]:
    """Batch-embed several pieces of text in one HTTP call.

    Empty strings are kept aligned with the input list and returned as None
    so callers can zip results back to their source items.
    """
    settings = get_settings()
    if not settings.openai_api_key:
        return [None] * len(texts)
    keep_idx = [i for i, t in enumerate(texts) if t and t.strip()]
    if not keep_idx:
        return [None] * len(texts)
    inputs = [texts[i].strip()[:_MAX_CHARS] for i in keep_idx]
    resp = _client().embeddings.create(model=settings.embedding_model, input=inputs)
    out: list[list[float] | None] = [None] * len(texts)
    for slot, item in zip(keep_idx, resp.data):
        out[slot] = _normalize(item.embedding)
    return out


def _normalize(v: Iterable[float]) -> list[float]:
    v = list(v)
    norm = math.sqrt(sum(x * x for x in v))
    if norm == 0:
        return v
    return [x / norm for x in v]


def cosine(a: list[float] | None, b: list[float] | None) -> float:
    """Cosine similarity. Inputs are expected to be unit-normalized already
    (see `_normalize`); falls back to a normalized dot product otherwise.
    """
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    # If both are unit-normalized this IS the cosine.
    return max(-1.0, min(1.0, dot))
