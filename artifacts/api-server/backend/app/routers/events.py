"""Event category master: events with their days (Day 1, Day 2, ...).

Each org has its own list of events ("CES Las Vegas 2026", "Hannover Messe",
...). When uploading a transcript the user picks an event + a day so the
recording is filed under the right bucket. Adding a new day later is fine —
existing conversations keep their day_id, new ones can pick the new day.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..models import Conversation, Event, EventDay, User
from ..models import Session as LongCaptureSession
from .auth import require_user

router = APIRouter(prefix="/api/events", tags=["events"])


class EventDayOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_id: int
    day_number: int
    label: str | None = None
    event_date: datetime | None = None


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    location: str | None = None
    start_date: datetime | None = None
    created_at: datetime
    days: list[EventDayOut] = []


class EventCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    location: str | None = Field(default=None, max_length=200)
    # Number of days to seed (Day 1..N). Defaults to 1.
    day_count: int = Field(default=1, ge=1, le=30)
    # When Day 1 takes place. If set, each seeded EventDay gets its event_date
    # filled in as start_date + (day_number-1) days.
    start_date: datetime | None = None


class DayCreate(BaseModel):
    label: str | None = Field(default=None, max_length=100)
    event_date: datetime | None = None


@router.get("", response_model=list[EventOut])
def list_events(
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> list[Event]:
    rows = db.execute(
        select(Event)
        .options(selectinload(Event.days))
        .where(Event.org_id == user.org_id)
        .order_by(Event.created_at.desc())
    ).scalars().all()
    return list(rows)


@router.post("", response_model=EventOut, status_code=status.HTTP_201_CREATED)
def create_event(
    payload: EventCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> Event:
    ev = Event(
        org_id=user.org_id,
        name=payload.name.strip(),
        location=(payload.location or "").strip() or None,
        start_date=payload.start_date,
    )
    db.add(ev)
    db.flush()
    for i in range(1, payload.day_count + 1):
        day_date = (payload.start_date + timedelta(days=i - 1)) if payload.start_date else None
        db.add(EventDay(event_id=ev.id, day_number=i, label=f"Day {i}", event_date=day_date))
    db.commit()
    db.refresh(ev)
    return ev


@router.post("/{event_id}/days", response_model=EventDayOut, status_code=status.HTTP_201_CREATED)
def add_day(
    event_id: int,
    payload: DayCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> EventDay:
    ev = db.get(Event, event_id)
    if ev is None or ev.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Event not found")
    # Next day number = max+1 (skips gaps from any deleted days for clarity).
    existing = db.execute(
        select(EventDay.day_number).where(EventDay.event_id == event_id)
    ).scalars().all()
    next_num = (max(existing) if existing else 0) + 1
    day = EventDay(
        event_id=event_id,
        day_number=next_num,
        label=(payload.label or f"Day {next_num}"),
        event_date=payload.event_date,
    )
    db.add(day)
    db.commit()
    db.refresh(day)
    return day


@router.delete("/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_event(
    event_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> None:
    ev = db.get(Event, event_id)
    if ev is None or ev.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Event not found")
    # Belt + suspenders: explicitly null out conversations.event_day_id for
    # this event's days before deletion. Postgres has the FK ON DELETE SET
    # NULL constraint, but SQLite-legacy databases (which can't retro-add
    # FKs) need this manual sweep so deleting an event doesn't leave
    # dangling event_day_id values on existing conversations.
    day_ids = [d.id for d in ev.days]
    if day_ids:
        db.query(Conversation).filter(Conversation.event_day_id.in_(day_ids)).update(
            {Conversation.event_day_id: None}, synchronize_session=False
        )
        # Same sweep for long-capture sessions that referenced these days.
        db.query(LongCaptureSession).filter(
            LongCaptureSession.event_day_id.in_(day_ids)
        ).update({LongCaptureSession.event_day_id: None}, synchronize_session=False)
    db.delete(ev)
    db.commit()
