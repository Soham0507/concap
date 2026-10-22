---
name: Diarized transcript formats (dashboard speaker breakdown)
description: Two distinct on-disk diarized transcript shapes the dashboard must parse, and why a single regex silently hides the speaker breakdown.
---

# Two diarized transcript formats are stored

Conversations carry diarized transcripts in TWO different shapes depending on
which flow created them:

- **Range format** — `render_diarized_transcript` (transcription.py), used by the
  manual-marker / per-segment Deepgram flow: `[MM:SS–MM:SS] Speaker N: text`.
- **Point format** — `render_segment_transcript` (autodetect.py), used by the AI
  auto-detect long-capture flow: `[MM:SS] Speaker N (rep): text`
  (single timestamp, optional ` (rep)` suffix on rep speakers).

Both use `_fmt_ts`, which emits **minutes with no hour rollover** — long captures
produce 3+ digit minutes like `105:30`.

**Why it matters:** the dashboard speaker breakdown (count, talk-time, names) is
computed client-side by `parseSpeakerStats` in `frontend/dashboard.js`. If its
regex doesn't match a line, that line is skipped; if nothing parses,
`renderSpeakerBreakdown` returns `""` (stats.length < 2) and the ENTIRE breakdown
disappears — including GPT-detected names, which only resolve once the breakdown
renders.

**How to apply:** any parser of stored transcripts must tolerate BOTH formats,
multi-digit minutes, and the optional `(rep)` suffix (strip it — don't let it
pollute the `Speaker N` key, which must stay aligned with `analysis.speaker_names`).
Point-format lines have no end time; estimate talk time from the next turn's start
(cap it so a long pause can't dominate). Prefer fixing the display parser over the
backend writer — historical rows already hold the mixed legacy formats.
