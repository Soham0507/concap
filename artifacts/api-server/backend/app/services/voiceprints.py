"""Cross-meeting speaker recognition.

Ported from the source app's ``voiceprints.ts`` into pure Python. Each
speaker's utterances are turned into a fixed-dimension, L2-normalized
"voiceprint" vector that can be matched against a per-org registry of
previously-confirmed speakers. The extractor is a lexical/style fingerprint
(unigram + bigram hashing + function-word frequency) — it captures consistent
vocabulary and speech patterns with no extra dependencies. The vector format is
intentionally generic so a real audio embedding (Pyannote / Resemble /
AssemblyAI speaker id) can be swapped in later without changing storage,
matching, or the UI.
"""

from __future__ import annotations

import math
import re

VOICEPRINT_DIM = 128
MATCH_THRESHOLD = 0.72
MIN_SAMPLE_CHARS = 40

FUNCTION_WORDS = [
    "i", "you", "we", "they", "he", "she", "it",
    "uh", "um", "like", "actually", "basically", "literally",
    "right", "okay", "ok", "so", "well", "kind", "sort", "really",
    "definitely", "honestly", "obviously", "totally", "anyway",
    "yeah", "yep", "nope", "guys", "folks", "team",
]

_NON_WORD = re.compile(r"[^a-z0-9'\s]")
_WHITESPACE = re.compile(r"\s+")

_MASK32 = 0xFFFFFFFF


def _fnv1a(s: str) -> int:
    h = 2166136261
    for ch in s:
        h ^= ord(ch) & 0xFF
        h = (h * 16777619) & _MASK32
    return h


def _l2normalize(v: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in v))
    if norm == 0:
        return v
    return [x / norm for x in v]


def extract_text_embedding(text: str) -> list[float]:
    v = [0.0] * VOICEPRINT_DIM
    if not text:
        return v
    normalized = _NON_WORD.sub(" ", text.lower())
    words = [w for w in _WHITESPACE.split(normalized) if len(w) >= 2]
    if not words:
        return v

    for w in words:
        v[_fnv1a(w) % VOICEPRINT_DIM] += 1
    for i in range(len(words) - 1):
        v[_fnv1a(words[i] + "_" + words[i + 1]) % VOICEPRINT_DIM] += 0.5
    for fw in FUNCTION_WORDS:
        c = sum(1 for w in words if w == fw)
        if c > 0:
            v[_fnv1a("fw_" + fw) % VOICEPRINT_DIM] += c * 1.5
    avg_len = sum(len(w) for w in words) / len(words)
    v[_fnv1a("avglen") % VOICEPRINT_DIM] += avg_len

    return _l2normalize(v)


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    return sum(x * y for x, y in zip(a, b))


def merge_embeddings(existing: list[float], existing_sample_count: int, addition: list[float]) -> list[float]:
    """Incrementally merge a new sample into an existing centroid. Both vectors
    should already be L2-normalized and the same length."""
    if not existing or len(existing) != len(addition):
        return addition
    total = max(1, existing_sample_count) + 1
    merged = [
        (existing[i] * existing_sample_count + addition[i]) / total
        for i in range(len(existing))
    ]
    return _l2normalize(merged)


def summarize_speakers(utterances: list[dict]) -> list[dict]:
    """Collapse per-utterance rows into one record per anonymous speaker label,
    computing the speaker-level embedding and total talk-time. Returns
    ``[{speaker, text, embedding, talk_time_ms, utterance_count}]``."""
    grouped: dict[str, dict] = {}
    for u in utterances:
        speaker = (u or {}).get("speaker")
        if not speaker:
            continue
        g = grouped.setdefault(speaker, {"texts": [], "talk_ms": 0, "count": 0})
        g["texts"].append(u.get("text") or "")
        start = u.get("start") or 0
        end = u.get("end") or 0
        g["talk_ms"] += max(0, end - start)
        g["count"] += 1

    out: list[dict] = []
    for speaker, g in grouped.items():
        text = " ".join(g["texts"]).strip()
        out.append({
            "speaker": speaker,
            "text": text,
            "embedding": extract_text_embedding(text),
            "talk_time_ms": g["talk_ms"],
            "utterance_count": g["count"],
        })
    return out


def match_speakers_to_registry(
    samples: list[dict],
    registry: list[dict],
    threshold: float = MATCH_THRESHOLD,
) -> dict[str, dict]:
    """For each anonymous speaker label, find the best match (if any) against the
    org's voiceprint registry. ``registry`` items are ``{id, canonical_name,
    embedding}``. Returns ``{speaker: {name, confidence, voiceprint_id,
    similarity}}``. Speakers with too little dialog are skipped."""
    out: dict[str, dict] = {}
    if not registry:
        return out
    for s in samples:
        if len(s.get("text") or "") < MIN_SAMPLE_CHARS:
            continue
        embedding = s.get("embedding") or []
        best = None
        for vp in registry:
            sim = cosine_similarity(embedding, vp.get("embedding") or [])
            if best is None or sim > best[1]:
                best = (vp, sim)
        if best and best[1] >= threshold:
            vp, sim = best
            confidence = min(0.99, 0.6 + ((sim - threshold) / (1 - threshold)) * 0.39)
            out[s["speaker"]] = {
                "name": vp.get("canonical_name"),
                "confidence": confidence,
                "voiceprint_id": vp.get("id"),
                "similarity": sim,
            }
    return out


def speaker_talk_time_ms(utterances: list[dict]) -> dict[str, int]:
    out: dict[str, int] = {}
    for u in utterances:
        speaker = (u or {}).get("speaker")
        if not speaker:
            continue
        start = u.get("start") or 0
        end = u.get("end") or 0
        out[speaker] = out.get(speaker, 0) + max(0, end - start)
    return out
