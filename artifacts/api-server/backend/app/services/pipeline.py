"""End-to-end pipeline for a single conversation: transcribe -> analyze -> persist."""
from pathlib import Path

from sqlalchemy.orm import Session

from sqlalchemy import select

from ..models import ActionItem, Company, Conversation, Organization, Visitor
from .analysis import analyze_transcript
from .embeddings import embed_text
from .transcription import render_diarized_transcript, transcribe_audio
from .voice_identity import identify_speakers


def process_conversation(db: Session, conversation_id: int) -> None:
    """Run the full pipeline. Updates conversation status as it progresses.

    Designed to run in a FastAPI BackgroundTask. Errors are caught and
    persisted to conversation.error_message so the UI can surface them.
    """
    conv = db.get(Conversation, conversation_id)
    if conv is None:
        return

    audio_path = Path(conv.audio_filename) if conv.audio_filename else None
    have_audio = audio_path is not None and audio_path.exists()
    have_transcript = bool((conv.transcript or "").strip())

    # Nothing to work with: no audio on disk and no prior transcript to analyze.
    if not have_audio and not have_transcript:
        conv.status = "error"
        conv.error_message = (
            f"Audio file missing: {audio_path}" if audio_path
            else "No audio attached to this conversation"
        )
        db.commit()
        return

    try:
        stt: dict = {}
        if have_audio:
            conv.status = "transcribing"
            db.commit()

            stt = transcribe_audio(audio_path)

            # Prefer the speaker-labeled rendering when diarization is available;
            # it's what the user sees on the dashboard and what GPT consumes.
            plain_text = stt.get("text") or ""
            name_map = (
                identify_speakers(db, conv.org_id, stt["speakers"])
                if stt.get("diarized") and stt.get("speakers")
                else {}
            )
            diarized_text = (
                render_diarized_transcript(stt["speakers"], name_map)
                if stt.get("diarized") and stt.get("speakers")
                else ""
            )
            conv.transcript = diarized_text or plain_text
            conv.transcript_language = stt.get("language")
            if stt.get("duration") is not None:
                conv.duration_seconds = stt["duration"]
            db.commit()
        # else: the audio is gone (e.g. ephemeral storage cleared on redeploy)
        # but we already have a transcript — re-run analysis on the existing
        # transcript instead of failing the whole conversation.

        conv.status = "analyzing"
        db.commit()

        visitor = db.get(Visitor, conv.visitor_id)
        visitor_ctx = {
            "name": visitor.name if visitor else None,
            "company": visitor.company if visitor else None,
            "designation": visitor.designation if visitor else None,
            "industry": visitor.industry if visitor else None,
            "interest_category": visitor.interest_category if visitor else None,
            "diarized": bool(stt.get("diarized")),
            "speaker_count": stt.get("speaker_count", 0),
            "stt_provider": stt.get("provider"),
        }

        # Feed GPT the speaker-labeled text when we have it.
        analysis = analyze_transcript(conv.transcript or "", visitor_context=visitor_ctx)
        conv.analysis = analysis
        conv.lead_score = analysis.get("lead_score")
        conv.lead_temperature = analysis.get("lead_temperature")
        conv.topic = (analysis.get("topic") or "").strip()[:200] or None
        _persist_action_items(db, conv, analysis.get("action_items") or [])
        _populate_embedding(db, conv, analysis)
        _auto_link_company(db, conv, analysis)
        conv.status = "analyzed"
        conv.error_message = None
        db.commit()

        # Auto-sync to HubSpot once analysis is complete. Best-effort
        # only — the wrapper swallows errors and persists them onto the
        # conversation row so a flaky CRM never breaks our pipeline.
        _maybe_hubspot_sync(db, conv.id)
        # Same for Salesforce — independent per-org connection + toggle.
        _maybe_salesforce_sync(db, conv.id)
    except Exception as exc:  # noqa: BLE001 — capture any provider error for the UI
        conv.status = "error"
        conv.error_message = str(exc)[:1000]
        db.commit()


def _maybe_hubspot_sync(db: Session, conversation_id: int) -> None:
    """Fire-and-forget HubSpot sync after analysis. Gated per-org: only orgs
    that have connected HubSpot via OAuth (and have auto-sync on) are synced.
    There is no shared/global token fallback. Imported lazily to avoid pulling
    httpx during unrelated unit imports."""
    conv = db.get(Conversation, conversation_id)
    if conv is None:
        return
    org = db.get(Organization, conv.org_id) if conv.org_id else None

    from .hubspot_oauth import auto_sync_enabled, org_connected

    # Only orgs that connected their own HubSpot portal auto-sync. There is no
    # shared global token: an unconnected org simply doesn't sync.
    if not org_connected(org) or not auto_sync_enabled(org):
        return

    try:
        from .hubspot import sync_conversation_safe
        sync_conversation_safe(db, conversation_id)
    except Exception:  # noqa: BLE001
        # Already logged inside sync_conversation_safe; swallow anything
        # that escapes so the pipeline stays in 'analyzed' state.
        pass


def _maybe_salesforce_sync(db: Session, conversation_id: int) -> None:
    """Fire-and-forget Salesforce sync after analysis. Gated per-org: only orgs
    that have connected Salesforce via OAuth (and have auto-sync on) are synced.
    There is no shared/global token fallback. Imported lazily to avoid pulling
    httpx during unrelated unit imports."""
    conv = db.get(Conversation, conversation_id)
    if conv is None:
        return
    org = db.get(Organization, conv.org_id) if conv.org_id else None

    from .salesforce_oauth import auto_sync_enabled, org_connected

    # Only orgs that connected their own Salesforce org auto-sync. There is no
    # shared global token: an unconnected org simply doesn't sync.
    if not org_connected(org) or not auto_sync_enabled(org):
        return

    try:
        from .salesforce import sync_conversation_safe
        sync_conversation_safe(db, conversation_id)
    except Exception:  # noqa: BLE001
        # Already logged inside sync_conversation_safe; swallow anything
        # that escapes so the pipeline stays in 'analyzed' state.
        pass


def _persist_action_items(db: Session, conv: Conversation, tasks: list) -> None:
    """Mirror GPT-extracted action items into the dedicated table.

    Replaces any existing items for this conversation so re-running the
    pipeline produces a clean list rather than stacking duplicates.
    """
    db.query(ActionItem).filter(ActionItem.conversation_id == conv.id).delete()
    for raw in tasks:
        task = str(raw).strip()
        if not task:
            continue
        db.add(ActionItem(
            org_id=conv.org_id,
            conversation_id=conv.id,
            task=task[:1000],
            status="open",
        ))


def _auto_link_company(db: Session, conv: Conversation, analysis: dict) -> None:
    """If the transcript isn't already linked to a company, try to match
    the GPT-suggested company name to an existing Company row in the same
    org by case-insensitive name. We never *create* a Company here — only
    auto-link when there's an unambiguous existing match — so the UI can
    still surface "Suggested: Acme [Create + link]" for unknown names.
    """
    if conv.company_id is not None:
        return
    suggested = str(analysis.get("suggested_company") or "").strip()
    if not suggested:
        return
    match = db.scalar(
        select(Company).where(
            Company.org_id == conv.org_id,
            Company.name.ilike(suggested),
        )
    )
    if match is not None:
        conv.company_id = match.id


def _populate_embedding(db: Session, conv: Conversation, analysis: dict) -> None:
    """Embed the analysed conversation so semantic search can find it.

    Combines the GPT summary (concentrated meaning) with the transcript head
    (raw signal in case the summary missed something). Errors are swallowed
    — failing to embed should not fail the whole pipeline.
    """
    summary = (analysis.get("summary") or "").strip()
    transcript_head = (conv.transcript or "")[:3500]
    blob = f"{summary}\n\n{transcript_head}".strip()
    if not blob:
        return
    try:
        conv.embedding = embed_text(blob)
    except Exception:  # noqa: BLE001
        # Search will simply skip rows without an embedding; that's fine.
        conv.embedding = None
