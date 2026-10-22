"""Pluggable speech-to-text layer.

Two providers, picked at runtime:

  whisper  — OpenAI Whisper API. Single text blob, no diarization. Always
             works as long as OPENAI_API_KEY is set.

  deepgram — Deepgram Nova with `diarize=true`, `smart_format=true`,
             `utterances=true`. Returns a speaker-labeled transcript,
             which produces dramatically better GPT summaries for booth
             conversations because the model can distinguish visitor
             from booth rep.

Selection:
  STT_PROVIDER=auto      → deepgram if DEEPGRAM_API_KEY is set, else whisper
  STT_PROVIDER=whisper   → force Whisper
  STT_PROVIDER=deepgram  → force Deepgram (errors if key missing)

The result shape is stable across providers:

    {
      "text": "full plain-text transcript",
      "language": "en" or None,
      "duration": float seconds or None,
      "diarized": bool,
      "speakers": [
        { "speaker": "Speaker 0", "start": 0.5, "end": 6.2,
          "text": "Hello, welcome to the booth..." },
        ...
      ] or [],
      "speaker_count": int,
      "provider": "whisper" | "deepgram",
    }
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx

from ..config import get_settings


def _select_provider() -> str:
    s = get_settings()
    choice = (s.stt_provider or "auto").lower().strip()
    if choice == "auto":
        return "deepgram" if s.deepgram_api_key else "whisper"
    if choice not in {"whisper", "deepgram"}:
        return "whisper"
    return choice


def transcribe_audio(audio_path: Path) -> dict:
    """Top-level entry point. Routes to the configured provider."""
    provider = _select_provider()
    if provider == "deepgram":
        return _transcribe_deepgram(audio_path)
    return _transcribe_whisper(audio_path)


# -- Whisper ---------------------------------------------------------------

def _transcribe_whisper(audio_path: Path) -> dict:
    from openai import OpenAI

    settings = get_settings()
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")

    client = OpenAI(api_key=settings.openai_api_key)
    with audio_path.open("rb") as f:
        result = client.audio.transcriptions.create(
            model=settings.whisper_model,
            file=f,
            response_format="verbose_json",
        )

    text = (getattr(result, "text", "") or "").strip()
    language = getattr(result, "language", None)
    duration = getattr(result, "duration", None)

    return {
        "text": text,
        "language": language,
        "duration": float(duration) if duration is not None else None,
        "diarized": False,
        "speakers": [],
        "speaker_count": 0,
        "provider": "whisper",
    }


# -- Deepgram --------------------------------------------------------------

def _transcribe_deepgram(audio_path: Path) -> dict:
    settings = get_settings()
    if not settings.deepgram_api_key:
        raise RuntimeError("DEEPGRAM_API_KEY is not configured")

    suffix = audio_path.suffix.lower()
    content_type = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".mp4": "audio/mp4",
        ".webm": "audio/webm",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
    }.get(suffix, "application/octet-stream")

    params = {
        "model": settings.deepgram_model,
        "diarize": "true",
        "smart_format": "true",
        "utterances": "true",
        "punctuate": "true",
        "detect_language": "true",
    }

    with audio_path.open("rb") as f:
        body = f.read()

    # Deepgram can be slow on long audio; allow up to 5 minutes.
    with httpx.Client(timeout=300.0) as client:
        resp = client.post(
            "https://api.deepgram.com/v1/listen",
            params=params,
            headers={
                "Authorization": f"Token {settings.deepgram_api_key}",
                "Content-Type": content_type,
            },
            content=body,
        )

    if resp.status_code >= 400:
        try:
            detail = resp.json()
        except json.JSONDecodeError:
            detail = resp.text
        raise RuntimeError(f"Deepgram error {resp.status_code}: {detail}")

    return _normalize_deepgram(resp.json())


def _normalize_deepgram(raw: dict) -> dict:
    """Reshape Deepgram's response into our internal contract."""
    results = raw.get("results") or {}
    channels = results.get("channels") or []
    metadata = raw.get("metadata") or {}

    text = ""
    language = None
    if channels:
        alt0 = (channels[0].get("alternatives") or [{}])[0]
        text = (alt0.get("transcript") or "").strip()
        language = channels[0].get("detected_language") or alt0.get("language")

    utterances = results.get("utterances") or []
    speakers: list[dict] = []
    speaker_ids: set[int] = set()
    for u in utterances:
        sp = u.get("speaker")
        if sp is None:
            continue
        speaker_ids.add(int(sp))
        speakers.append({
            "speaker": f"Speaker {int(sp)}",
            "start": float(u.get("start") or 0.0),
            "end": float(u.get("end") or 0.0),
            "text": (u.get("transcript") or "").strip(),
        })

    return {
        "text": text,
        "language": language,
        "duration": float(metadata.get("duration") or 0.0) or None,
        "diarized": True,
        "speakers": speakers,
        "speaker_count": len(speaker_ids),
        "provider": "deepgram",
    }


def render_diarized_transcript(
    speakers: list[dict], name_map: dict[str, str] | None = None
) -> str:
    """Plain-text rendering for the GPT prompt and the dashboard view.

    ``name_map`` optionally maps anonymous speaker labels ("Speaker 0") to real
    names so the rendered transcript — and everything downstream that reads it
    (analysis, summaries, action items, CRM notes, the Quote agent) — carries
    the identified speaker's name instead of a generic label.
    """
    lines = []
    for s in speakers:
        label = (name_map or {}).get(s["speaker"], s["speaker"])
        lines.append(f"[{_fmt_ts(s['start'])}–{_fmt_ts(s['end'])}] {label}: {s['text']}")
    return "\n".join(lines)


def _fmt_ts(seconds: float) -> str:
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m:02d}:{s:02d}"
