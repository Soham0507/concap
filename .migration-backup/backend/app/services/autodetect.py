"""AI auto-detection of visitor sessions inside a long booth recording.

Pipeline:
  1. Transcribe the whole recording with Deepgram (diarization + utterance
     timestamps). Whisper can't diarize, so Deepgram is mandatory here.
  2. Feed the speaker-labeled, timestamped transcript to GPT, which proposes
     a breakdown into discrete visitor conversations: company, rep vs
     visitor speakers, start/end seconds, topics, and a classification of
     each block as a real customer interaction vs internal staff-only talk.

The result is a *proposal* the user reviews and edits before any CRM
record is created — boundary detection in expo noise is imperfect, so a
human confirms. Confirming reuses the already-obtained diarized transcript
(no second STT pass, no ffmpeg) for speed and cost.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


from ..config import get_settings
from .segmentation_engine import detect_boundaries, render_boundary_hints
from .transcription import _transcribe_deepgram  # diarized provider


SYSTEM_PROMPT = """You are an expert at analyzing raw, full-day audio transcripts from a trade-show / expo booth.

The transcript is speaker-diarized: each line is "[mm:ss] Speaker N: text" with N a stable speaker id for the whole recording. A booth has one or more sales REPRESENTATIVES (they recur across the whole day, greet people, pitch, ask qualifying questions) and many VISITORS (appear briefly, ask about products, mention their company, then leave). Between visitors there is often internal staff chatter, silence, or crowd noise.

Your job: split the day into discrete VISITOR CONVERSATIONS. Respond with ONE JSON object:

{
  "rep_speakers": ["Speaker 0"],            // speaker ids you judge to be booth reps (recur all day)
  "sessions": [
    {
      "company": "best guess of the visitor's company, or 'Unknown'",
      "visitor_names": ["names if explicitly stated, else []"],
      "visitor_speakers": ["Speaker 1","Speaker 2"],
      "rep_speakers": ["Speaker 0"],
      "start_seconds": 12.0,
      "end_seconds": 315.0,
      "topics": ["ERP","AI dashboard"],
      "summary_hint": "one sentence on what they wanted",
      "classification": "customer",          // "customer" or "staff_only"
      "confidence": 0.0-1.0
    }
  ]
}

Rules:
- A new session starts on greeting/new-company patterns ("hi, we're from X", a new unknown speaker appearing) and ends on goodbye/scheduling phrases, a long gap, or staff-only talk resuming.
- Merge multiple visitors from the SAME company into ONE session (e.g. two Requisor people = one Requisor session).
- Mark blocks that are only reps/staff talking (no visitor) as classification "staff_only" — still list them so the user sees what was excluded, but they will not become CRM records.
- Never invent a company. Use "Unknown" when not stated.
- start_seconds/end_seconds must come from the bracketed timestamps and be within the transcript's range.
- Keep arrays deduplicated and concise. Output ONLY the JSON object.

COMPLETENESS IS CRITICAL. A single recording commonly contains MANY distinct conversations — often a dozen or more across a full day. You MUST enumerate EVERY distinct visitor conversation from start to finish of the transcript you are given. Do not stop early, do not summarize only the most prominent ones, and do not collapse different companies together. Cover the entire timeline: the last conversation in your output should end near the final timestamp in the transcript. If two adjacent blocks are clearly different visitors/companies, emit two sessions, not one.

The transcript you receive may be only ONE PART of a longer recording. Segment everything you can see within it; boundaries near the very start or very end may be partial — that is fine, still include them.

Before the transcript you'll see "BOUNDARY HINTS" — timestamps where independent signals (silence gaps, speaker-set turnover, topic-embedding shifts) suggest a conversation boundary. Treat them as STRONG candidates: most sessions should start at or very near a hint. You may still split or merge when the dialog clearly demands it, but ignore hints only with good reason.
"""


def _client() -> OpenAI:
    from openai import OpenAI

    s = get_settings()
    if not s.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")
    return OpenAI(api_key=s.openai_api_key)


def _fmt_ts(seconds: float) -> str:
    m = int(seconds // 60)
    sec = int(seconds % 60)
    return f"{m:02d}:{sec:02d}"


# Character budgets. The model's *context window* is not the bottleneck — gpt-4o
# fits ~128k tokens. The real failure is LLM "laziness": asked to enumerate a
# dozen meetings from a huge transcript in one shot, it covers the start then
# skips ahead and drops meetings in the middle/end. So we deliberately keep the
# per-call transcript SMALL (a handful of meetings each), chunk anything larger
# with time overlap, and merge — this dramatically improves meeting recall.
# Recordings under the single-pass limit go in one call; longer ones are chunked.
SINGLE_PASS_MAX_CHARS = 28_000
CHUNK_MAX_CHARS = 28_000
CHUNK_OVERLAP_SECONDS = 180.0

# Post-processing to fight OVER-segmentation. Chunking + a literal-minded model
# can split one real meeting into abutting pieces that don't time-overlap (so the
# overlap merge misses them) and can emit tiny slivers of crosstalk as their own
# "meeting". After merging overlaps we coalesce sessions that sit back-to-back
# AND look like the same meeting, then drop ultra-short leftover noise.
#
# Two distinct coalesce reasons, deliberately conservative so we never fuse two
# genuinely different back-to-back visitors:
#   * "continuation" — the SAME visitor/company keeps talking after a short gap
#     (same known company, or shared visitor speaker ids). Speakers ARE unioned.
#   * "sliver" — a tiny crosstalk fragment folds into a clearly-larger real
#     meeting beside it. Requires one side < SLIVER_MAX and the other side
#     >= SUBSTANTIAL_NEIGHBOR, so two comparable short blocks are never fused and
#     two long blocks are never fused by this rule. Sliver speakers are NOT
#     unioned, so a bridging fragment can't transitively link two real meetings.
ADJACENT_GAP_SECONDS = 35.0        # max silence between two pieces of one meeting
SLIVER_MAX_SECONDS = 40.0          # a piece this short can be a crosstalk fragment
SUBSTANTIAL_NEIGHBOR_SECONDS = 120.0  # the real meeting a sliver folds into
MIN_SESSION_SECONDS = 20.0         # drop only empty noise shorter than this


def _utt_line(u: dict) -> str:
    return f"[{_fmt_ts(u['start'])}] {u['speaker']}: {u['text']}"


def _render_lines(utterances: list[dict]) -> str:
    return "\n".join(_utt_line(u) for u in utterances)


def render_for_prompt(utterances: list[dict], max_chars: int = SINGLE_PASS_MAX_CHARS) -> str:
    """Compact, timestamped, speaker-labeled rendering. Only truncates as a last
    resort; long recordings are chunked upstream so this rarely trims anything."""
    text = _render_lines(utterances)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n...[transcript truncated for length]"
    return text


def _chunk_utterances(
    utterances: list[dict],
    max_chars: int = CHUNK_MAX_CHARS,
    overlap_seconds: float = CHUNK_OVERLAP_SECONDS,
) -> list[list[dict]]:
    """Split utterances into consecutive groups each rendering to <= max_chars,
    re-including the trailing `overlap_seconds` of the previous group so a
    conversation that straddles a seam appears whole in at least one chunk."""
    n = len(utterances)
    chunks: list[list[dict]] = []
    i = 0
    while i < n:
        cur: list[dict] = []
        size = 0
        j = i
        while j < n:
            line_len = len(_utt_line(utterances[j])) + 1
            if cur and size + line_len > max_chars:
                break
            cur.append(utterances[j])
            size += line_len
            j += 1
        chunks.append(cur)
        if j >= n:
            break
        # Start the next chunk a little before the seam to create time overlap.
        seam_time = float(utterances[j].get("start") or 0.0)
        back = j
        while back > i + 1 and float(utterances[back - 1].get("start") or 0.0) >= seam_time - overlap_seconds:
            back -= 1
        i = back if back > i else j
    return chunks


def _normalize_for_stt(audio_path: Path) -> tuple[Path, bool]:
    """Transcode to 16 kHz mono 16-bit PCM WAV so Deepgram accepts it
    regardless of the recorder's container/codec (ADPCM, 24-bit, GSM, etc.).

    Returns (path_to_use, is_temp). Falls back to the original file if
    ffmpeg is unavailable or the transcode fails — better to try the raw
    file than to hard-fail before we know Deepgram would reject it.
    """
    import shutil
    import subprocess
    import tempfile

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return audio_path, False

    tmp = Path(tempfile.gettempdir()) / f"stt_{audio_path.stem}_{abs(hash(str(audio_path)))}.wav"
    proc = subprocess.run(
        [
            ffmpeg, "-y", "-loglevel", "error",
            "-i", str(audio_path),
            "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
            str(tmp),
        ],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
        return tmp, True
    return audio_path, False


def transcribe_session(audio_path: Path) -> dict:
    """Diarized transcription of the whole recording. Deepgram-only.

    The audio is normalized to PCM WAV first (recorders frequently write
    ADPCM/proprietary WAV that neither browsers nor Deepgram can decode).
    """
    s = get_settings()
    if not s.deepgram_api_key:
        raise RuntimeError(
            "Auto-detection needs speaker diarization. Set DEEPGRAM_API_KEY in "
            "backend/.env and restart the server (Whisper cannot diarize)."
        )
    use_path, is_temp = _normalize_for_stt(audio_path)
    try:
        return _transcribe_deepgram(use_path)
    finally:
        if is_temp:
            use_path.unlink(missing_ok=True)


def _call_proposal_llm(client, model: str, transcript: str, hints_text: str) -> dict:
    """One GPT pass over a transcript (full or a single chunk)."""
    user_content = (
        "BOUNDARY HINTS (use these as strong candidate split points):\n"
        + hints_text
        + "\n\nDIARIZED TRANSCRIPT:\n"
        + transcript
    )
    resp = client.chat.completions.create(
        model=model,
        response_format={"type": "json_object"},
        temperature=0.1,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
    )
    try:
        return json.loads(resp.choices[0].message.content or "{}")
    except json.JSONDecodeError:
        return {}


def propose_sessions(utterances: list[dict]) -> dict[str, Any]:
    """GPT pass: diarized transcript -> proposed visitor-session breakdown.

    Short recordings go through a single GPT call. Long ones (a full booth day
    can run many hours and far exceed the model context) are split into
    overlapping chunks, proposed independently, then merged so meetings late in
    the day are never lost to truncation.
    """
    if not utterances:
        return {"rep_speakers": [], "sessions": []}

    settings = get_settings()
    client = _client()

    # Pre-compute candidate boundaries from silence + speaker-set turnover +
    # topic embeddings. GPT uses them as hints — accuracy on multi-hour audio
    # improves significantly because the model isn't guessing seams blind.
    hints = detect_boundaries(utterances)
    full_text = _render_lines(utterances)

    if len(full_text) <= SINGLE_PASS_MAX_CHARS:
        parsed = _call_proposal_llm(
            client, settings.analysis_model, full_text, render_boundary_hints(hints)
        )
        result = _normalize_proposal(parsed, utterances)
        result["sessions"] = _coalesce_adjacent(result["sessions"])
        return result

    # --- Long recording: chunk, propose per chunk, merge ------------------
    chunks = _chunk_utterances(utterances)
    rep_union: set[str] = set()
    all_sessions: list[dict] = []
    for chunk in chunks:
        if not chunk:
            continue
        c_start = float(chunk[0].get("start") or 0.0)
        c_end = float(chunk[-1].get("end") or chunk[-1].get("start") or 0.0)
        chunk_hints = [h for h in hints if c_start <= h.at_seconds <= c_end]
        parsed = _call_proposal_llm(
            client,
            settings.analysis_model,
            _render_lines(chunk),
            render_boundary_hints(chunk_hints),
        )
        # Normalize against the FULL transcript's range (timestamps are global).
        part = _normalize_proposal(parsed, utterances)
        rep_union.update(part["rep_speakers"])
        all_sessions.extend(part["sessions"])

    return {
        "rep_speakers": sorted(rep_union),
        "sessions": _coalesce_adjacent(_merge_overlapping_sessions(all_sessions)),
    }


def _dedup_keep_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in items:
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _overlap_ratio(a: dict, b: dict) -> float:
    """Intersection over the shorter session's duration (0..1)."""
    lo = max(a["start_seconds"], b["start_seconds"])
    hi = min(a["end_seconds"], b["end_seconds"])
    inter = hi - lo
    if inter <= 0:
        return 0.0
    da = a["end_seconds"] - a["start_seconds"]
    db = b["end_seconds"] - b["start_seconds"]
    return inter / max(1e-6, min(da, db))


def _absorb(into: dict, other: dict, merge_visitor_speakers: bool = True) -> None:
    """Fold a duplicate/continuation session into `into`.

    `merge_visitor_speakers=False` is used when absorbing a crosstalk *sliver*:
    a sliver's diarization is unreliable, and unioning its speaker ids would let
    it act as a bridge that transitively links two otherwise-distinct meetings on
    the next continuation check. We still take its time span and topics."""
    into["start_seconds"] = min(into["start_seconds"], other["start_seconds"])
    into["end_seconds"] = max(into["end_seconds"], other["end_seconds"])
    if into["company"] in ("", "Unknown") and other["company"] not in ("", "Unknown"):
        into["company"] = other["company"]
    into["visitor_names"] = _dedup_keep_order(into["visitor_names"] + other["visitor_names"])[:5]
    if merge_visitor_speakers:
        into["visitor_speakers"] = _dedup_keep_order(into["visitor_speakers"] + other["visitor_speakers"])
    into["rep_speakers"] = _dedup_keep_order(into["rep_speakers"] + other["rep_speakers"])
    into["topics"] = _dedup_keep_order(into["topics"] + other["topics"])[:8]
    if not into["summary_hint"]:
        into["summary_hint"] = other["summary_hint"]
    if other["classification"] == "customer":
        into["classification"] = "customer"
    into["confidence"] = max(into["confidence"], other["confidence"])


def _same_meeting(a: dict, b: dict) -> bool:
    """Whether two sessions are the same meeting seen in overlapping chunks.

    Requires a substantial time overlap AND semantic compatibility: two clearly
    different *known* companies are never merged even when their spans overlap at
    a chunk seam (guards against collapsing distinct back-to-back meetings). When
    either company is Unknown we fall back to the time overlap alone, which is
    what de-dups the same meeting that one chunk only saw a fragment of."""
    if _overlap_ratio(a, b) < 0.5:
        return False
    ca = a["company"].strip().lower()
    cb = b["company"].strip().lower()
    both_known = ca and cb and ca != "unknown" and cb != "unknown"
    if both_known and ca != cb:
        return False
    return True


def _merge_overlapping_sessions(sessions: list[dict]) -> list[dict]:
    """De-duplicate sessions proposed in overlapping chunk regions. Two sessions
    that cover substantially the same time span (and aren't two different known
    companies) are the same meeting."""
    if not sessions:
        return []
    ordered = sorted(sessions, key=lambda x: x["start_seconds"])
    merged: list[dict] = []
    for s in ordered:
        target = None
        for m in merged:
            if _same_meeting(s, m):
                target = m
                break
        if target is not None:
            _absorb(target, s)
        else:
            merged.append(dict(s))
    merged.sort(key=lambda x: x["start_seconds"])
    return merged


def _coalesce_reason(prev: dict, cur: dict) -> str | None:
    """Classify why two back-to-back sessions should fold into one — or None to
    keep them apart. Unlike `_same_meeting` (time OVERLAP), this targets pieces
    that *abut* (small gap, no overlap). Both must share a classification and be
    company-compatible, then exactly one of two conservative reasons can apply:

      "continuation" — same KNOWN company, or shared visitor-speaker ids: the
          same visitor/company kept talking after a brief gap.
      "sliver" — one side is a tiny fragment (< SLIVER_MAX) AND the other is a
          clearly-real meeting (>= SUBSTANTIAL_NEIGHBOR). This folds crosstalk
          noise into the real meeting beside it. The dual size requirement means
          two comparable short blocks are never fused, and two long blocks are
          never fused by this rule (only by "continuation")."""
    gap = cur["start_seconds"] - prev["end_seconds"]
    if gap > ADJACENT_GAP_SECONDS:
        return None
    if prev["classification"] != cur["classification"]:
        return None
    cp = prev["company"].strip().lower()
    cc = cur["company"].strip().lower()
    both_known = bool(cp and cc and cp != "unknown" and cc != "unknown")
    if both_known and cp != cc:
        return None
    shared_speakers = bool(set(prev["visitor_speakers"]) & set(cur["visitor_speakers"]))
    if (both_known and cp == cc) or shared_speakers:
        return "continuation"
    dur_prev = prev["end_seconds"] - prev["start_seconds"]
    dur_cur = cur["end_seconds"] - cur["start_seconds"]
    if min(dur_prev, dur_cur) < SLIVER_MAX_SECONDS and max(dur_prev, dur_cur) >= SUBSTANTIAL_NEIGHBOR_SECONDS:
        return "sliver"
    return None


def _coalesce_adjacent(sessions: list[dict]) -> list[dict]:
    """Second-pass cleanup after overlap de-dup: fold abutting pieces of the same
    meeting together, then drop ultra-short leftover blocks that carry no real
    content (no known company, no topics) — pure crosstalk noise. A short block
    that DID extract a company or topics is kept, since it may be a real brief
    interaction the user still wants enumerated."""
    if not sessions:
        return []
    ordered = sorted(sessions, key=lambda x: x["start_seconds"])
    out: list[dict] = [dict(ordered[0])]
    for s in ordered[1:]:
        reason = _coalesce_reason(out[-1], s)
        if reason == "continuation":
            _absorb(out[-1], s, merge_visitor_speakers=True)
        elif reason == "sliver":
            _absorb(out[-1], s, merge_visitor_speakers=False)
        else:
            out.append(dict(s))
    cleaned = [
        s for s in out
        if (s["end_seconds"] - s["start_seconds"]) >= MIN_SESSION_SECONDS
        or s["company"].strip().lower() not in ("", "unknown")
        or bool(s["topics"])
    ]
    cleaned.sort(key=lambda x: x["start_seconds"])
    return cleaned


def _normalize_proposal(raw: dict, utterances: list[dict]) -> dict[str, Any]:
    """Coerce GPT output into a safe, bounded shape so the UI/confirm code
    can trust it even if the model misbehaves."""
    max_t = max((float(u.get("end") or 0.0) for u in utterances), default=0.0)
    rep_speakers = [str(x) for x in (raw.get("rep_speakers") or []) if x]

    out_sessions = []
    for s in raw.get("sessions") or []:
        try:
            start = max(0.0, float(s.get("start_seconds", 0.0)))
            end = float(s.get("end_seconds", 0.0))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        end = min(end, max_t) if max_t else end
        if end <= start:
            continue
        classification = s.get("classification")
        if classification not in ("customer", "staff_only"):
            classification = "customer"
        try:
            confidence = max(0.0, min(1.0, float(s.get("confidence", 0.5))))
        except (TypeError, ValueError):
            confidence = 0.5

        out_sessions.append({
            "company": str(s.get("company") or "Unknown").strip() or "Unknown",
            "visitor_names": [str(n) for n in (s.get("visitor_names") or []) if n][:5],
            "visitor_speakers": [str(x) for x in (s.get("visitor_speakers") or []) if x],
            "rep_speakers": [str(x) for x in (s.get("rep_speakers") or rep_speakers) if x],
            "start_seconds": round(start, 2),
            "end_seconds": round(end, 2),
            "topics": [str(t) for t in (s.get("topics") or []) if t][:8],
            "summary_hint": str(s.get("summary_hint") or "").strip(),
            "classification": classification,
            "confidence": round(confidence, 2),
        })

    out_sessions.sort(key=lambda x: x["start_seconds"])
    return {"rep_speakers": rep_speakers, "sessions": out_sessions}


def slice_utterances(utterances: list[dict], start: float, end: float) -> list[dict]:
    """Utterances overlapping [start, end], for reusing the transcript on
    confirm instead of re-running STT."""
    out = []
    for u in utterances:
        us, ue = float(u.get("start") or 0.0), float(u.get("end") or 0.0)
        if ue >= start and us <= end:
            out.append(u)
    return out


def render_segment_transcript(
    utterances: list[dict], rep_speakers: list[str] | None = None
) -> str:
    """Speaker-labeled text for a single confirmed session, tagging known
    rep speakers so the GPT lead analysis attributes statements correctly."""
    reps = set(rep_speakers or [])
    lines = []
    for u in utterances:
        spk = u["speaker"]
        role = " (rep)" if spk in reps else ""
        lines.append(f"[{_fmt_ts(u['start'])}] {spk}{role}: {u['text']}")
    return "\n".join(lines)
