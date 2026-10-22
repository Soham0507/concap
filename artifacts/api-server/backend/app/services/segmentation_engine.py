"""Multi-signal conversation segmentation.

A long booth recording is not a single conversation — visitors come and go,
topics shift, and there are silent gaps. Before asking GPT to label sessions
we compute *candidate boundaries* from three independent signals and pass
them as hints. This lets GPT focus on naming and merging instead of
guessing where the seams are, which dramatically improves accuracy on
multi-hour audio.

Signals (per the product spec):

1. **Silence gaps** — any inter-utterance gap longer than `SILENCE_GAP_S`
   (15s by default) is a strong boundary candidate.
2. **Speaker-set change** — comparing the set of speakers active in two
   adjacent rolling windows. When the visitor speakers turn over while the
   rep stays the same, a new visitor likely arrived.
3. **Topic-similarity drop** — embedding the text of consecutive windows
   and flagging cosine-similarity drops below `TOPIC_SIM_THRESHOLD`.

The output is a list of float seconds (sorted, deduped) suitable for
prepending to the GPT prompt as "candidate split points".
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .embeddings import cosine, embed_many

logger = logging.getLogger("booth.segmentation")

# Tunables — chosen for booth/expo audio. They're deliberately conservative;
# GPT still gets the final say on which candidates become real boundaries.
SILENCE_GAP_S = 15.0
WINDOW_S = 45.0           # rolling window for speaker-set + topic embeddings
SPEAKER_OVERLAP_MIN = 0.34  # below this Jaccard overlap = boundary
TOPIC_SIM_THRESHOLD = 0.72  # below this cosine = topic shift
MERGE_WITHIN_S = 8.0      # collapse boundaries closer than this


@dataclass
class BoundaryHint:
    at_seconds: float
    reason: str   # "silence" | "speakers" | "topic"
    score: float  # 0..1, higher = more confident this is a real boundary


def _silence_boundaries(utterances: list[dict]) -> list[BoundaryHint]:
    out: list[BoundaryHint] = []
    for prev, nxt in zip(utterances, utterances[1:]):
        gap = float(nxt.get("start") or 0.0) - float(prev.get("end") or 0.0)
        if gap >= SILENCE_GAP_S:
            # The boundary sits in the middle of the silence.
            mid = float(prev.get("end") or 0.0) + gap / 2.0
            # Saturate: a 60s gap is barely more telling than a 30s gap.
            score = min(1.0, gap / 60.0)
            out.append(BoundaryHint(at_seconds=mid, reason="silence", score=score))
    return out


def _windows(utterances: list[dict], window_s: float) -> list[dict]:
    """Group utterances into fixed-length time windows. Each window holds
    {start, end, speakers (set), text (joined)}."""
    if not utterances:
        return []
    t0 = float(utterances[0].get("start") or 0.0)
    t_end = max(float(u.get("end") or 0.0) for u in utterances)
    windows: list[dict] = []
    cur_start = t0
    while cur_start < t_end:
        cur_end = cur_start + window_s
        bucket = [u for u in utterances
                  if float(u.get("end") or 0.0) > cur_start
                  and float(u.get("start") or 0.0) < cur_end]
        if bucket:
            windows.append({
                "start": cur_start,
                "end": cur_end,
                "speakers": {str(u.get("speaker") or "") for u in bucket if u.get("speaker")},
                "text": " ".join((u.get("text") or "").strip() for u in bucket),
            })
        cur_start = cur_end
    return windows


def _jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _speaker_boundaries(windows: list[dict]) -> list[BoundaryHint]:
    out: list[BoundaryHint] = []
    for prev, nxt in zip(windows, windows[1:]):
        overlap = _jaccard(prev["speakers"], nxt["speakers"])
        if overlap < SPEAKER_OVERLAP_MIN:
            out.append(BoundaryHint(
                at_seconds=float(nxt["start"]),
                reason="speakers",
                score=1.0 - overlap,
            ))
    return out


def _topic_boundaries(windows: list[dict]) -> list[BoundaryHint]:
    """Embed each window's text once, then look for cosine-similarity drops
    between adjacent windows. Embedding errors degrade gracefully — if the
    API is unreachable we just return an empty list and let the other
    signals carry the segmentation.
    """
    if len(windows) < 2:
        return []
    try:
        vectors = embed_many([w["text"] for w in windows])
    except Exception as exc:  # noqa: BLE001
        logger.warning("Topic-embedding pass failed, skipping topic signal: %s", exc)
        return []
    out: list[BoundaryHint] = []
    for i in range(1, len(windows)):
        sim = cosine(vectors[i - 1], vectors[i])
        if sim and sim < TOPIC_SIM_THRESHOLD:
            out.append(BoundaryHint(
                at_seconds=float(windows[i]["start"]),
                reason="topic",
                score=min(1.0, TOPIC_SIM_THRESHOLD - sim + 0.2),
            ))
    return out


def _merge_nearby(hints: list[BoundaryHint]) -> list[BoundaryHint]:
    """Collapse hints within MERGE_WITHIN_S of each other into one entry,
    summing scores and combining reasons. Two signals agreeing on the same
    boundary is far more informative than either alone.
    """
    if not hints:
        return []
    hints = sorted(hints, key=lambda h: h.at_seconds)
    merged: list[BoundaryHint] = [hints[0]]
    for h in hints[1:]:
        last = merged[-1]
        if h.at_seconds - last.at_seconds <= MERGE_WITHIN_S:
            reasons = sorted(set(last.reason.split("+") + [h.reason]))
            merged[-1] = BoundaryHint(
                at_seconds=(last.at_seconds + h.at_seconds) / 2.0,
                reason="+".join(reasons),
                score=min(1.0, last.score + h.score * 0.6),
            )
        else:
            merged.append(h)
    return merged


def detect_boundaries(utterances: list[dict]) -> list[BoundaryHint]:
    """Run all signals and return merged candidate boundaries, sorted by time.

    Designed to be called once per session — embedding is the only paid step
    and it's a single batched API request even for hours of audio.
    """
    if not utterances:
        return []
    sil = _silence_boundaries(utterances)
    wins = _windows(utterances, WINDOW_S)
    spk = _speaker_boundaries(wins)
    top = _topic_boundaries(wins)
    return _merge_nearby(sil + spk + top)


def render_boundary_hints(hints: list[BoundaryHint]) -> str:
    """Compact, GPT-friendly description of the boundary candidates."""
    if not hints:
        return "(no automated boundary candidates detected)"
    lines = []
    for h in hints:
        m = int(h.at_seconds // 60)
        s = int(h.at_seconds % 60)
        lines.append(f"  - [{m:02d}:{s:02d}] reason={h.reason} confidence={h.score:.2f}")
    return "\n".join(lines)
