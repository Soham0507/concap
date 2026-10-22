"""Background worker for Meeting Intelligence.

A single daemon thread polls the `meeting_intelligence_documents` table for
queued rows, claims one atomically (status -> processing + claimed_at +
attempts++), processes it (speech-to-text for audio docs, then GPT
extraction), and writes the terminal state. A reaper re-queues rows stuck in
`processing` longer than the stale threshold (e.g. a crash mid-process).

The worker owns its own DB sessions (it runs outside the request lifecycle).
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import timedelta
from pathlib import Path

from sqlalchemy import update

from ..database import SessionLocal
from ..models import MeetingBatch, MeetingDocument, utcnow
from .meeting_intelligence import MAX_ATTEMPTS, extract_document

logger = logging.getLogger("booth.meetings")

POLL_INTERVAL_S = 3.0
STALE_CLAIM_S = 600  # 10 min — a row processing longer than this is reaped.

_started = False
_lock = threading.Lock()


def start_worker() -> None:
    """Idempotently start the single background worker thread."""
    global _started
    with _lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_run_loop, name="meeting-worker", daemon=True).start()
    logger.info("Meeting intelligence worker started (poll=%ss)", POLL_INTERVAL_S)


def _run_loop() -> None:
    while True:
        try:
            _reap_stuck_claims()
            worked = _process_next()
            if not worked:
                time.sleep(POLL_INTERVAL_S)
        except Exception:  # noqa: BLE001 — never let the loop die
            logger.exception("Meeting worker tick failed; backing off")
            time.sleep(POLL_INTERVAL_S)


def _reap_stuck_claims() -> None:
    cutoff = utcnow() - timedelta(seconds=STALE_CLAIM_S)
    with SessionLocal() as db:
        rows = (
            db.query(MeetingDocument)
            .filter(
                MeetingDocument.status == "processing",
                MeetingDocument.claimed_at.is_not(None),
                MeetingDocument.claimed_at < cutoff,
            )
            .all()
        )
        if not rows:
            return
        for r in rows:
            r.status = "queued"
            r.claimed_at = None
        db.commit()
        logger.warning("Reaped %s stuck meeting-doc claim(s)", len(rows))


def _claim_next(db) -> MeetingDocument | None:
    """Atomically claim the oldest queued doc. Returns the claimed row or None.

    Uses an optimistic compare-and-set: pick a candidate id, then UPDATE it
    only while it's still `queued`. If a competing worker grabbed it first the
    rowcount is 0 and we retry. Works on both SQLite and Postgres.
    """
    for _ in range(5):
        candidate = (
            db.query(MeetingDocument.id)
            .filter(MeetingDocument.status == "queued")
            .order_by(MeetingDocument.created_at.asc())
            .first()
        )
        if candidate is None:
            return None
        doc_id = candidate[0]
        result = db.execute(
            update(MeetingDocument)
            .where(MeetingDocument.id == doc_id, MeetingDocument.status == "queued")
            .values(status="processing", claimed_at=utcnow(), attempts=MeetingDocument.attempts + 1)
        )
        db.commit()
        if result.rowcount and result.rowcount > 0:
            return db.get(MeetingDocument, doc_id)
    return None


def _process_next() -> bool:
    with SessionLocal() as db:
        doc = _claim_next(db)
        if doc is None:
            return False

        doc_id = doc.id
        batch_id = doc.batch_id
        try:
            transcript = _ensure_transcript(db, doc)
            if not transcript or len(transcript.strip()) < 20:
                raise RuntimeError(
                    "Transcript is empty or too short to extract (need >=20 chars)."
                )
            metadata = {
                "project_name": doc.project_name,
                "department": doc.department,
                "meeting_source": doc.meeting_source,
                "meeting_date": doc.meeting_date,
                "participants": doc.participants or [],
            }
            extracted = extract_document(transcript, metadata)

            doc.document_json = extracted["document_json"]
            doc.document_markdown = extracted["document_markdown"]
            doc.confidence_score = extracted["confidence_score"]
            doc.chunk_count = extracted["chunk_count"]
            doc.token_usage = extracted["token_usage"]
            doc.meeting_title = extracted["meeting_title"]
            doc.status = "completed"
            doc.error_message = None
            doc.claimed_at = None
            db.commit()
            logger.info("Meeting doc #%s completed", doc_id)
        except Exception as exc:  # noqa: BLE001 — store the failure, keep going
            db.rollback()
            fresh = db.get(MeetingDocument, doc_id)
            if fresh is not None:
                fresh.status = "failed"
                fresh.error_message = str(exc)[:2000]
                fresh.claimed_at = None
                db.commit()
            logger.warning("Meeting doc #%s failed: %s", doc_id, exc)

        if batch_id is not None:
            _recount_batch(db, batch_id)
        return True


def _ensure_transcript(db, doc: MeetingDocument) -> str:
    """Return the transcript text, transcribing the uploaded audio first if the
    doc is an audio upload that hasn't been transcribed yet."""
    if doc.transcript_text and doc.transcript_text.strip():
        return doc.transcript_text

    if doc.audio_path:
        # Lazy import — keeps speech-to-text deps out of the hot path for
        # text-only docs and avoids a heavy import at module load.
        from .transcription import render_diarized_transcript, transcribe_audio
        from .voice_identity import identify_speakers_for_user
        from ..models import User

        path = Path(doc.audio_path)
        if not path.exists():
            raise RuntimeError(f"Audio file is missing on disk: {doc.audio_path}")
        stt = transcribe_audio(path)
        plain = (stt.get("text") or "").strip()
        uploader = db.get(User, doc.user_id) if doc.user_id else None
        name_map = (
            identify_speakers_for_user(db, uploader, stt["speakers"])
            if stt.get("diarized") and stt.get("speakers")
            else {}
        )
        diarized = (
            render_diarized_transcript(stt["speakers"], name_map)
            if stt.get("diarized") and stt.get("speakers")
            else ""
        )
        transcript = diarized or plain
        # Persist so a later reprocess doesn't re-transcribe (and so the UI
        # can show the source transcript).
        doc.transcript_text = transcript
        db.commit()
        return transcript

    return doc.transcript_text or ""


def _recount_batch(db, batch_id: int) -> None:
    """Recompute a batch's rollup counters + lifecycle from its documents."""
    batch = db.get(MeetingBatch, batch_id)
    if batch is None:
        return
    docs = (
        db.query(MeetingDocument.status)
        .filter(MeetingDocument.batch_id == batch_id)
        .all()
    )
    statuses = [d[0] for d in docs]
    total = len(statuses)
    completed = sum(1 for s in statuses if s == "completed")
    failed = sum(1 for s in statuses if s == "failed")
    pending = total - completed - failed

    batch.total_count = total
    batch.completed_count = completed
    batch.failed_count = failed
    if pending > 0:
        batch.status = "running"
        batch.completed_at = None
    else:
        batch.status = "failed" if failed and not completed else "completed"
        batch.completed_at = utcnow()
    db.commit()
