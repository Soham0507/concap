---
name: Primary User Voice Profile
description: How the per-user voice identity / speaker auto-relabel feature is wired and its privacy/consent rules.
---

# Primary User Voice Profile

Settings → Profile → "Voice Profile". Lets the signed-in user register identity +
a voice sample so generic "Speaker N" diarization labels are replaced with their
real name everywhere downstream.

- Reuses the EXISTING lexical voiceprint system (services/voiceprints.py) — a
  text/style fingerprint, NOT audio biometrics. True biometrics were ruled out due
  to deploy size limits. Confidence is reported as honest "similarity %", never a
  fake "accuracy %".
- The primary user is ONE `SpeakerVoiceprint` row with `is_primary=True` and
  `user_id` set, `canonical_name` = display name. It lives in the same org registry,
  so imported-meeting matching picks it up automatically — no change needed there.
- Native pipeline relabels by building a label→name map from the registry and
  passing it to `transcription.render_diarized_transcript(speakers, name_map)`. The
  stored `conv.transcript` carries real names, so analysis/CRM/quotes inherit it
  (they all read conv.transcript). One change point.

**Relabel must be wired at EVERY transcript-render site, not just the conversation
pipeline.** Quick-transcribe (routers/transcribe.py) and meeting_worker both render
diarized transcripts independently and originally omitted name_map → solo recordings
showed "Speaker 0" forever.
**Why:** lexical voiceprints almost never match a short SCRIPTED enrollment sample to
free-form conversational speech, so registry matching alone rarely relabels a real
recording. The reliable signal for "I recorded my own audio" is the authenticated
uploader, not the fingerprint.
**How to apply:** for a recording made by a known user, call
`voice_identity.identify_speakers_for_user(db, user, speakers)` (NOT plain
identify_speakers). It keeps registry matches but adds a single-speaker fallback:
if the user is enrolled AND the transcript has exactly one speaker label, that
speaker = the account holder's primary_name. Conversation has no user_id, so the
booth pipeline can't use this fallback (registry-only).

**Privacy rule:** raw audio is NEVER persisted — the sample is saved to a temp file,
transcribed, fingerprinted, then `unlink`ed in a `finally`. The consent notice
states this.

**Consent rule (non-obvious):** withdrawing consent via `PUT /api/voice-profile`
with `consent=false` must DELETE the enrolled voiceprint, not just clear
`voice_consent_at`. Otherwise identification keeps running while the UI shows
consent off.
**Why:** consent withdrawal has to actually stop identification, not just hide it.
**How to apply:** any future edit to update_profile must keep the delete-on-withdraw
branch; there's a regression test (test_withdrawing_consent_removes_voiceprint).
