"""Audio segmentation via ffmpeg.

Long-capture sessions are sliced into per-visitor windows using marker
timestamps. We shell out to ffmpeg with stream-copy (`-c copy`) so the
operation is fast and never re-encodes — important for a 6-hour booth-day
WAV that we want to split in seconds, not minutes.

ffmpeg must be on PATH. On Windows: `winget install Gyan.FFmpeg`.
"""
from __future__ import annotations

import shutil
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path


class FFmpegMissingError(RuntimeError):
    pass


def _ffmpeg_path() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise FFmpegMissingError(
            "ffmpeg not found on PATH. Install it (Windows: winget install Gyan.FFmpeg; "
            "macOS: brew install ffmpeg; Linux: apt-get install ffmpeg) and restart the server."
        )
    return path


def _ffprobe_path() -> str | None:
    return shutil.which("ffprobe")


def probe_duration_seconds(audio_path: Path) -> float | None:
    """Return the audio duration in seconds, or None if ffprobe isn't available."""
    ffprobe = _ffprobe_path()
    if not ffprobe:
        return None
    proc = subprocess.run(
        [
            ffprobe, "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(audio_path),
        ],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        return None
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return None


@dataclass
class Segment:
    start: float            # seconds into source
    end: float | None       # seconds into source; None = to end-of-file
    output_path: Path
    label: str | None = None
    visitor_data: dict | None = None


def extract_segment(
    source_path: Path, start: float, end: float | None, output_path: Path
) -> None:
    """Extract [start, end) from source_path into output_path using ffmpeg.

    `end=None` means "to the end of the file" — used for the last visitor
    window when the recording duration is unknown (no ffprobe).

    Uses -c copy when possible (no re-encode). If the source container can't
    be cleanly cut at arbitrary offsets, falls back to re-encoding to a
    Whisper-friendly 16 kHz mono WAV.
    """
    if end is not None and end <= start:
        raise ValueError(f"end ({end}) must be greater than start ({start})")

    ffmpeg = _ffmpeg_path()
    dur_args = [] if end is None else ["-t", f"{end - start:.3f}"]

    # Path A: stream-copy. Fast and lossless when keyframes align.
    proc = subprocess.run(
        [
            ffmpeg, "-y", "-loglevel", "error",
            "-ss", f"{start:.3f}", "-i", str(source_path), *dur_args,
            "-c", "copy", "-map_metadata", "-1",
            str(output_path),
        ],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode == 0 and output_path.exists() and output_path.stat().st_size > 0:
        return

    # Path B: re-encode to 16 kHz mono WAV. Slower, always works, and the
    # output is in Whisper's preferred format anyway.
    proc = subprocess.run(
        [
            ffmpeg, "-y", "-loglevel", "error",
            "-ss", f"{start:.3f}", "-i", str(source_path), *dur_args,
            "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le",
            str(output_path.with_suffix(".wav")),
        ],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.strip() or 'unknown error'}")


def derive_segments_from_markers(
    markers: list[dict],
    total_duration: float | None,
    output_dir: Path,
    source_suffix: str,
) -> list[Segment]:
    """Walk markers and produce segment specs.

    Marker shape:
        { id, marker_type: 'visitor_start' | 'visitor_end' | 'note',
          timestamp_seconds, label, visitor_data }

    Rules:
      - A 'visitor_start' opens a window.
      - The window closes at:
          * the next matching 'visitor_end' if it appears before any other
            'visitor_start', else
          * the next 'visitor_start' (treated as an implicit end), else
          * total_duration (or "open-ended" — skipped if duration unknown).
      - 'note' markers are ignored by the segmenter.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    starts = sorted(
        [m for m in markers if m["marker_type"] == "visitor_start"],
        key=lambda m: m["timestamp_seconds"],
    )
    ends = sorted(
        [m for m in markers if m["marker_type"] == "visitor_end"],
        key=lambda m: m["timestamp_seconds"],
    )

    segments: list[Segment] = []
    for i, start_marker in enumerate(starts):
        s = float(start_marker["timestamp_seconds"])

        # Soonest matching end after s that is also before the next start.
        next_start = starts[i + 1]["timestamp_seconds"] if i + 1 < len(starts) else None
        end_candidate: float | None = None
        for em in ends:
            t = float(em["timestamp_seconds"])
            if t <= s:
                continue
            if next_start is not None and t > next_start:
                break
            end_candidate = t
            break

        if end_candidate is None:
            end_candidate = float(next_start) if next_start is not None else total_duration

        # If we still have no end (last visitor, no end marker, duration
        # unknown because ffprobe is unavailable), leave it open-ended:
        # ffmpeg will cut from `s` to the end of the file.
        if end_candidate is not None and end_candidate - s < 0.5:
            # Sub-half-second windows are almost certainly mistakes.
            continue

        suffix = source_suffix or ".wav"
        out_name = f"segment_{i:03d}_{uuid.uuid4().hex[:8]}{suffix}"
        segments.append(
            Segment(
                start=s,
                end=end_candidate,
                output_path=output_dir / out_name,
                label=start_marker.get("label"),
                visitor_data=start_marker.get("visitor_data"),
            )
        )

    return segments
