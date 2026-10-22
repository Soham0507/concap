"""Tests for the conversation parsers that feed the Imported Meetings tab.

Covers the credential-free intake formats: Slack/Discord JSON, email threads,
SRT/VTT subtitles and plain ``Speaker: text`` transcripts, plus the kind
auto-detection used by file uploads.
"""
from __future__ import annotations

import json

from app.services import conversation_parsers as cp


def test_looks_like_srt_detects_vtt_and_srt():
    srt = "1\n00:00:01,000 --> 00:00:03,000\nHello there\n"
    vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello there\n"
    assert cp.looks_like_srt(srt)
    assert cp.looks_like_srt(vtt)
    assert not cp.looks_like_srt("just some plain text without timestamps")


def test_parse_srt_strips_cues_to_text():
    srt = (
        "1\n00:00:01,000 --> 00:00:03,000\nHello there\n\n"
        "2\n00:00:04,000 --> 00:00:06,000\nHow are you\n"
    )
    out = cp.parse_srt(srt)
    assert "Hello there" in out
    assert "How are you" in out
    assert "-->" not in out
    assert "00:00:01" not in out


def test_transcript_to_utterances_speaker_prefixes():
    text = "Alice: Hi everyone\nBob: Hello Alice\nAlice: Shall we start?"
    utts = cp.transcript_to_utterances(text, "plain")
    speakers = [u["speaker"] for u in utts]
    assert speakers == ["Alice", "Bob", "Alice"]
    assert utts[0]["text"] == "Hi everyone"
    assert all("start" in u and "end" in u for u in utts)


def test_transcript_to_utterances_plain_block_falls_back_to_one_speaker():
    text = "This is a wall of text with no speaker labels at all."
    utts = cp.transcript_to_utterances(text, "plain")
    assert len(utts) == 1
    assert utts[0]["speaker"] == "Speaker 1"
    assert utts[0]["text"].startswith("This is a wall")


def test_transcript_to_utterances_srt_keeps_timings():
    srt = (
        "WEBVTT\n\n"
        "00:00:01.000 --> 00:00:03.000\nAlice: Hi\n\n"
        "00:00:04.000 --> 00:00:06.000\nBob: Hey\n"
    )
    utts = cp.transcript_to_utterances(srt, "srt")
    assert len(utts) >= 2
    # SRT path carries cue timings (ms) rather than None.
    assert any(u.get("start") is not None for u in utts)


def test_normalize_slack_json():
    payload = json.dumps([
        {"user": "U1", "real_name": "Alice", "text": "Morning", "ts": "1700000000.0001"},
        {"user": "U2", "real_name": "Bob", "text": "Hi Alice", "ts": "1700000060.0002"},
    ])
    result = cp.normalize_conversation(payload, "slack", None)
    assert result["source"] == "slack"
    assert "Alice" in result["content"]
    assert "Morning" in result["content"]
    assert len(result["participants"]) == 2


def test_normalize_discord_json():
    payload = json.dumps({
        "channel": {"name": "general", "category": "text"},
        "messages": [
            {"author": {"name": "Carol"}, "content": "hey", "timestamp": "2024-01-01T10:00:00Z"},
            {"author": {"name": "Dave"}, "content": "yo", "timestamp": "2024-01-01T10:01:00Z"},
        ],
    })
    result = cp.normalize_conversation(payload, "discord", None)
    assert result["source"] == "discord"
    assert "Carol" in result["content"]
    assert "hey" in result["content"]


def test_normalize_email_thread():
    raw = (
        "From: Alice <alice@example.com>\n"
        "To: Bob <bob@example.com>\n"
        "Subject: Project kickoff\n"
        "Date: Mon, 1 Jan 2024 10:00:00 +0000\n"
        "\n"
        "Hi Bob, let's start the project next week.\n"
    )
    result = cp.normalize_conversation(raw, "email", None)
    assert result["source"] == "email"
    assert "project" in result["content"].lower()


def test_normalize_plain_uses_fallback_title():
    result = cp.normalize_conversation("Alice: hello", "plain", "My Title")
    assert result["title"] == "My Title"
    assert result["source"] == "manual"


def test_normalize_empty_content():
    result = cp.normalize_conversation("   ", "plain", "Empty")
    assert result["content"] == ""
    assert result["participants"] == []


def test_detect_kind():
    assert cp.detect_kind("meeting.srt", "irrelevant") == "srt"
    assert cp.detect_kind("notes.vtt", "irrelevant") == "srt"
    assert cp.detect_kind("thread.eml", "From: a@b.com\nSubject: x\n\nbody") == "email"
    assert cp.detect_kind("notes.txt", "Alice: hi") == "plain"
    discord = json.dumps({"guild": {"name": "g"}, "messages": []})
    assert cp.detect_kind("export.json", discord) == "discord"
    slack = json.dumps([{"user": "U1", "text": "hi", "ts": "1.0"}])
    assert cp.detect_kind("export.json", slack) == "slack"
