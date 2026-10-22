"""Enterprise Meeting Intelligence service.

Drives the `/api/meetings/intelligence/*` routes. One transcript -> one
processed document with both a structured JSON extraction (with evidence
quotes) and a deterministically-rendered Minutes-of-Meeting (MOM) markdown.

Pipeline:
  1. (audio docs only) speech-to-text the uploaded file.
  2. If the transcript is long, split into overlapping chunks.
  3. For each chunk, ask the model for a partial extraction (JSON mode).
  4. Merge partial extractions into one document (dedupe action items,
     union lists, keep evidence-quote index alignment).
  5. Render the MOM markdown deterministically from the merged JSON (NOT an
     LLM call — keeps formatting stable across runs).
  6. Persist to `meeting_intelligence_documents`.

Failure semantics: the row is always written. On model failure the row is
stored with status="failed" and error_message populated so the UI can
surface it and the operator can retry.
"""
from __future__ import annotations

import json
import secrets
import time
from pathlib import Path
from typing import Any


from ..config import get_settings

# Approx 30k chars ~= 7.5k tokens — well within gpt-4o's 128k context.
MAX_INLINE_CHARS = 30_000
CHUNK_SIZE = 24_000
CHUNK_OVERLAP = 1_500
MAX_ATTEMPTS = 3

SYSTEM_PROMPT = """You are an Enterprise Meeting Intelligence AI Agent.

You process meeting transcripts from Zoom, Microsoft Teams, Google Meet,
Slack, Discord, email, recordings, and PDF/DOCX/TXT exports.

OBJECTIVES
- Understand meeting context
- Detect project / business domain
- Extract decisions, action items, blockers, risks
- Normalise inconsistent conversation formats
- Handle noisy, incomplete, multi-speaker transcripts
- NEVER hallucinate

PROCESSING RULES
1. Clean the transcript: remove filler words, duplicate statements, system
   noise. Normalise sentence structure.
2. Preserve technical terminology, business decisions, customer names,
   dates, commitments, ownership.
3. Do NOT hallucinate. If a value is missing, mark it:
     - Owner missing  -> "Pending"
     - Deadline missing -> "Pending"
     - Unclear statement -> "Needs Clarification"
4. Detect: meeting title, meeting type, executive summary, key discussion
   points, decisions taken, risks, action items (task / owner / deadline /
   status), pending clarifications, escalations, dependencies, follow-ups.

OUTPUT FORMAT (STRICT)
Return ONLY a single JSON object that matches this shape exactly. No prose,
no markdown fences, no commentary.

{
  "meeting_title": "",
  "project_name": "",
  "meeting_type": "",
  "meeting_date": "",
  "participants": [],
  "executive_summary": "",
  "discussion_points": [],
  "decisions_taken": [],
  "action_items": [
    { "task": "", "owner": "", "deadline": "", "status": "Open", "source_quote": "" }
  ],
  "risks": [],
  "pending_clarifications": [],
  "next_steps": [],
  "evidence_quotes": {
    "discussion_points": [],
    "decisions_taken": [],
    "risks": [],
    "pending_clarifications": [],
    "next_steps": []
  },
  "confidence_score": 0.00
}

EVIDENCE QUOTES (REQUIRED for traceability)
For every list-style field below, you MUST also populate the parallel array in "evidence_quotes" with the verbatim transcript line that produced each entry. The arrays MUST be the same length and aligned by index:
  - discussion_points       <-> evidence_quotes.discussion_points
  - decisions_taken         <-> evidence_quotes.decisions_taken
  - risks                   <-> evidence_quotes.risks
  - pending_clarifications  <-> evidence_quotes.pending_clarifications
  - next_steps              <-> evidence_quotes.next_steps
For each action_item, populate its own "source_quote" field with the verbatim line that produced it.

Rules for evidence quotes:
  - Each quote MUST appear verbatim in the input transcript — copy the exact text, including punctuation. Do NOT paraphrase.
  - If you cannot find a single verbatim line that supports an entry (e.g. the entry summarises across multiple lines), set the corresponding evidence_quotes entry to an empty string "". Never invent a quote.
  - Keep the arrays the same length as the parent list — pad with "" where needed.
  - Speaker tags ("Naveen:") may be included or excluded; both are acceptable as long as the body text appears verbatim in the source.
DO NOT skip evidence_quotes — downstream UI uses them to link each extracted item back to the source transcript.

ENTERPRISE REQUIREMENTS
- Professional business language
- Consistent formatting
- ERP / CRM / Manufacturing terminology where appropriate
- Output must be machine-parseable JSON (no trailing commas, no comments)
- confidence_score is a float 0.0-1.0 reflecting your certainty in the
  extraction; lower it when the transcript is noisy or incomplete."""

CHUNK_INSTRUCTION = (
    "This is one CHUNK of a longer transcript. Extract only what is present in "
    "this chunk. Other chunks will be merged with yours later. Use the same JSON "
    "shape. Set confidence_score for this chunk only."
)

LIST_FIELDS = (
    "discussion_points",
    "decisions_taken",
    "risks",
    "pending_clarifications",
    "next_steps",
)


# --- key preflight --------------------------------------------------------

def describe_openai_key_problem() -> str | None:
    """Return a human-readable reason the OpenAI key is unusable, or None.

    Lets the routes fail fast with an actionable 400 instead of writing N
    queued rows the worker can only fail with a cryptic 401.
    """
    key = (get_settings().openai_api_key or "").strip()
    if not key:
        return (
            "OPENAI_API_KEY is not configured. Add a valid OpenAI key and "
            "restart the server."
        )
    if key.lower().startswith("sk-placeholder") or "replace-with-real-key" in key.lower():
        return (
            "OPENAI_API_KEY is still a placeholder value. Replace it with a "
            "real key from https://platform.openai.com/api-keys."
        )
    return None


def _client() -> OpenAI:
    from openai import OpenAI

    settings = get_settings()
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")
    return OpenAI(api_key=settings.openai_api_key)


def generate_transcript_id() -> str:
    """Stable, opaque, human-referenceable transcript id."""
    ts = format(int(time.time()), "X")
    rand = secrets.token_hex(3).upper()
    return f"TRX-{ts}-{rand}"


# --- chunking + extraction ------------------------------------------------

def chunk_transcript(text: str) -> list[str]:
    if len(text) <= MAX_INLINE_CHARS:
        return [text]
    chunks: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        end = min(i + CHUNK_SIZE, n)
        chunks.append(text[i:end])
        if end >= n:
            break
        i = end - CHUNK_OVERLAP
    return chunks


def _pick_strings(v: Any) -> tuple[list[str], list[int]]:
    """Keep only non-blank strings, returning the kept values + their original
    indices so the parallel evidence-quote array can be pared to match."""
    if not isinstance(v, list):
        return [], []
    values: list[str] = []
    kept: list[int] = []
    for i, x in enumerate(v):
        if isinstance(x, str) and x.strip():
            values.append(x)
            kept.append(i)
    return values, kept


def _align_quotes(quotes: Any, kept_indices: list[int]) -> list[str]:
    if not isinstance(quotes, list):
        return ["" for _ in kept_indices]
    out: list[str] = []
    for i in kept_indices:
        q = quotes[i] if 0 <= i < len(quotes) else None
        out.append(str(q) if isinstance(q, str) else "")
    return out


def normalise_extraction(raw: dict, metadata: dict) -> dict:
    """Coerce model output into our expected shape so downstream code is safe."""
    if not isinstance(raw, dict):
        raw = {}

    kept: dict[str, tuple[list[str], list[int]]] = {
        f: _pick_strings(raw.get(f)) for f in LIST_FIELDS
    }
    raw_quotes = raw.get("evidence_quotes") or {}
    evidence_quotes = {
        f: _align_quotes(raw_quotes.get(f), kept[f][1]) for f in LIST_FIELDS
    }

    action_items: list[dict] = []
    if isinstance(raw.get("action_items"), list):
        for a in raw["action_items"]:
            if not isinstance(a, dict):
                continue
            action_items.append({
                "task": (str(a.get("task") or "").strip() or "Needs Clarification"),
                "owner": (str(a.get("owner") or "").strip() or "Pending"),
                "deadline": (str(a.get("deadline") or "").strip() or "Pending"),
                "status": (str(a.get("status") or "Open").strip() or "Open"),
                "source_quote": a["source_quote"] if isinstance(a.get("source_quote"), str) else "",
            })

    try:
        confidence = float(raw.get("confidence_score"))
    except (TypeError, ValueError):
        confidence = 0.5
    if not (0.0 <= confidence <= 1.0):
        confidence = 0.5

    participants_vals = _pick_strings(raw.get("participants"))[0]
    return {
        "meeting_title": (str(raw.get("meeting_title") or "").strip() or "Untitled Meeting"),
        "project_name": (str(raw.get("project_name") or metadata.get("project_name") or "").strip() or "Unspecified"),
        "meeting_type": (str(raw.get("meeting_type") or "").strip() or "General"),
        "meeting_date": (str(raw.get("meeting_date") or metadata.get("meeting_date") or "").strip() or "Pending"),
        "participants": participants_vals or (metadata.get("participants") or []),
        "executive_summary": str(raw.get("executive_summary") or "").strip(),
        "discussion_points": kept["discussion_points"][0],
        "decisions_taken": kept["decisions_taken"][0],
        "action_items": action_items,
        "risks": kept["risks"][0],
        "pending_clarifications": kept["pending_clarifications"][0],
        "next_steps": kept["next_steps"][0],
        "evidence_quotes": evidence_quotes,
        "confidence_score": confidence,
    }


def extract_from_text(text: str, metadata: dict, is_chunk: bool) -> dict:
    """Call the model on a single transcript (or chunk). Returns
    {extraction, usage}. Raises on non-JSON output."""
    settings = get_settings()
    client = _client()

    user_block = "\n".join(filter(None, [
        CHUNK_INSTRUCTION if is_chunk else "",
        "Metadata (caller-supplied — use as ground truth where provided):",
        json.dumps({
            "project_name": metadata.get("project_name"),
            "department": metadata.get("department"),
            "meeting_source": metadata.get("meeting_source"),
            "meeting_date": metadata.get("meeting_date"),
            "participants": metadata.get("participants") or [],
        }, ensure_ascii=False, indent=2),
        "",
        "Transcript:",
        "```",
        text,
        "```",
    ]))

    completion = client.chat.completions.create(
        model=settings.analysis_model,
        response_format={"type": "json_object"},
        temperature=0.2,
        max_tokens=4000,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_block},
        ],
    )

    raw_content = completion.choices[0].message.content or "{}"
    try:
        parsed = json.loads(raw_content)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Model returned non-JSON output") from exc

    usage = getattr(completion, "usage", None)
    usage_dict = {
        "input": getattr(usage, "prompt_tokens", 0) or 0,
        "output": getattr(usage, "completion_tokens", 0) or 0,
        "total": getattr(usage, "total_tokens", 0) or 0,
    }
    return {"extraction": normalise_extraction(parsed, metadata), "usage": usage_dict}


# --- merge ----------------------------------------------------------------

def _dedupe_strings(xs: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in xs:
        k = x.lower().strip()
        if k and k not in seen:
            seen.add(k)
            out.append(x)
    return out


def _dedupe_with_quotes(chunk_lists: list[list[str]], chunk_quotes: list[list[str]]):
    seen: set[str] = set()
    items: list[str] = []
    quotes: list[str] = []
    for i, lst in enumerate(chunk_lists):
        q = chunk_quotes[i] if i < len(chunk_quotes) else []
        for j, x in enumerate(lst):
            k = (x or "").lower().strip()
            if k and k not in seen:
                seen.add(k)
                items.append(x)
                quotes.append(q[j] if j < len(q) and isinstance(q[j], str) else "")
    return items, quotes


def _dedupe_actions(xs: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for a in xs:
        k = f"{str(a.get('task','')).lower().strip()}|{str(a.get('owner','')).lower().strip()}"
        if k and k not in seen:
            seen.add(k)
            out.append(a)
    return out


def merge_extractions(parts: list[dict], metadata: dict) -> dict:
    if len(parts) == 1:
        return parts[0]

    best_summary = ""
    for p in parts:
        s = p.get("executive_summary") or ""
        if len(s) > len(best_summary):
            best_summary = s

    avg_conf = sum(p.get("confidence_score", 0.5) for p in parts) / len(parts)

    merged_lists: dict[str, tuple[list[str], list[str]]] = {}
    for field in LIST_FIELDS:
        merged_lists[field] = _dedupe_with_quotes(
            [p.get(field, []) for p in parts],
            [(p.get("evidence_quotes") or {}).get(field, []) for p in parts],
        )

    def _first_non_default(field: str, default: str) -> str:
        for p in parts:
            v = p.get(field)
            if v and v != default:
                return v
        return parts[0].get(field, default)

    return {
        "meeting_title": _first_non_default("meeting_title", "Untitled Meeting"),
        "project_name": metadata.get("project_name") or parts[0].get("project_name") or "Unspecified",
        "meeting_type": _first_non_default("meeting_type", "General"),
        "meeting_date": metadata.get("meeting_date") or _first_non_default("meeting_date", "Pending"),
        "participants": _dedupe_strings([x for p in parts for x in (p.get("participants") or [])]),
        "executive_summary": best_summary,
        "discussion_points": merged_lists["discussion_points"][0],
        "decisions_taken": merged_lists["decisions_taken"][0],
        "action_items": _dedupe_actions([a for p in parts for a in (p.get("action_items") or [])]),
        "risks": merged_lists["risks"][0],
        "pending_clarifications": merged_lists["pending_clarifications"][0],
        "next_steps": merged_lists["next_steps"][0],
        "evidence_quotes": {f: merged_lists[f][1] for f in LIST_FIELDS},
        "confidence_score": round(avg_conf, 2),
    }


# --- markdown render ------------------------------------------------------

def render_markdown(doc: dict) -> str:
    lines: list[str] = []

    def bullet_with_quote(items: list[str], quotes: list[str] | None):
        if not items:
            lines.append("_None._")
            return
        for i, it in enumerate(items):
            lines.append(f"- {it}")
            q = quotes[i] if quotes and i < len(quotes) else ""
            if q and q.strip():
                lines.append(f'  > *Source: "{q.replace(chr(10), " ").strip()}"*')

    eq = doc.get("evidence_quotes") or {}
    participants = doc.get("participants") or []

    lines.append("# Minutes of Meeting (MOM)")
    lines.append("")
    lines.append(f"**Meeting Title:** {doc.get('meeting_title', 'Untitled Meeting')}")
    lines.append(f"**Project:** {doc.get('project_name', 'Unspecified')}")
    lines.append(f"**Meeting Type:** {doc.get('meeting_type', 'General')}")
    lines.append(f"**Date:** {doc.get('meeting_date', 'Pending')}")
    lines.append(f"**Participants:** {', '.join(participants) if participants else 'Pending'}")
    lines.append("")
    lines.append("## Executive Summary")
    lines.append(doc.get("executive_summary") or "_No summary extracted._")
    lines.append("")
    lines.append("## Key Discussion Points")
    bullet_with_quote(doc.get("discussion_points", []), eq.get("discussion_points"))
    lines.append("")
    lines.append("## Decisions Taken")
    bullet_with_quote(doc.get("decisions_taken", []), eq.get("decisions_taken"))
    lines.append("")
    lines.append("## Action Items")
    actions = doc.get("action_items") or []
    if actions:
        lines.append("| Task | Owner | Deadline | Status |")
        lines.append("|------|-------|----------|--------|")
        for a in actions:
            task = str(a.get("task", "")).replace("|", "\\|")
            lines.append(f"| {task} | {a.get('owner','Pending')} | {a.get('deadline','Pending')} | {a.get('status','Open')} |")
        cited = [a for a in actions if a.get("source_quote")]
        if cited:
            lines.append("")
            lines.append("*Sources for the above actions:*")
            for c in cited:
                q = str(c.get("source_quote", "")).replace(chr(10), " ").strip()
                lines.append(f'- **{c.get("task","")}:** *"{q}"*')
    else:
        lines.append("_None._")
    lines.append("")
    lines.append("## Risks")
    bullet_with_quote(doc.get("risks", []), eq.get("risks"))
    lines.append("")
    lines.append("## Pending Clarifications")
    bullet_with_quote(doc.get("pending_clarifications", []), eq.get("pending_clarifications"))
    lines.append("")
    lines.append("## Next Steps")
    bullet_with_quote(doc.get("next_steps", []), eq.get("next_steps"))
    lines.append("")
    conf = doc.get("confidence_score", 0.5)
    lines.append(f"---\n\n_Confidence: {round(conf * 100)}%_")
    return "\n".join(lines)


# --- end-to-end extraction for one row -----------------------------------

def extract_document(transcript_text: str, metadata: dict) -> dict:
    """Run the full chunk -> extract -> merge -> render pipeline on a
    transcript. Returns a dict with document_json, document_markdown,
    confidence_score, chunk_count, token_usage, meeting_title. Raises on
    a hard model failure (caller stores status=failed)."""
    chunks = chunk_transcript(transcript_text)
    partials: list[dict] = []
    total_usage = {"input": 0, "output": 0, "total": 0}
    for chunk in chunks:
        result = extract_from_text(chunk, metadata, is_chunk=len(chunks) > 1)
        partials.append(result["extraction"])
        for k in total_usage:
            total_usage[k] += result["usage"].get(k, 0)

    merged = merge_extractions(partials, metadata)
    markdown = render_markdown(merged)
    return {
        "document_json": merged,
        "document_markdown": markdown,
        "confidence_score": merged.get("confidence_score", 0.5),
        "chunk_count": len(chunks),
        "token_usage": total_usage,
        "meeting_title": merged.get("meeting_title", "Untitled Meeting"),
    }
