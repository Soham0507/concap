"""Tests for the cross-meeting speaker recognition (voiceprints) service.

The extractor is a deterministic lexical fingerprint (no network/embeddings),
so these run fully offline. They assert vector shape/normalization, self-match
behavior, registry matching, incremental merging, and per-speaker summaries.
"""
from __future__ import annotations

import math

from app.services import voiceprints as vp


def _norm(v):
    return math.sqrt(sum(x * x for x in v))


def test_embedding_shape_and_normalization():
    v = vp.extract_text_embedding("the quick brown fox jumps over the lazy dog repeatedly")
    assert len(v) == vp.VOICEPRINT_DIM
    assert abs(_norm(v) - 1.0) < 1e-6


def test_empty_text_is_zero_vector():
    v = vp.extract_text_embedding("")
    assert len(v) == vp.VOICEPRINT_DIM
    assert all(x == 0.0 for x in v)


def test_self_similarity_is_one():
    text = "I really think we should basically ship this feature next week, honestly."
    a = vp.extract_text_embedding(text)
    assert abs(vp.cosine_similarity(a, a) - 1.0) < 1e-6


def test_similar_speech_more_similar_than_dissimilar():
    a = vp.extract_text_embedding(
        "Honestly I think we should basically ship it, like, right now, you know?"
    )
    b = vp.extract_text_embedding(
        "Honestly I reckon we ought to basically ship it, like, right away, you know?"
    )
    c = vp.extract_text_embedding(
        "The quarterly financial report indicates a downturn in regional revenue figures."
    )
    assert vp.cosine_similarity(a, b) > vp.cosine_similarity(a, c)


def test_merge_embeddings_stays_normalized():
    a = vp.extract_text_embedding("first sample of speech from this person here")
    b = vp.extract_text_embedding("second different sample with other words entirely now")
    merged = vp.merge_embeddings(a, 1, b)
    assert len(merged) == vp.VOICEPRINT_DIM
    assert abs(_norm(merged) - 1.0) < 1e-6


def test_merge_from_empty_returns_addition():
    b = vp.extract_text_embedding("only sample available right now for this speaker")
    merged = vp.merge_embeddings([], 0, b)
    assert merged == b


def test_summarize_speakers_groups_and_times():
    utterances = [
        {"speaker": "Alice", "text": "Hello everyone how are you", "start": 0, "end": 2000},
        {"speaker": "Bob", "text": "I am good thanks", "start": 2000, "end": 3500},
        {"speaker": "Alice", "text": "Great lets begin the meeting", "start": 3500, "end": 6000},
    ]
    out = vp.summarize_speakers(utterances)
    by_name = {s["speaker"]: s for s in out}
    assert set(by_name) == {"Alice", "Bob"}
    assert by_name["Alice"]["utterance_count"] == 2
    assert by_name["Alice"]["talk_time_ms"] == 2000 + 2500
    assert by_name["Bob"]["talk_time_ms"] == 1500
    assert len(by_name["Alice"]["embedding"]) == vp.VOICEPRINT_DIM


def test_speaker_talk_time_ms():
    utterances = [
        {"speaker": "A", "start": 0, "end": 1000},
        {"speaker": "A", "start": 1000, "end": 1500},
        {"speaker": "B", "start": 1500, "end": 4000},
    ]
    times = vp.speaker_talk_time_ms(utterances)
    assert times == {"A": 1500, "B": 2500}


def test_match_speakers_to_registry_matches_known_speaker():
    distinctive = (
        "Honestly, basically, I literally think we should totally ship this, you know, like right now, "
        "I mean obviously it's definitely ready, anyway, yeah, let's just do it folks."
    )
    registry = [{"id": 7, "canonical_name": "Alice", "embedding": vp.extract_text_embedding(distinctive)}]
    samples = [{
        "speaker": "Speaker 1",
        "text": distinctive,
        "embedding": vp.extract_text_embedding(distinctive),
    }]
    matches = vp.match_speakers_to_registry(samples, registry)
    assert "Speaker 1" in matches
    assert matches["Speaker 1"]["name"] == "Alice"
    assert matches["Speaker 1"]["voiceprint_id"] == 7
    assert 0.6 <= matches["Speaker 1"]["confidence"] <= 0.99


def test_match_skips_short_samples():
    registry = [{"id": 1, "canonical_name": "Alice", "embedding": vp.extract_text_embedding("hello there friend")}]
    samples = [{"speaker": "Speaker 1", "text": "hi", "embedding": vp.extract_text_embedding("hi")}]
    assert vp.match_speakers_to_registry(samples, registry) == {}


def test_match_empty_registry_returns_empty():
    samples = [{"speaker": "Speaker 1", "text": "a" * 60, "embedding": vp.extract_text_embedding("a" * 60)}]
    assert vp.match_speakers_to_registry(samples, []) == {}
