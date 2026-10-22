"""Normalizers that turn raw pasted/uploaded chat content into clean,
conversation-ready transcripts for the Imported Meetings tab.

Ported from the source app's ``conversation-parsers.ts`` + ``srt-parser.ts``
into pure Python (no third-party deps). Supported kinds:

  - ``plain``   – passthrough (whitespace-trimmed)
  - ``slack``   – Slack JSON export (array of message objects, or an
                  ``{messages: [...]}`` channel-export file) — falls back to a
                  plain-text passthrough tagged as slack.
  - ``discord`` – DiscordChatExporter JSON (single channel) or a raw messages
                  array — falls back to plain-text passthrough.
  - ``email``   – a single .eml RFC822 message / forwarded paste / trivial mbox.
  - ``srt``     – SRT/WebVTT subtitle text (auto-detected and cleaned).

On top of normalization this module also derives a diarized utterance list
(``[{speaker, text, start, end}]``) used by the voiceprint engine.
"""

from __future__ import annotations

import base64
import binascii
import json
import quopri
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

ConversationKind = str  # "plain" | "slack" | "discord" | "email" | "srt"

# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def _safe_json(text: str) -> Any:
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def _ts_to_dt(ts: Any) -> datetime | None:
    """Slack uses seconds-with-decimal; if too small treat as seconds, else ms."""
    if ts is None:
        return None
    try:
        num = float(ts)
    except (ValueError, TypeError):
        return None
    if num != num or num in (float("inf"), float("-inf")):  # NaN / inf guard
        return None
    ms = num * 1000 if num < 1e12 else num
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None


def _uniq(arr: list[str]) -> list[str]:
    seen: dict[str, None] = {}
    for x in arr:
        if x and x.strip():
            seen.setdefault(x, None)
    return list(seen.keys())


def _stamp(dt: datetime | None) -> str:
    if not dt:
        return ""
    return dt.isoformat().replace("T", " ")[:16]


# --------------------------------------------------------------------------- #
# Slack
# --------------------------------------------------------------------------- #


def _normalize_slack_json(parsed: Any) -> dict | None:
    messages = None
    channel_name = None

    if isinstance(parsed, list):
        messages = parsed
    elif isinstance(parsed, dict):
        if isinstance(parsed.get("messages"), list):
            messages = parsed["messages"]
        ch = parsed.get("channel")
        if isinstance(ch, str):
            channel_name = ch
        elif isinstance(ch, dict) and isinstance(ch.get("name"), str):
            channel_name = ch["name"]

    if not messages:
        return None

    lines: list[str] = []
    participants: list[str] = []
    earliest: datetime | None = None
    latest: datetime | None = None

    for m in messages:
        if not isinstance(m, dict):
            continue
        if m.get("type") and m.get("type") != "message":
            continue
        text = (m.get("text") or "").strip()
        if not text:
            continue
        prof = m.get("user_profile") or {}
        author = (
            prof.get("real_name")
            or prof.get("display_name")
            or prof.get("name")
            or m.get("username")
            or m.get("user")
            or "Unknown"
        )
        participants.append(author)
        date = _ts_to_dt(m.get("ts"))
        if date:
            earliest = date if not earliest or date < earliest else earliest
            latest = date if not latest or date > latest else latest
        stamp = _stamp(date)
        lines.append(f"{f'[{stamp}] ' if stamp else ''}{author}: {text}")

    if not lines:
        return None

    return {
        "title": f"Slack: #{channel_name}" if channel_name else "Slack conversation",
        "content": "\n".join(lines),
        "participants": _uniq(participants),
        "meeting_date": latest or earliest,
        "source": "slack",
        "channel_name": channel_name,
    }


# --------------------------------------------------------------------------- #
# Discord
# --------------------------------------------------------------------------- #


def _parse_iso(value: str) -> datetime | None:
    if not value:
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def _normalize_discord_json(parsed: Any) -> dict | None:
    messages = None
    channel_name = None
    guild_name = None

    if isinstance(parsed, list):
        messages = parsed
    elif isinstance(parsed, dict):
        if isinstance(parsed.get("messages"), list):
            messages = parsed["messages"]
        channel_name = (parsed.get("channel") or {}).get("name") if isinstance(parsed.get("channel"), dict) else None
        guild_name = (parsed.get("guild") or {}).get("name") if isinstance(parsed.get("guild"), dict) else None

    if not messages:
        return None

    lines: list[str] = []
    participants: list[str] = []
    earliest: datetime | None = None
    latest: datetime | None = None

    for m in messages:
        if not isinstance(m, dict):
            continue
        text = (m.get("content") or "").strip()
        if not text:
            continue
        author_obj = m.get("author") or {}
        author = (
            author_obj.get("nickname")
            or author_obj.get("name")
            or author_obj.get("username")
            or "Unknown"
        )
        participants.append(author)
        date = _parse_iso(m.get("timestamp") or "")
        if date:
            earliest = date if not earliest or date < earliest else earliest
            latest = date if not latest or date > latest else latest
        stamp = _stamp(date)
        lines.append(f"{f'[{stamp}] ' if stamp else ''}{author}: {text}")

    if not lines:
        return None

    title_parts = []
    if guild_name:
        title_parts.append(guild_name)
    if channel_name:
        title_parts.append(f"#{channel_name}")
    title = f"Discord: {' '.join(title_parts)}" if title_parts else "Discord conversation"

    return {
        "title": title,
        "content": "\n".join(lines),
        "participants": _uniq(participants),
        "meeting_date": latest or earliest,
        "source": "discord",
        "channel_name": channel_name,
    }


# --------------------------------------------------------------------------- #
# Email (.eml / forwarded paste / trivial mbox)
# --------------------------------------------------------------------------- #


def _decode_qp(text: str, charset: str = "utf-8") -> str:
    try:
        decoded = quopri.decodestring(text.encode("latin-1", "ignore"))
        return decoded.decode(charset, "replace")
    except (LookupError, ValueError):
        return text


def _decode_b64(text: str, charset: str = "utf-8") -> str:
    try:
        raw = base64.b64decode(re.sub(r"\s+", "", text), validate=False)
        return raw.decode(charset, "replace")
    except (binascii.Error, ValueError, LookupError):
        return text


def _extract_charset(content_type: str) -> str:
    m = re.search(r'charset\s*=\s*"?([^";\s]+)"?', content_type, re.I)
    return (m.group(1) if m else "utf-8").lower()


def _html_to_text(html: str) -> str:
    out = re.sub(r"<style[\s\S]*?</style>", "", html, flags=re.I)
    out = re.sub(r"<script[\s\S]*?</script>", "", out, flags=re.I)
    out = re.sub(r"<br\s*/?>", "\n", out, flags=re.I)
    out = re.sub(r"</p>", "\n\n", out, flags=re.I)
    out = re.sub(r"<[^>]+>", "", out)
    replacements = {
        "&nbsp;": " ", "&amp;": "&", "&lt;": "<",
        "&gt;": ">", "&quot;": '"', "&#39;": "'",
    }
    for k, v in replacements.items():
        out = out.replace(k, v)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


def _parse_single_email(raw: str) -> dict:
    split = re.search(r"\r?\n\r?\n", raw)
    if split:
        header_block = raw[: split.start()]
        body_block = raw[split.end():]
    else:
        header_block = ""
        body_block = raw

    unfolded = re.sub(r"\r?\n[ \t]+", " ", header_block)
    headers: dict[str, str] = {}
    for line in unfolded.split("\n"):
        m = re.match(r"^([A-Za-z-]+)\s*:\s*(.*)$", line)
        if m:
            headers[m.group(1).lower()] = m.group(2).strip()

    enc = (headers.get("content-transfer-encoding") or "").lower()
    ctype = (headers.get("content-type") or "").lower()
    charset = _extract_charset(ctype)

    body = body_block
    if "quoted-printable" in enc:
        body = _decode_qp(body, charset)
    if "base64" in enc:
        body = _decode_b64(body, charset)

    boundary_match = re.search(r'boundary="?([^";]+)"?', ctype)
    if boundary_match:
        boundary = re.escape(boundary_match.group(1))
        parts = re.split(rf"--{boundary}(?:--)?", body)
        plain = ""
        html = ""
        for part in parts:
            sep = re.search(r"\r?\n\r?\n", part)
            if not sep:
                continue
            part_headers = part[: sep.start()].lower()
            part_body = part[sep.end():]
            part_charset = _extract_charset(part_headers)
            if "quoted-printable" in part_headers:
                part_body = _decode_qp(part_body, part_charset)
            elif "base64" in part_headers:
                part_body = _decode_b64(part_body, part_charset)
            if "text/plain" in part_headers and not plain:
                plain = part_body
            elif "text/html" in part_headers and not html:
                html = part_body
        if plain.strip():
            body = plain
        elif html.strip():
            body = _html_to_text(html)
    elif "text/html" in ctype:
        body = _html_to_text(body)

    date = None
    if headers.get("date"):
        try:
            date = parsedate_to_datetime(headers["date"])
        except (TypeError, ValueError):
            date = None

    def split_addrs(s: str) -> list[str]:
        return [x.strip() for x in s.split(",") if x.strip()]

    return {
        "from": headers.get("from"),
        "to": split_addrs(headers["to"]) if headers.get("to") else None,
        "cc": split_addrs(headers["cc"]) if headers.get("cc") else None,
        "subject": headers.get("subject"),
        "date": date,
        "body": body.strip(),
    }


def _looks_like_eml(raw: str) -> bool:
    head = raw[:2000]
    return bool(re.search(r"^(From|Subject|Date|To|Message-ID|Return-Path):", head, re.I | re.M))


def _normalize_email(raw: str) -> dict | None:
    trimmed = raw.strip()
    if not trimmed:
        return None

    if re.search(r"^From [^\r\n]+\r?\n", trimmed, re.M):
        blocks = [b.strip() for b in re.split(r"(?:^|\r?\n)From [^\r\n]+\r?\n", trimmed, flags=re.M) if b.strip()]
    else:
        blocks = [trimmed]

    emails = [e for e in (_parse_single_email(b) for b in blocks) if e["body"] or e["subject"]]
    if not emails:
        return None

    participants: list[str] = []
    lines: list[str] = []
    earliest: datetime | None = None
    latest: datetime | None = None
    first_subject: str | None = None

    for e in emails:
        if e["from"]:
            participants.append(e["from"])
        if e["to"]:
            participants.extend(e["to"])
        if e["cc"]:
            participants.extend(e["cc"])
        if e["date"]:
            earliest = e["date"] if not earliest or e["date"] < earliest else earliest
            latest = e["date"] if not latest or e["date"] > latest else latest
        if not first_subject and e["subject"]:
            first_subject = e["subject"]

        header: list[str] = []
        if e["subject"]:
            header.append(f"Subject: {e['subject']}")
        if e["from"]:
            header.append(f"From: {e['from']}")
        if e["to"]:
            header.append(f"To: {', '.join(e['to'])}")
        if e["cc"]:
            header.append(f"Cc: {', '.join(e['cc'])}")
        if e["date"]:
            header.append(f"Date: {e['date'].isoformat()}")
        lines.append("\n".join(header))
        lines.append("")
        lines.append(e["body"] or "")
        lines.append("\n---\n")

    return {
        "title": f"Email: {first_subject}" if first_subject else "Email thread",
        "content": "\n".join(lines).strip(),
        "participants": _uniq(participants),
        "meeting_date": latest or earliest,
        "source": "email",
        "channel_name": None,
    }


# --------------------------------------------------------------------------- #
# SRT / WebVTT
# --------------------------------------------------------------------------- #

_TIMESTAMP_LINE = re.compile(
    r"^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3}).*$"
)
_CUE_NUMBER_LINE = re.compile(r"^\s*\d+\s*$")
_TAG = re.compile(r"</?[^>]+>")
_BRACKET_TAG = re.compile(r"\{\\[^}]+\}")
_VOICE_TAG_OPEN = re.compile(r"<v(?:\.[^\s>]+)?\s+([^>]+)>", re.I)
_TIMESTAMP_ANYWHERE = re.compile(
    r"\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}"
)


def looks_like_srt(text: str) -> bool:
    if not text or not isinstance(text, str):
        return False
    sample = text[:4000]
    if text.lstrip().upper().startswith("WEBVTT"):
        return bool(_TIMESTAMP_ANYWHERE.search(sample))
    return bool(_TIMESTAMP_ANYWHERE.search(sample))


def _parse_timestamp_to_ms(line: str) -> dict | None:
    m = _TIMESTAMP_LINE.match(line)
    if not m:
        return None
    h1, m1, s1, ms1, h2, m2, s2, ms2 = m.groups()
    start = int(h1) * 3600000 + int(m1) * 60000 + int(s1) * 1000 + int(ms1.ljust(3, "0")[:3])
    end = int(h2) * 3600000 + int(m2) * 60000 + int(s2) * 1000 + int(ms2.ljust(3, "0")[:3])
    return {"start_ms": start, "end_ms": end}


def _minute_marker(ms: int) -> str:
    total_minutes = ms // 60000
    hours = total_minutes // 60
    minutes = total_minutes % 60
    return f"[{hours:02d}:{minutes:02d}]"


def _clean_cue_text(raw_lines: list[str], preserve_structure: bool) -> str:
    out: list[str] = []
    for raw in raw_lines:
        line = raw
        if preserve_structure:
            trimmed = line.strip()
            voice = _VOICE_TAG_OPEN.search(trimmed)
            if voice and trimmed.lower().startswith("<v"):
                speaker = voice.group(1).strip()
                after = re.sub(r"</v>\s*$", "", trimmed[len(voice.group(0)):], flags=re.I)
                line = f"{speaker}: {after}"
        cleaned = _BRACKET_TAG.sub("", _TAG.sub("", line)).strip()
        if cleaned:
            out.append(cleaned)
    return "\n".join(out)


def _parse_cue_blocks(srt_text: str) -> list[dict]:
    text = srt_text.lstrip("\ufeff")
    lines = re.split(r"\r?\n", text)
    cues: list[dict] = []
    i = 0
    n = len(lines)
    while i < n:
        while i < n and lines[i].strip() == "":
            i += 1
        if i >= n:
            break
        timestamp = None
        if _CUE_NUMBER_LINE.match(lines[i].strip()):
            j = i + 1
            while j < n and lines[j].strip() == "":
                j += 1
            if j < n:
                ts = _parse_timestamp_to_ms(lines[j].strip())
                if ts:
                    timestamp = ts
                    i = j + 1
        if not timestamp:
            ts = _parse_timestamp_to_ms(lines[i].strip())
            if ts:
                timestamp = ts
                i += 1
        if not timestamp:
            i += 1
            continue
        text_lines: list[str] = []
        while i < n and lines[i].strip() != "":
            text_lines.append(lines[i])
            i += 1
        cues.append({"start_ms": timestamp["start_ms"], "end_ms": timestamp["end_ms"], "lines": text_lines})
    return cues


def parse_srt(srt_text: str, preserve_structure: bool = False) -> str:
    if not srt_text or not isinstance(srt_text, str):
        return ""
    cues = _parse_cue_blocks(srt_text)
    output: list[str] = []
    last_minute = -1
    for cue in cues:
        cleaned = _clean_cue_text(cue["lines"], preserve_structure)
        if not cleaned:
            continue
        if preserve_structure:
            minute = cue["start_ms"] // 60000
            if minute != last_minute:
                output.append(_minute_marker(cue["start_ms"]))
                last_minute = minute
            output.append(cleaned)
        else:
            output.append(cleaned)
            output.append("")
    return re.sub(r"\n{3,}", "\n\n", "\n".join(output)).strip()


def _srt_to_utterances(srt_text: str) -> list[dict]:
    """Diarized utterances from SRT/VTT: one per voice-tagged / prefixed cue."""
    cues = _parse_cue_blocks(srt_text)
    utterances: list[dict] = []
    for cue in cues:
        cleaned = _clean_cue_text(cue["lines"], preserve_structure=True)
        if not cleaned:
            continue
        speaker = "Speaker 1"
        text = cleaned.replace("\n", " ").strip()
        m = re.match(r"^([^:]{1,60}):\s*(.*)$", text)
        if m:
            speaker = m.group(1).strip()
            text = m.group(2).strip()
        if not text:
            continue
        utterances.append({
            "speaker": speaker,
            "text": text,
            "start": cue["start_ms"],
            "end": cue["end_ms"],
        })
    return utterances


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #


def normalize_conversation(raw_content: str, kind: ConversationKind, fallback_title: str | None = None) -> dict:
    """Turn raw pasted content into a normalized dict:
    ``{title, content, participants, meeting_date, source, channel_name}``."""
    trimmed = (raw_content or "").strip()
    base_source = "manual" if kind == "plain" else kind
    if not trimmed:
        return {
            "title": fallback_title or "Empty conversation",
            "content": "",
            "participants": [],
            "meeting_date": None,
            "source": base_source,
            "channel_name": None,
        }

    if kind == "slack":
        parsed = _safe_json(trimmed)
        if parsed is not None:
            result = _normalize_slack_json(parsed)
            if result:
                if fallback_title:
                    result["title"] = fallback_title
                return result
        return {
            "title": fallback_title or "Slack conversation",
            "content": trimmed, "participants": [], "meeting_date": None,
            "source": "slack", "channel_name": None,
        }

    if kind == "discord":
        parsed = _safe_json(trimmed)
        if parsed is not None:
            result = _normalize_discord_json(parsed)
            if result:
                if fallback_title:
                    result["title"] = fallback_title
                return result
        return {
            "title": fallback_title or "Discord conversation",
            "content": trimmed, "participants": [], "meeting_date": None,
            "source": "discord", "channel_name": None,
        }

    if kind == "email":
        if _looks_like_eml(trimmed):
            result = _normalize_email(trimmed)
            if result:
                if fallback_title:
                    result["title"] = fallback_title
                return result
        return {
            "title": fallback_title or "Email thread",
            "content": trimmed, "participants": [], "meeting_date": None,
            "source": "email", "channel_name": None,
        }

    if kind == "srt" or looks_like_srt(trimmed):
        cleaned = parse_srt(trimmed, preserve_structure=True)
        return {
            "title": fallback_title or "Subtitle transcript",
            "content": cleaned or trimmed, "participants": [], "meeting_date": None,
            "source": "srt", "channel_name": None,
        }

    return {
        "title": fallback_title or "Pasted conversation",
        "content": trimmed, "participants": [], "meeting_date": None,
        "source": "manual", "channel_name": None,
    }


def transcript_to_utterances(content: str, kind: ConversationKind = "plain") -> list[dict]:
    """Derive a diarized utterance list ``[{speaker, text, start, end}]`` from a
    normalized transcript. SRT/VTT keeps cue timings; line-based formats split on
    ``Speaker: text`` prefixes (timeless)."""
    text = (content or "").strip()
    if not text:
        return []

    if kind == "srt" or looks_like_srt(text):
        utts = _srt_to_utterances(text)
        if utts:
            return utts

    utterances: list[dict] = []
    current_speaker = "Speaker 1"
    current_text: list[str] = []

    def flush() -> None:
        if current_text:
            joined = " ".join(current_text).strip()
            if joined:
                utterances.append({"speaker": current_speaker, "text": joined, "start": None, "end": None})

    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        # Strip a leading timestamp marker like "[00:03]" or "[2024-01-01 10:00]".
        line = re.sub(r"^\[[^\]]+\]\s*", "", line).strip()
        if not line:
            continue
        m = re.match(r"^([A-Za-z0-9 ._'\-]{1,60}):\s+(.*)$", line)
        if m and not m.group(1).strip().isdigit():
            flush()
            current_speaker = m.group(1).strip()
            current_text = [m.group(2).strip()] if m.group(2).strip() else []
        else:
            current_text.append(line)
    flush()

    if not utterances and text:
        utterances.append({"speaker": "Speaker 1", "text": text, "start": None, "end": None})
    return utterances


def detect_kind(filename: str | None, content: str) -> ConversationKind:
    """Best-effort kind detection for uploaded files."""
    name = (filename or "").lower()
    if name.endswith((".srt", ".vtt")):
        return "srt"
    if name.endswith(".eml"):
        return "email"
    if name.endswith(".json"):
        parsed = _safe_json(content)
        if isinstance(parsed, dict):
            if isinstance(parsed.get("guild"), dict) or (
                isinstance(parsed.get("channel"), dict) and "category" in (parsed.get("channel") or {})
            ):
                return "discord"
            return "slack"
        if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
            if "content" in parsed[0] or "author" in parsed[0]:
                return "discord"
            return "slack"
    if looks_like_srt(content):
        return "srt"
    if _looks_like_eml(content):
        return "email"
    return "plain"
