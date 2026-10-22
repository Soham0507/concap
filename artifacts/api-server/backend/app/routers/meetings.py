"""Meeting Intelligence routes — bulk transcript -> structured Minutes of
Meeting (MOM) with evidence quotes, plus a combined cross-meeting summary.

All routes are org-scoped (a doc/batch is visible to every member of the
creating user's org) and return 404 (not 403) on a tenancy mismatch to avoid
id enumeration. Heavy lifting happens in the background worker; the routes
only enqueue work and read state.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import update
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import MeetingBatch, MeetingDocument, User, utcnow
from ..services.meeting_intelligence import (
    MAX_ATTEMPTS,
    describe_openai_key_problem,
    generate_transcript_id,
)
from .auth import require_user

router = APIRouter(prefix="/api/meetings/intelligence", tags=["meetings"])

MAX_BULK = 2_500
ALLOWED_AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".mp4", ".webm", ".ogg", ".flac"}
ALLOWED_TEXT_EXTS = {".txt", ".md", ".vtt", ".srt"}
AUDIO_MAX_MB = 800
TEXT_MAX_MB = 15  # a 15 MB transcript is already enormous; bound memory hard.


async def _read_text_capped(f: UploadFile, max_bytes: int) -> bytes | None:
    """Stream an uploaded text file into memory, aborting (returns None) once
    it exceeds `max_bytes`. Prevents a huge upload from OOM-ing the process the
    way a single unbounded ``await f.read()`` would."""
    buf = bytearray()
    while chunk := await f.read(1024 * 1024):
        buf.extend(chunk)
        if len(buf) > max_bytes:
            return None
    return bytes(buf)


def _require_key() -> None:
    problem = describe_openai_key_problem()
    if problem:
        raise HTTPException(status_code=400, detail=problem)


# --- request bodies -------------------------------------------------------

class ProcessIn(BaseModel):
    transcript_text: str
    project_name: str | None = None
    department: str | None = None
    meeting_source: str
    meeting_date: str | None = None
    participants: list[str] = Field(default_factory=list)
    transcript_id: str | None = None


class BulkItem(BaseModel):
    transcript_text: str
    transcript_id: str | None = None
    project_name: str | None = None
    department: str | None = None
    meeting_source: str | None = None
    meeting_date: str | None = None
    participants: list[str] = Field(default_factory=list)


class BulkIn(BaseModel):
    label: str | None = None
    default_meeting_source: str | None = None
    transcripts: list[BulkItem]


# --- serializers ----------------------------------------------------------

def _doc_out(doc: MeetingDocument, include_transcript: bool = False) -> dict:
    out = {
        "id": doc.id,
        "batch_id": doc.batch_id,
        "transcript_id": doc.transcript_id,
        "project_name": doc.project_name,
        "department": doc.department,
        "meeting_source": doc.meeting_source,
        "meeting_date": doc.meeting_date,
        "meeting_title": doc.meeting_title,
        "external_id": doc.external_id,
        "source_summary": doc.source_summary,
        "participants": doc.participants or [],
        "document_json": doc.document_json,
        "document_markdown": doc.document_markdown,
        "confidence_score": doc.confidence_score,
        "status": doc.status,
        "error_message": doc.error_message,
        "chunk_count": doc.chunk_count,
        "has_audio": bool(doc.audio_path),
        "created_at": (doc.created_at.isoformat() + "Z") if doc.created_at else None,
        "updated_at": (doc.updated_at.isoformat() + "Z") if doc.updated_at else None,
    }
    if include_transcript:
        out["transcript_text"] = doc.transcript_text
    return out


def _batch_out(batch: MeetingBatch) -> dict:
    return {
        "id": batch.id,
        "label": batch.label,
        "default_source": batch.default_source,
        "status": batch.status,
        "total_count": batch.total_count,
        "completed_count": batch.completed_count,
        "failed_count": batch.failed_count,
        "completed_at": (batch.completed_at.isoformat() + "Z") if batch.completed_at else None,
        "created_at": (batch.created_at.isoformat() + "Z") if batch.created_at else None,
        "updated_at": (batch.updated_at.isoformat() + "Z") if batch.updated_at else None,
    }


def _get_owned_doc(db: Session, user: User, doc_id: int) -> MeetingDocument:
    doc = db.get(MeetingDocument, doc_id)
    if doc is None or doc.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Not found")
    return doc


def _get_owned_batch(db: Session, user: User, batch_id: int) -> MeetingBatch:
    batch = db.get(MeetingBatch, batch_id)
    if batch is None or batch.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Not found")
    return batch


# --- single transcript ----------------------------------------------------

@router.post("/process", status_code=201)
def process_transcript(
    body: ProcessIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    _require_key()
    text = (body.transcript_text or "").strip()
    if len(text) < 20:
        raise HTTPException(status_code=400, detail="transcript_text is required (>=20 chars)")
    source = (body.meeting_source or "").strip()
    if not source:
        raise HTTPException(status_code=400, detail="meeting_source is required")

    participants = [p.strip() for p in (body.participants or []) if isinstance(p, str) and p.strip()]
    doc = MeetingDocument(
        org_id=user.org_id,
        user_id=user.id,
        transcript_id=(body.transcript_id or "").strip() or generate_transcript_id(),
        project_name=(body.project_name or "").strip() or None,
        department=(body.department or "").strip() or None,
        meeting_source=source,
        meeting_date=(body.meeting_date or "").strip() or None,
        participants=participants,
        transcript_text=text,
        status="queued",
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return _doc_out(doc, include_transcript=True)


@router.get("/documents")
def list_documents(
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> list[dict]:
    docs = (
        db.query(MeetingDocument)
        .filter(MeetingDocument.org_id == user.org_id)
        .order_by(MeetingDocument.created_at.desc())
        .limit(limit)
        .all()
    )
    return [_doc_out(d) for d in docs]


@router.get("/documents/{doc_id}")
def get_document(
    doc_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    doc = _get_owned_doc(db, user, doc_id)
    return _doc_out(doc, include_transcript=True)


@router.post("/documents/{doc_id}/reprocess")
def reprocess_document(
    doc_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    _require_key()
    doc = _get_owned_doc(db, user, doc_id)

    # Idempotent: already in flight -> just acknowledge.
    if doc.status in {"queued", "processing"}:
        return {"requeued": False, "already_queued": True, "document_id": doc_id, "status": doc.status}

    result = db.execute(
        update(MeetingDocument)
        .where(
            MeetingDocument.id == doc_id,
            MeetingDocument.org_id == user.org_id,
            MeetingDocument.status.in_(["completed", "failed"]),
        )
        .values(
            status="queued",
            document_json=None,
            document_markdown=None,
            confidence_score=None,
            error_message=None,
            claimed_at=None,
            attempts=0,
            updated_at=utcnow(),
        )
    )
    db.commit()
    if not result.rowcount:
        return {"requeued": False, "already_queued": False, "document_id": doc_id, "status": doc.status}

    if doc.batch_id is not None:
        batch = db.get(MeetingBatch, doc.batch_id)
        if batch is not None:
            batch.status = "running"
            batch.completed_at = None
            db.commit()
    return {"requeued": True, "document_id": doc_id}


# --- batches (JSON bulk text) ---------------------------------------------

@router.post("/batches", status_code=201)
def create_batch(
    body: BulkIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    _require_key()
    items = body.transcripts or []
    if not items:
        raise HTTPException(status_code=400, detail="transcripts must be a non-empty array")
    if len(items) > MAX_BULK:
        raise HTTPException(
            status_code=400,
            detail=f"Too many transcripts in one request. Cap is {MAX_BULK}; chunk client-side.",
        )

    default_source = (body.default_meeting_source or "text").strip() or "text"
    batch = MeetingBatch(
        org_id=user.org_id,
        user_id=user.id,
        label=(body.label or "").strip() or None,
        default_source=default_source,
        status="queued",
        total_count=0,
    )
    db.add(batch)
    db.flush()

    created = 0
    for item in items:
        text = (item.transcript_text or "").strip()
        if len(text) < 20:
            continue  # skip junk rows rather than failing the whole batch
        participants = [p.strip() for p in (item.participants or []) if isinstance(p, str) and p.strip()]
        db.add(MeetingDocument(
            org_id=user.org_id,
            user_id=user.id,
            batch_id=batch.id,
            transcript_id=(item.transcript_id or "").strip() or generate_transcript_id(),
            project_name=(item.project_name or "").strip() or None,
            department=(item.department or "").strip() or None,
            meeting_source=(item.meeting_source or "").strip() or default_source,
            meeting_date=(item.meeting_date or "").strip() or None,
            participants=participants,
            transcript_text=text,
            status="queued",
        ))
        created += 1

    if created == 0:
        db.rollback()
        raise HTTPException(status_code=400, detail="No valid transcripts (each needs >=20 chars).")

    batch.total_count = created
    batch.status = "running"
    db.commit()
    db.refresh(batch)
    return {"batch": _batch_out(batch), "enqueued": created}


# --- batches (multipart upload: text AND audio files) ---------------------

@router.post("/batches/upload", status_code=201)
async def upload_batch(
    files: list[UploadFile] = File(...),
    label: str | None = Form(default=None),
    project_name: str | None = Form(default=None),
    department: str | None = Form(default=None),
    meeting_source: str | None = Form(default=None),
    meeting_date: str | None = Form(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    _require_key()
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")
    if len(files) > MAX_BULK:
        raise HTTPException(status_code=400, detail=f"Too many files. Cap is {MAX_BULK}.")

    settings = get_settings()
    default_source = (meeting_source or "").strip() or "upload"

    batch = MeetingBatch(
        org_id=user.org_id,
        user_id=user.id,
        label=(label or "").strip() or None,
        default_source=default_source,
        status="queued",
        total_count=0,
    )
    db.add(batch)
    db.flush()

    target_dir = settings.audio_path / "meetings"
    target_dir.mkdir(parents=True, exist_ok=True)

    created = 0
    skipped: list[str] = []
    for f in files:
        filename = f.filename or "upload"
        suffix = Path(filename).suffix.lower()
        title_stem = Path(filename).stem or "Meeting"

        if suffix in ALLOWED_TEXT_EXTS:
            raw = await _read_text_capped(f, TEXT_MAX_MB * 1024 * 1024)
            if raw is None:
                skipped.append(f"{filename} (exceeds {TEXT_MAX_MB} MB)")
                continue
            try:
                text = raw.decode("utf-8", errors="replace").strip()
            except Exception:  # noqa: BLE001
                text = ""
            if len(text) < 20:
                skipped.append(f"{filename} (empty/too short)")
                continue
            db.add(MeetingDocument(
                org_id=user.org_id,
                user_id=user.id,
                batch_id=batch.id,
                transcript_id=generate_transcript_id(),
                project_name=(project_name or "").strip() or None,
                department=(department or "").strip() or None,
                meeting_source=(meeting_source or "").strip() or "text",
                meeting_date=(meeting_date or "").strip() or None,
                participants=[],
                meeting_title=title_stem,
                transcript_text=text,
                status="queued",
            ))
            created += 1
        elif suffix in ALLOWED_AUDIO_EXTS:
            target_path = target_dir / f"mtg_{uuid.uuid4().hex}{suffix}"
            max_bytes = AUDIO_MAX_MB * 1024 * 1024
            written = 0
            async with aiofiles.open(target_path, "wb") as out:
                while chunk := await f.read(4 * 1024 * 1024):
                    written += len(chunk)
                    if written > max_bytes:
                        await out.close()
                        target_path.unlink(missing_ok=True)
                        skipped.append(f"{filename} (exceeds {AUDIO_MAX_MB} MB)")
                        written = -1
                        break
                    await out.write(chunk)
            if written <= 0:
                if written == 0:
                    target_path.unlink(missing_ok=True)
                    skipped.append(f"{filename} (empty)")
                continue
            db.add(MeetingDocument(
                org_id=user.org_id,
                user_id=user.id,
                batch_id=batch.id,
                transcript_id=generate_transcript_id(),
                project_name=(project_name or "").strip() or None,
                department=(department or "").strip() or None,
                meeting_source=(meeting_source or "").strip() or "audio",
                meeting_date=(meeting_date or "").strip() or None,
                participants=[],
                meeting_title=title_stem,
                audio_path=str(target_path),
                status="queued",
            ))
            created += 1
        else:
            skipped.append(f"{filename} (unsupported type {suffix})")

    if created == 0:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail="No usable files. " + ("; ".join(skipped) if skipped else "Provide text or audio files."),
        )

    batch.total_count = created
    batch.status = "running"
    db.commit()
    db.refresh(batch)
    return {"batch": _batch_out(batch), "enqueued": created, "skipped": skipped}


@router.get("/batches")
def list_batches(
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> list[dict]:
    batches = (
        db.query(MeetingBatch)
        .filter(MeetingBatch.org_id == user.org_id)
        .order_by(MeetingBatch.created_at.desc())
        .limit(limit)
        .all()
    )
    return [_batch_out(b) for b in batches]


@router.get("/batches/{batch_id}")
def get_batch(
    batch_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    batch = _get_owned_batch(db, user, batch_id)
    docs = (
        db.query(MeetingDocument)
        .filter(MeetingDocument.batch_id == batch_id)
        .order_by(MeetingDocument.created_at.desc())
        .all()
    )
    return {"batch": _batch_out(batch), "documents": [_doc_out(d) for d in docs]}


@router.post("/batches/{batch_id}/retry")
def retry_batch(
    batch_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    _require_key()
    _get_owned_batch(db, user, batch_id)
    result = db.execute(
        update(MeetingDocument)
        .where(
            MeetingDocument.batch_id == batch_id,
            MeetingDocument.org_id == user.org_id,
            MeetingDocument.status == "failed",
            MeetingDocument.attempts < MAX_ATTEMPTS,
        )
        .values(status="queued", claimed_at=None, error_message=None, updated_at=utcnow())
    )
    db.commit()
    requeued = result.rowcount or 0
    if requeued:
        batch = db.get(MeetingBatch, batch_id)
        if batch is not None:
            batch.status = "running"
            batch.completed_at = None
            db.commit()
    return {"requeued": requeued}


# --- combined cross-meeting summary ---------------------------------------

def _aggregate_list(completed: list[MeetingDocument], list_key: str) -> list[dict]:
    acc: dict[str, dict] = {}
    for d in completed:
        j = d.document_json or {}
        items = j.get(list_key) if isinstance(j.get(list_key), list) else []
        quotes = (j.get("evidence_quotes") or {}).get(list_key) or []
        for i, text in enumerate(items):
            if not isinstance(text, str) or not text.strip():
                continue
            key = text.lower().strip()
            quote = quotes[i] if i < len(quotes) and isinstance(quotes[i], str) and quotes[i].strip() else None
            source = {
                "doc_id": d.id,
                "transcript_id": d.transcript_id,
                "meeting_title": d.meeting_title,
                "quote": quote,
            }
            if key in acc:
                acc[key]["sources"].append(source)
            else:
                acc[key] = {"text": text, "sources": [source]}
    return sorted(acc.values(), key=lambda x: len(x["sources"]), reverse=True)


def _aggregate_actions(completed: list[MeetingDocument]) -> list[dict]:
    acc: dict[str, dict] = {}
    for d in completed:
        j = d.document_json or {}
        actions = j.get("action_items") if isinstance(j.get("action_items"), list) else []
        for a in actions:
            if not isinstance(a, dict):
                continue
            task = str(a.get("task") or "").strip()
            if not task:
                continue
            owner = str(a.get("owner") or "Pending").strip()
            key = f"{task.lower()}|{owner.lower()}"
            quote = a.get("source_quote") if isinstance(a.get("source_quote"), str) and a.get("source_quote").strip() else None
            source = {
                "doc_id": d.id,
                "transcript_id": d.transcript_id,
                "meeting_title": d.meeting_title,
                "quote": quote,
            }
            if key in acc:
                acc[key]["sources"].append(source)
            else:
                acc[key] = {
                    "task": task,
                    "owner": owner,
                    "deadline": str(a.get("deadline") or "Pending").strip(),
                    "status": str(a.get("status") or "Open").strip(),
                    "sources": [source],
                }
    return sorted(acc.values(), key=lambda x: len(x["sources"]), reverse=True)


@router.get("/batches/{batch_id}/summary")
def batch_summary(
    batch_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    batch = _get_owned_batch(db, user, batch_id)
    docs = (
        db.query(MeetingDocument)
        .filter(MeetingDocument.batch_id == batch_id)
        .order_by(MeetingDocument.created_at.desc())
        .all()
    )
    completed = [d for d in docs if d.status == "completed"]

    sources = [{
        "doc_id": d.id,
        "transcript_id": d.transcript_id,
        "meeting_title": d.meeting_title,
        "meeting_date": d.meeting_date,
        "source": d.meeting_source,
    } for d in completed]

    list_keys = ("discussion_points", "decisions_taken", "risks", "pending_clarifications", "next_steps")
    aggregated = {k: _aggregate_list(completed, k) for k in list_keys}
    action_items = _aggregate_actions(completed)

    executive_summaries = []
    for d in completed:
        summary = str((d.document_json or {}).get("executive_summary") or "").strip()
        if summary:
            executive_summaries.append({
                "doc_id": d.id,
                "transcript_id": d.transcript_id,
                "meeting_title": d.meeting_title,
                "summary": summary,
            })

    def _cited(arr: list[dict]) -> int:
        return sum(1 for it in arr if any(s.get("quote") for s in it["sources"]))

    cited_count = sum(_cited(aggregated[k]) for k in list_keys) + _cited(action_items)
    confidence = (
        sum(d.confidence_score if d.confidence_score is not None else 0.5 for d in completed) / len(completed)
        if completed else 0.0
    )

    return {
        "batch": _batch_out(batch),
        "sources": sources,
        "summary": {
            **aggregated,
            "action_items": action_items,
            "executive_summaries": executive_summaries,
            "confidence": confidence,
            "cited_count": cited_count,
            "total_docs": len(completed),
        },
    }
