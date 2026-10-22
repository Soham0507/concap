"""Primary-user voice identification.

Thin DB-aware layer on top of the lexical voiceprint matcher
(``services.voiceprints``). It loads an org's speaker registry, turns a set of
diarized utterances into a high-confidence ``{anonymous_label -> real_name}``
map, and manages the account holder's own "primary" voiceprint (the row that is
matched against future conversations so generic "Speaker N" labels are replaced
with the user's display name).

The fingerprint is a lexical/style vector — consistent vocabulary and speech
patterns, no audio biometrics — so identification is honest about its
confidence and improves as the user is confirmed in real conversations.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import SpeakerVoiceprint, User, utcnow
from . import voiceprints


def registry_for_org(db: Session, org_id: int | None) -> list[dict]:
    """The org's confirmed speakers, in the shape the matcher expects."""
    rows = db.scalars(
        select(SpeakerVoiceprint).where(SpeakerVoiceprint.org_id == org_id)
    ).all()
    return [
        {"id": r.id, "canonical_name": r.canonical_name, "embedding": r.embedding or []}
        for r in rows
        if r.embedding
    ]


def identify_speakers(
    db: Session, org_id: int | None, utterances: list[dict]
) -> dict[str, str]:
    """Return ``{anonymous_label -> real_name}`` for speakers that match a
    registered voiceprint with high confidence. Empty when nothing matches."""
    registry = registry_for_org(db, org_id)
    if not registry:
        return {}
    samples = voiceprints.summarize_speakers(utterances)
    matches = voiceprints.match_speakers_to_registry(samples, registry)
    return {label: m["name"] for label, m in matches.items() if m.get("name")}


def identify_speakers_for_user(
    db: Session, user: User | None, utterances: list[dict]
) -> dict[str, str]:
    """``identify_speakers`` for a recording made BY a known account holder.

    Registry (lexical) matches take precedence. On top of that it adds an honest
    fallback for the common "I recorded/uploaded my own audio" case: if the user
    has enrolled a voice profile and the recording contains a single speaker,
    that speaker is almost certainly the account holder, so label them by name.
    Lexical fingerprints of a short scripted enrollment rarely match free-form
    speech on their own, so this fallback is what makes a solo recording show the
    user's name instead of "Speaker 0"."""
    org_id = user.org_id if user else None
    name_map = identify_speakers(db, org_id, utterances)
    if user is None:
        return name_map
    vp = primary_for_user(db, user)
    if vp is None:
        return name_map
    labels = {
        u.get("speaker")
        for u in (utterances or [])
        if u.get("speaker")
    }
    if len(labels) == 1:
        only = next(iter(labels))
        name_map.setdefault(only, primary_name(user))
    return name_map


def primary_for_user(db: Session, user: User) -> SpeakerVoiceprint | None:
    """The account holder's own voiceprint row, if enrolled."""
    return db.scalar(
        select(SpeakerVoiceprint).where(
            SpeakerVoiceprint.user_id == user.id,
            SpeakerVoiceprint.is_primary.is_(True),
        )
    )


def primary_name(user: User) -> str:
    """The label to show for the primary user: their preferred display name,
    falling back to full name then the email local-part."""
    return (
        (user.display_name or "").strip()
        or (user.name or "").strip()
        or (user.email or "you").split("@")[0]
    )


def enroll_sample(db: Session, user: User, sample_text: str) -> SpeakerVoiceprint:
    """Create or update the user's primary voiceprint from a transcribed voice
    sample. New samples are merged into the existing centroid so the fingerprint
    sharpens over time. Commits and returns the row."""
    embedding = voiceprints.extract_text_embedding(sample_text)
    name = primary_name(user)
    vp = primary_for_user(db, user)
    if vp is None:
        vp = SpeakerVoiceprint(
            org_id=user.org_id,
            user_id=user.id,
            is_primary=True,
            canonical_name=name,
            email=user.email,
            embedding=embedding,
            sample_count=1,
        )
        db.add(vp)
    else:
        vp.embedding = voiceprints.merge_embeddings(
            vp.embedding or [], vp.sample_count or 0, embedding
        )
        vp.sample_count = (vp.sample_count or 0) + 1
        vp.canonical_name = name
        vp.email = user.email
        vp.updated_at = utcnow()
    db.commit()
    db.refresh(vp)
    return vp


def test_recognition(db: Session, user: User, sample_text: str) -> dict:
    """Compare a fresh sample against the user's stored voiceprint. Returns an
    honest similarity (0..1) and whether it clears the match threshold."""
    vp = primary_for_user(db, user)
    if vp is None or not vp.embedding:
        return {"enrolled": False, "similarity": 0.0, "recognized": False}
    sample = voiceprints.extract_text_embedding(sample_text)
    sim = voiceprints.cosine_similarity(sample, vp.embedding)
    return {
        "enrolled": True,
        "similarity": round(max(0.0, min(1.0, sim)), 3),
        "recognized": sim >= voiceprints.MATCH_THRESHOLD,
        "threshold": voiceprints.MATCH_THRESHOLD,
    }
