"""In-app assistant — answers questions about the signed-in user's own org
data (conversations, hot/warm leads, sessions) using Anthropic Claude.

Uses Replit AI Integrations for Anthropic access, same as the Quote agent
(services/quote_ai.py) — no own API key required. The client is created
lazily inside the call function so importing this module never requires the
env vars to be present.
"""
from __future__ import annotations

from ..config import get_settings

MAX_TOKENS = 1024
# Keep the rolling chat history bounded so a long-lived widget session never
# grows the prompt unboundedly.
MAX_HISTORY_MESSAGES = 12


def describe_anthropic_problem() -> str | None:
    """Return a human-readable reason the assistant can't run, or None when
    it's good to go. Used by the router to return a clean 400 instead of a
    500 from a missing integration."""
    settings = get_settings()
    if not settings.anthropic_configured():
        return (
            "The assistant isn't configured. The Anthropic AI integration "
            "must be enabled for this app."
        )
    return None


def _client():
    """Create the Anthropic client lazily (mirrors services/quote_ai.py)."""
    import os

    from anthropic import Anthropic

    return Anthropic(
        api_key=os.environ.get("AI_INTEGRATIONS_ANTHROPIC_API_KEY"),
        base_url=os.environ.get("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"),
    )


def answer(system: str, history: list[dict], message: str) -> str:
    """Send the system prompt (with the org data snapshot baked in) plus the
    trailing chat history and the new user message to Claude, and return its
    reply text."""
    settings = get_settings()
    client = _client()
    trimmed = history[-MAX_HISTORY_MESSAGES:] if history else []
    messages = trimmed + [{"role": "user", "content": message}]
    response = client.messages.create(
        model=settings.quote_model,
        max_tokens=MAX_TOKENS,
        system=system,
        messages=messages,
    )
    parts = [b.text for b in response.content if getattr(b, "type", None) == "text"]
    reply = "\n".join(parts).strip()
    return reply or "I don't have a response for that — could you rephrase?"
