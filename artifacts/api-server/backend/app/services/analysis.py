"""Lead analysis from booth conversation transcripts.

Sends the transcript to an OpenAI chat model with JSON-mode output and
returns a structured lead profile: intent, products discussed, budget,
urgency, pain points, competitors mentioned, buying role, sentiment,
suggested next action, plus a 0-100 lead score and hot/warm/cold tag.
"""
from __future__ import annotations

import json
from typing import Any

from ..config import get_settings

SYSTEM_PROMPT = """You are a senior B2B sales analyst reviewing a transcript of a conversation that took place at a conference / expo booth between a booth representative and a visitor.

The transcript MAY be speaker-diarized. When you see "Speaker 0", "Speaker 1", etc. with timestamps, you must:
  1. Infer which speaker is the booth representative and which is the visitor — the booth rep usually opens the conversation, asks qualifying questions, and pitches; the visitor responds, states needs, and asks about pricing/features.
  2. Treat statements by the visitor as the source of truth for budget / urgency / pain points / buying role. Statements by the booth rep should NOT be attributed to the visitor.
  3. Note who said each key quote — prefix with "[visitor]" or "[rep]".

Your job is to extract a structured lead profile. You MUST respond with a single JSON object matching this schema exactly:

{
  "summary": "a SPECIFIC, action-oriented recap (3-5 sentences). Lead with who the visitor is (name / role / company when stated) and what they actually want and why; then state any concrete numbers that came up (budget, quantities, timeline), what was DECIDED or agreed, and the single most important next step. Every sentence must carry a concrete fact taken from the transcript — never generic filler like 'discussed their offerings and experiences'. If the transcript is thin, write a shorter factual summary rather than padding it.",
  "intent": "primary reason the visitor stopped at the booth",
  "products_discussed": ["product A", "product B"],
  "pain_points": ["pain point 1", "pain point 2"],
  "budget_range": "free-form, e.g. '10-25 lakh INR' or 'unknown'",
  "urgency": "immediate | within_3_months | this_year | exploratory | unknown",
  "timeline": "free-form timeline mentioned, or 'unknown'",
  "competitors_mentioned": ["competitor 1"],
  "buying_role": "decision_maker | influencer | end_user | researcher | unknown",
  "sentiment": "positive | neutral | negative | mixed",
  "key_quotes": ["[visitor] short verbatim quote that captures intent or objection"],
  "next_action": "concrete, single-sentence recommendation for the sales rep",
  "lead_score": 0-100 integer reflecting qualification strength,
  "lead_temperature": "hot | warm | cold",
  "visitor_speaker_label": "the speaker label you inferred to be the visitor, e.g. 'Speaker 1' — or 'unknown' if the transcript wasn't diarized",
  "speaker_names": {"Speaker 0": "Ahmed", "Speaker 1": "unknown"} /* Map every "Speaker N" label in the transcript to the actual person's name when it can be inferred from the conversation (self-introductions like "Hi, I'm Sarah" or someone being addressed by name like "Thanks, John"). Use 'unknown' for any speaker whose name is not clearly stated. NEVER guess — only set a name when the transcript explicitly contains it. */,
  "topic": "2-5 word topic label for this conversation, e.g. 'CRM software', 'Manufacturing supplier' — derived from the actual content",
  "discussion_topics": ["the 2-6 distinct subjects actually discussed during the conversation, each as a short 2-5 word label, e.g. 'Pricing tiers', 'Onboarding timeline', 'Competitor comparison vs Salesforce'. Order by how much air time each got. Derive only from what's in the transcript."],
  "decisions": ["concrete decisions or agreements actually reached in the conversation, e.g. 'Rep to send a quote for 50 units by Friday', 'Visitor will introduce us to their CFO' — empty array if nothing was agreed"],
  "action_items": ["concrete, atomic follow-up tasks for the rep — short imperative sentences, max 5"],
  "suggested_company": "the name of the visitor's company / employer if it's clearly stated in the transcript (e.g. 'I'm Priya from Acme Logistics' → 'Acme Logistics'), or an empty string if not mentioned. NEVER guess — only set when the transcript explicitly names the company. Use the cleanest form ('Acme Logistics', not 'acme logistics pvt ltd in mumbai').",
  "consent": {
    "consent_requested": true /* true if anyone (usually the rep) explicitly asked permission to record/process the conversation, e.g. "Is it okay if I record this?", "Do I have your permission to record?", "May I record this call?". false if no such request appears. */,
    "consent_confirmed": true /* true ONLY if, after a consent request, the other party affirmatively agreed ("Yes, that's fine", "Sure, go ahead"). false otherwise. */,
    "consent_declined": false /* true if the other party explicitly refused recording ("No, please don't record"). */,
    "recording_before_consent": false /* true if the conversation clearly shows recording/processing began or was assumed BEFORE any consent was requested. false if unknown or consent came first. */,
    "privacy_explained": false /* true if the purpose of recording or how the data will be used was explained (e.g. "for note-taking purposes", "to follow up with a quote"). */,
    "consent_status": "requested | confirmed | not_requested | declined — the single best overall classification. Use 'confirmed' when consent was requested AND agreed, 'declined' when refused, 'requested' when asked but no clear agreement, and 'not_requested' when no consent language appears."
  }
}

Guidelines:
- If the transcript is empty, garbled, or has no business signal, return all fields with 'unknown' / empty arrays and lead_score 0, lead_temperature 'cold'.
- Do NOT invent facts not present in the transcript. Prefer 'unknown' over guessing.
- The summary MUST be specific to THIS conversation — pull in the real names, roles, numbers, and outcomes that appear in the transcript. A vague or generic summary is a failure; a shorter but concrete summary is always better than padded filler.
- Populate "decisions" only with agreements actually made, and "action_items" with the rep's concrete follow-up tasks. Use empty arrays when there were none.
- lead_score rubric:
  * 80-100 (hot): explicit budget + timeline + decision authority + clear intent
  * 50-79 (warm): clear intent + some budget OR timeline signal
  * 20-49 (cold): general interest, no commitment signals
  * 0-19: no qualifying signal
- Quotes must be short (under 25 words) and accurate to the transcript.
- Keep lists deduplicated and concise (max 5 items each).
- For "consent": base it ONLY on what is in the transcript. If there is no consent-related language at all, set consent_requested/consent_confirmed/consent_declined/recording_before_consent/privacy_explained to false and consent_status to "not_requested". Never assume consent was given just because the conversation was recorded.
- Never include explanatory prose outside the JSON object.
"""


def _client() -> "OpenAI":
    from openai import OpenAI

    settings = get_settings()
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")
    return OpenAI(api_key=settings.openai_api_key)


def _empty_analysis() -> dict[str, Any]:
    return {
        "summary": "",
        "intent": "unknown",
        "products_discussed": [],
        "pain_points": [],
        "budget_range": "unknown",
        "urgency": "unknown",
        "timeline": "unknown",
        "competitors_mentioned": [],
        "buying_role": "unknown",
        "sentiment": "neutral",
        "key_quotes": [],
        "next_action": "Follow up to gather more information.",
        "lead_score": 0,
        "lead_temperature": "cold",
        "visitor_speaker_label": "unknown",
        "speaker_names": {},
        "topic": "",
        "discussion_topics": [],
        "action_items": [],
        "decisions": [],
        "suggested_company": "",
        "consent": {
            "consent_requested": False,
            "consent_confirmed": False,
            "consent_declined": False,
            "recording_before_consent": False,
            "privacy_explained": False,
            "consent_status": "not_requested",
        },
    }


def analyze_transcript(transcript: str, visitor_context: dict | None = None) -> dict[str, Any]:
    """Run GPT analysis on a transcript and return the structured profile."""
    if not transcript or not transcript.strip():
        return _empty_analysis()

    settings = get_settings()
    client = _client()

    user_payload = {
        "visitor": visitor_context or {},
        "transcript": transcript,
    }

    response = client.chat.completions.create(
        model=settings.analysis_model,
        response_format={"type": "json_object"},
        temperature=0.2,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
        ],
    )

    content = response.choices[0].message.content or "{}"
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return _empty_analysis()

    return _normalize(parsed)


def _normalize(raw: dict[str, Any]) -> dict[str, Any]:
    """Coerce GPT output into our expected shape so downstream code is safe."""
    base = _empty_analysis()
    for key in base:
        if key in raw and raw[key] is not None:
            base[key] = raw[key]

    # Clamp lead_score and re-derive temperature defensively.
    try:
        score = int(base["lead_score"])
    except (TypeError, ValueError):
        score = 0
    score = max(0, min(100, score))
    base["lead_score"] = score

    temp = str(base.get("lead_temperature", "")).lower()
    if temp not in {"hot", "warm", "cold"}:
        temp = "hot" if score >= 80 else "warm" if score >= 50 else "cold"
    base["lead_temperature"] = temp

    for list_key in ("products_discussed", "pain_points", "competitors_mentioned", "key_quotes", "action_items", "discussion_topics", "decisions"):
        value = base.get(list_key)
        if not isinstance(value, list):
            base[list_key] = []
        else:
            base[list_key] = [str(v) for v in value if v]

    # speaker_names should be a dict mapping "Speaker N" -> "Actual Name".
    # Filter out unknowns / blanks so downstream consumers can treat any
    # present entry as a confident detection.
    raw_names = base.get("speaker_names")
    cleaned: dict[str, str] = {}
    if isinstance(raw_names, dict):
        for k, v in raw_names.items():
            name = str(v or "").strip()
            if not name or name.lower() in {"unknown", "n/a", "none", "-"}:
                continue
            label = str(k or "").strip()
            if label:
                cleaned[label] = name
    base["speaker_names"] = cleaned

    # suggested_company: trim, drop "unknown"/blank so downstream code can
    # treat a present string as a confident detection.
    sc = str(base.get("suggested_company") or "").strip()
    if sc.lower() in {"", "unknown", "n/a", "none", "-"}:
        sc = ""
    base["suggested_company"] = sc[:200]

    base["consent"] = _normalize_consent(base.get("consent"))

    return base


def _normalize_consent(raw: Any) -> dict[str, Any]:
    """Coerce the consent block into a safe, fully-populated shape and derive
    a consistent consent_status from the boolean flags so downstream scoring
    never has to second-guess a half-filled GPT response."""
    out = {
        "consent_requested": False,
        "consent_confirmed": False,
        "consent_declined": False,
        "recording_before_consent": False,
        "privacy_explained": False,
        "consent_status": "not_requested",
    }
    if isinstance(raw, dict):
        for key in (
            "consent_requested",
            "consent_confirmed",
            "consent_declined",
            "recording_before_consent",
            "privacy_explained",
        ):
            out[key] = bool(raw.get(key))

    # A confirmation or a decline both imply a request was made.
    if out["consent_confirmed"] or out["consent_declined"]:
        out["consent_requested"] = True
    # A decline can't also be a confirmation.
    if out["consent_declined"]:
        out["consent_confirmed"] = False

    # Derive the canonical status from the flags rather than trusting the
    # model's free-text label, so the two can never disagree.
    if out["consent_declined"]:
        status = "declined"
    elif out["consent_confirmed"]:
        status = "confirmed"
    elif out["consent_requested"]:
        status = "requested"
    else:
        status = "not_requested"
    out["consent_status"] = status
    return out
