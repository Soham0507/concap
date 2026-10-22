"""Aggregation endpoint that merges every meeting an org can see into one
date-sorted list: Meeting-Intelligence documents, Imported Meetings, and
provider-created meetings (Zoom / Google Meet / Microsoft Teams, only while the
originating provider stays connected).

Kept in its own router (prefix ``/api/meetings``) so it can pull from both the
meetings-intelligence and imported-meetings domains without entangling either
router. Every query is scoped to ``user.org_id`` exactly like the source
routers — no cross-org leakage.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    CreatedMeeting,
    ImportedMeeting,
    MeetingDocument,
    Organization,
    User,
)
from ..services import meeting_oauth as oauth
from .auth import require_user

router = APIRouter(prefix="/api/meetings", tags=["meetings"])

# DB provider key -> normalized source tag exposed to the "All Meetings" UI.
_PROVIDER_SOURCE = {"zoom": "zoom", "google_meet": "google_meet", "ms_teams": "microsoft_teams"}
_SOURCE_PROVIDER = {v: k for k, v in _PROVIDER_SOURCE.items()}
_PROVIDER_SRCS = set(_PROVIDER_SOURCE.values())
_ALL_SOURCES = {"intelligence", "imported"} | _PROVIDER_SRCS


def _epoch(dt: datetime | None) -> float:
    """Comparable UTC epoch for sorting; naive datetimes are treated as UTC."""
    if dt is None:
        return 0.0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _iso(dt) -> str | None:
    if not dt:
        return None
    if isinstance(dt, str):
        return dt
    if dt.tzinfo is None:
        return dt.isoformat() + "Z"
    return dt.isoformat()


def _created_status(r: CreatedMeeting) -> str:
    if r.start_at:
        st = r.start_at if r.start_at.tzinfo else r.start_at.replace(tzinfo=timezone.utc)
        return "scheduled" if st > datetime.now(timezone.utc) else "completed"
    return "scheduled"


def _from_doc(d: MeetingDocument) -> dict:
    return {
        "id": d.id,
        "source": "intelligence",
        "title": d.meeting_title or "Untitled meeting",
        "date": d.meeting_date or _iso(d.created_at),
        "participants": len(d.participants or []),
        "status": d.status,
        "provider": d.meeting_source or None,
        "detail_url": f"/meetings?doc={d.id}",
        "_sort": _epoch(d.created_at),
    }


def _from_imported(m: ImportedMeeting) -> dict:
    return {
        "id": m.id,
        "source": "imported",
        "title": m.title or "Imported meeting",
        "date": _iso(m.started_at) or _iso(m.created_at),
        "participants": len(m.participants or []) or len(m.speakers or []),
        "status": m.status,
        "provider": m.provider,
        "detail_url": f"/imported-meetings?id={m.id}",
        "_sort": _epoch(m.started_at or m.created_at),
    }


def _from_created(r: CreatedMeeting) -> dict:
    return {
        "id": r.id,
        "source": _PROVIDER_SOURCE.get(r.provider, r.provider),
        "title": r.title or "Meeting",
        "date": _iso(r.start_at) or _iso(r.created_at),
        "participants": len(r.attendees or []) or len(r.invitations or []),
        "status": _created_status(r),
        "provider": r.provider,
        "detail_url": "/imported-meetings",
        "_sort": _epoch(r.start_at or r.created_at),
    }


@router.get("/all")
def list_all_meetings(
    source: str | None = Query(default=None),
    q: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """Merged, date-sorted (newest first) list of every meeting in the org."""
    src = source if source in _ALL_SOURCES else None
    items: list[dict] = []

    if src in (None, "intelligence"):
        docs = db.scalars(
            select(MeetingDocument).where(MeetingDocument.org_id == user.org_id)
        ).all()
        items += [_from_doc(d) for d in docs]

    if src in (None, "imported"):
        rows = db.scalars(
            select(ImportedMeeting).where(ImportedMeeting.org_id == user.org_id)
        ).all()
        items += [_from_imported(m) for m in rows]

    if src is None or src in _PROVIDER_SRCS:
        org = db.get(Organization, user.org_id) if user.org_id else None
        if org is not None:
            connected = [p for p in ("google_meet", "zoom", "ms_teams") if oauth.org_connected(org, p)]
            if src is not None:
                want = _SOURCE_PROVIDER.get(src)
                connected = [p for p in connected if p == want]
            if connected:
                crows = db.scalars(
                    select(CreatedMeeting).where(
                        CreatedMeeting.org_id == org.id,
                        CreatedMeeting.provider.in_(connected),
                    )
                ).all()
                items += [_from_created(r) for r in crows]

    if q and q.strip():
        needle = q.strip().lower()
        items = [it for it in items if needle in (it["title"] or "").lower()]

    items.sort(key=lambda it: it["_sort"], reverse=True)
    total = len(items)
    page = items[offset : offset + limit]
    for it in page:
        it.pop("_sort", None)
    return {"meetings": page, "total": total, "limit": limit, "offset": offset}
