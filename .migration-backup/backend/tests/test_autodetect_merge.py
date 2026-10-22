"""Offline unit tests for the autodetect session post-processing — the pure
overlap-merge and adjacent-coalesce logic that fights over-segmentation. No
network/LLM is touched here; these guard the de-duplication invariants that the
chunked detection relies on."""
from app.services.autodetect import (
    _coalesce_adjacent,
    _coalesce_reason,
    _merge_overlapping_sessions,
)


def _sess(start, end, company="Unknown", classification="customer",
          visitor_speakers=None, topics=None):
    return {
        "company": company,
        "visitor_names": [],
        "visitor_speakers": visitor_speakers or [],
        "rep_speakers": ["Speaker 0"],
        "start_seconds": float(start),
        "end_seconds": float(end),
        "topics": topics or [],
        "summary_hint": "",
        "classification": classification,
        "confidence": 0.5,
    }


def test_merge_absorbs_nested_overlapping_fragment():
    # A tiny sliver fully inside a real meeting (both Unknown) is the same meeting.
    sessions = [_sess(52, 354), _sess(60, 65), _sess(96, 101)]
    merged = _merge_overlapping_sessions(sessions)
    assert len(merged) == 1
    assert merged[0]["start_seconds"] == 52
    assert merged[0]["end_seconds"] == 354


def test_merge_keeps_two_distinct_known_companies():
    # Overlapping spans but two different KNOWN companies must stay separate.
    sessions = [_sess(0, 300, company="Boeing"), _sess(120, 320, company="CVS")]
    merged = _merge_overlapping_sessions(sessions)
    assert len(merged) == 2


def test_sliver_folds_into_substantial_neighbour():
    # A 35s sliver abutting a long (>120s) real meeting is over-segmentation noise.
    sessions = [_sess(2760, 3180), _sess(3185, 3215, topics=["chit chat"])]
    assert _coalesce_reason(sessions[0], sessions[1]) == "sliver"
    out = _coalesce_adjacent(sessions)
    assert len(out) == 1
    assert out[0]["start_seconds"] == 2760
    assert out[0]["end_seconds"] == 3215


def test_two_comparable_short_blocks_stay_separate():
    # Two real ~45s back-to-back visitor chats (unknown co.) must NOT be fused:
    # neither side reaches the substantial-neighbour size, so it's not a sliver.
    sessions = [_sess(0, 45, topics=["a"]), _sess(50, 95, topics=["b"])]
    assert _coalesce_reason(sessions[0], sessions[1]) is None
    out = _coalesce_adjacent(sessions)
    assert len(out) == 2


def test_bridge_sliver_does_not_transitively_merge():
    # A[real, Speaker 1] - tiny bridge sliver[Speaker 2] - B[real, Speaker 2].
    # The sliver folds into A, but its speaker must NOT leak into A and then
    # link A to B; A and B are distinct meetings and must stay separate.
    sessions = [
        _sess(0, 400, visitor_speakers=["Speaker 1"]),
        _sess(405, 420, visitor_speakers=["Speaker 2"]),
        _sess(425, 825, visitor_speakers=["Speaker 2"], topics=["b"]),
    ]
    out = _coalesce_adjacent(sessions)
    assert len(out) == 2
    assert out[0]["start_seconds"] == 0 and out[0]["end_seconds"] == 420
    assert out[1]["start_seconds"] == 425


def test_drops_empty_ultrashort_noise():
    # A 5s standalone block with no company and no topics is pure noise.
    sessions = [_sess(0, 300, topics=["x"]), _sess(4000, 4005)]
    out = _coalesce_adjacent(sessions)
    assert len(out) == 1
    assert out[0]["start_seconds"] == 0


def test_keeps_short_block_with_real_content():
    # A short block is kept when it carries a known company (real brief meeting).
    sessions = [_sess(0, 300, topics=["x"]), _sess(4000, 4010, company="Boeing")]
    out = _coalesce_adjacent(sessions)
    assert len(out) == 2


def test_coalesce_respects_classification_boundary():
    # A customer block and an abutting staff_only block are different meetings.
    sessions = [
        _sess(0, 300, classification="customer"),
        _sess(305, 600, classification="staff_only"),
    ]
    assert _coalesce_reason(sessions[0], sessions[1]) is None
    out = _coalesce_adjacent(sessions)
    assert len(out) == 2


def test_coalesce_does_not_merge_two_long_distinct_blocks():
    # Two long abutting blocks, no shared speakers, both Unknown -> stay separate.
    sessions = [
        _sess(0, 400, visitor_speakers=["Speaker 1"]),
        _sess(410, 900, visitor_speakers=["Speaker 2"]),
    ]
    assert _coalesce_reason(sessions[0], sessions[1]) is None
    out = _coalesce_adjacent(sessions)
    assert len(out) == 2


def test_coalesce_merges_long_blocks_sharing_speaker():
    # Same visitor still talking after a brief gap -> one meeting (continuation).
    sessions = [
        _sess(0, 400, visitor_speakers=["Speaker 1"]),
        _sess(410, 900, visitor_speakers=["Speaker 1"]),
    ]
    assert _coalesce_reason(sessions[0], sessions[1]) == "continuation"
    out = _coalesce_adjacent(sessions)
    assert len(out) == 1
    assert out[0]["end_seconds"] == 900


def test_coalesce_merges_same_known_company_across_gap():
    sessions = [
        _sess(0, 400, company="Peak Design"),
        _sess(410, 900, company="Peak Design"),
    ]
    assert _coalesce_reason(sessions[0], sessions[1]) == "continuation"
    out = _coalesce_adjacent(sessions)
    assert len(out) == 1


def test_no_merge_when_gap_too_large():
    sessions = [_sess(0, 400, company="Peak Design"), _sess(600, 900, company="Peak Design")]
    assert _coalesce_reason(sessions[0], sessions[1]) is None
