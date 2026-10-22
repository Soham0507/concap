"""Transcript fetchers for the meeting-import providers.

Each ``fetch_*`` returns a list of normalized meeting dicts:
``{external_id, title, started_at (datetime|None), participants: [str],
transcript: str, utterances: [{speaker, text, start, end}]}``.

These call the live provider REST APIs and therefore can only be exercised
end-to-end with real connected accounts. They are deliberately defensive: any
single recording that fails to fetch is skipped rather than aborting the sync.
Token resolution/refresh is delegated to ``meeting_oauth``.
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy.orm import Session

from ..models import Organization
from . import meeting_oauth
from .conversation_parsers import transcript_to_utterances

logger = logging.getLogger("concap.meeting.providers")

_HTTP_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
ZOOM_API = "https://api.zoom.us/v2"
GRAPH_API = "https://graph.microsoft.com/v1.0"
MEET_API = "https://meet.googleapis.com/v2"
CALENDAR_API = "https://www.googleapis.com/calendar/v3"


def _iso_to_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def _vtt_or_text_to_utterances(text: str) -> list[dict]:
    """Cue-based transcripts come as VTT; fall back to line parsing otherwise."""
    return transcript_to_utterances(text, kind="srt")


def _utterances_to_transcript(utterances: list[dict]) -> str:
    return "\n".join(f"{u['speaker']}: {u['text']}" for u in utterances if u.get("text"))


# --------------------------------------------------------------------------- #
# Zoom
# --------------------------------------------------------------------------- #


def _zoom_recordings_error(exc: Exception, resp: httpx.Response | None) -> meeting_oauth.MeetingOAuthError:
    """Map a Zoom recordings-list failure to a user-facing message. Zoom hides the
    real reason behind a bare ``400 Bad Request``; the JSON body carries a
    ``{code, message}`` that we surface so the user can act on it. The two common
    definitive cases here (neither retryable):
      - HTTP 400 + code 200 ``Only available for Paid account`` — Basic/free Zoom
        plans have no cloud recording, so there is nothing to import.
      - HTTP 401/403 — the connected Zoom app is missing the
        ``cloud_recording:read`` scope; reconnect after enabling it."""
    status = getattr(resp, "status_code", None)
    code = message = None
    if resp is not None:
        try:
            body = resp.json()
            code = body.get("code")
            message = body.get("message")
        except (ValueError, AttributeError):
            message = (resp.text or "").strip() or None
    if status in (401, 403):
        return meeting_oauth.MeetingOAuthError(
            "Zoom refused access to your recordings — the connected Zoom app is "
            "missing the 'cloud_recording:read' scope. Reconnect Zoom after "
            "enabling it" + (f" ({message})." if message else ".")
        )
    if status == 400:
        if code == 200 or (message and "paid account" in message.lower()):
            return meeting_oauth.MeetingOAuthError(
                "Zoom cloud recordings require a paid Zoom plan. The connected "
                "account is on a Basic (free) plan, which has no cloud recordings "
                "to import."
            )
        return meeting_oauth.MeetingOAuthError(
            f"Zoom rejected the recordings request: {message or exc}"
        )
    # Network errors / 5xx / 429: retryable.
    return meeting_oauth.MeetingOAuthError(
        f"Zoom recordings list failed: {message or exc}", transient=True
    )


def fetch_zoom(db: Session, org: Organization, since_days: int = 30, limit: int = 20) -> list[dict]:
    token = meeting_oauth.get_valid_access_token(db, org, "zoom")
    headers = {"Authorization": f"Bearer {token}"}
    now = datetime.now(timezone.utc)
    # Zoom rejects (400) a recordings query whose from/to span exceeds one month,
    # so clamp the window to <= 30 days and always send an explicit ``to`` date —
    # this keeps larger ``since_days`` values (the router allows up to 365) from
    # silently 400ing.
    window = min(max(int(since_days), 1), 30)
    frm = (now - timedelta(days=window)).strftime("%Y-%m-%d")
    to = now.strftime("%Y-%m-%d")
    out: list[dict] = []
    resp = None
    try:
        resp = httpx.get(
            f"{ZOOM_API}/users/me/recordings",
            headers=headers,
            params={"from": frm, "to": to, "page_size": min(limit, 30)},
            timeout=_HTTP_TIMEOUT,
        )
        resp.raise_for_status()
        meetings = resp.json().get("meetings", [])
    except (httpx.HTTPError, ValueError) as exc:
        raise _zoom_recordings_error(exc, resp) from exc

    for meeting in meetings[:limit]:
        files = meeting.get("recording_files") or []
        transcript_file = next(
            (f for f in files if f.get("file_type") == "TRANSCRIPT" and f.get("status") == "completed"), None
        ) or next(
            (f for f in files if f.get("recording_type") == "audio_transcript" and f.get("status") == "completed"), None
        ) or next(
            (f for f in files if f.get("file_type") == "CC" and f.get("status") == "completed"), None
        )
        if not transcript_file or not transcript_file.get("download_url"):
            continue
        try:
            dl = httpx.get(
                transcript_file["download_url"],
                headers=headers,
                timeout=_HTTP_TIMEOUT,
                follow_redirects=True,
            )
            if dl.status_code != 200:
                continue
            raw = dl.text
        except httpx.HTTPError:
            continue
        utterances = _vtt_or_text_to_utterances(raw)
        if not utterances:
            continue
        out.append({
            "external_id": str(meeting.get("uuid") or meeting.get("id")),
            "title": meeting.get("topic") or "Zoom meeting",
            "started_at": _iso_to_dt(meeting.get("start_time")),
            "participants": [],
            "transcript": _utterances_to_transcript(utterances),
            "utterances": utterances,
        })
    return out


def _zoom_meetings_error(exc: Exception, resp: httpx.Response | None) -> meeting_oauth.MeetingOAuthError:
    """Map a Zoom *meeting-list* (history) failure to a user-facing message.
    Unlike recordings, listing meetings only needs ``meeting:read`` and works on
    Basic (free) plans — so the common failure here is a missing/expired scope
    (401/403, non-retryable: reconnect) rather than a paid-plan gate."""
    status = getattr(resp, "status_code", None)
    message = None
    if resp is not None:
        try:
            message = resp.json().get("message")
        except (ValueError, AttributeError):
            message = (resp.text or "").strip() or None
    if status in (401, 403):
        return meeting_oauth.MeetingOAuthError(
            "Zoom refused access to your meetings — the connected Zoom app is "
            "missing the 'meeting:read' scope. Reconnect Zoom after enabling it"
            + (f" ({message})." if message else ".")
        )
    if status == 400:
        return meeting_oauth.MeetingOAuthError(
            f"Zoom rejected the meetings request: {message or exc}"
        )
    return meeting_oauth.MeetingOAuthError(
        f"Zoom meetings list failed: {message or exc}", transient=True
    )


def _zoom_host(headers: dict) -> dict:
    """Best-effort fetch of the connected Zoom user (for host name/email).
    Returns ``{name, email}`` — both ``None`` if the lookup fails."""
    try:
        resp = httpx.get(f"{ZOOM_API}/users/me", headers=headers, timeout=_HTTP_TIMEOUT)
        if resp.status_code != 200:
            return {"name": None, "email": None}
        body = resp.json()
    except (httpx.HTTPError, ValueError):
        return {"name": None, "email": None}
    name = " ".join(p for p in (body.get("first_name"), body.get("last_name")) if p).strip()
    return {"name": name or None, "email": body.get("email")}


def _zoom_meeting_row(meeting: dict, status: str, host: dict) -> dict:
    """Normalize one Zoom meeting-list entry into our metadata shape."""
    started_at = _iso_to_dt(meeting.get("start_time"))
    duration = meeting.get("duration")
    try:
        duration = int(duration) if duration is not None else None
    except (TypeError, ValueError):
        duration = None
    end_at = started_at + timedelta(minutes=duration) if (started_at and duration) else None
    return {
        "external_id": str(meeting.get("uuid") or meeting.get("id") or "") or None,
        "title": meeting.get("topic") or "Zoom meeting",
        "host_name": host.get("name"),
        "host_email": host.get("email"),
        "participants": [],
        "started_at": started_at,
        "ended_at": end_at,
        "duration_minutes": duration,
        "status": status,
        "join_url": meeting.get("join_url"),
    }


def fetch_zoom_meetings(db: Session, org: Organization, since_days: int = 30, limit: int = 50) -> list[dict]:
    """Import Zoom meeting HISTORY metadata (no recordings/transcripts).

    Pulls both already-held ("previous_meetings" → completed) and upcoming
    ("scheduled") meetings via ``GET /users/me/meetings`` — which only needs the
    ``meeting:read`` scope and works on free plans. Returns normalized metadata
    dicts; participant lists stay empty (the list endpoint doesn't expose them
    and the per-meeting participant report requires a paid/report scope)."""
    token = meeting_oauth.get_valid_access_token(db, org, "zoom")
    headers = {"Authorization": f"Bearer {token}"}
    host = _zoom_host(headers)
    page_size = min(max(int(limit), 1), 300)
    # Only completed (past) meetings are constrained to the look-back window;
    # upcoming "scheduled" meetings are always relevant regardless of since_days.
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(int(since_days), 1))

    rows: list[dict] = []
    seen: set[str] = set()
    # Completed first (most useful history), then upcoming scheduled.
    for zoom_type, status in (("previous_meetings", "completed"), ("scheduled", "scheduled")):
        resp = None
        try:
            resp = httpx.get(
                f"{ZOOM_API}/users/me/meetings",
                headers=headers,
                params={"type": zoom_type, "page_size": page_size},
                timeout=_HTTP_TIMEOUT,
            )
            resp.raise_for_status()
            meetings = resp.json().get("meetings", []) or []
        except (httpx.HTTPError, ValueError) as exc:
            # A bad scope/expired token affects both calls — surface it. An empty
            # "previous_meetings" set is returned as 200 with [], not an error.
            raise _zoom_meetings_error(exc, resp) from exc
        for meeting in meetings:
            row = _zoom_meeting_row(meeting, status, host)
            if status == "completed" and not _within_window(row.get("started_at"), cutoff):
                continue
            ext = row.get("external_id")
            key = ext or f"{row['title']}|{row['started_at']}"
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
            if len(rows) >= limit:
                return rows
    return rows


def _within_window(started_at: datetime | None, cutoff: datetime) -> bool:
    """True if a completed meeting falls inside the look-back window. Meetings
    with no parseable start time are kept (better to show than silently drop)."""
    if started_at is None:
        return True
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    return started_at >= cutoff


def create_zoom_meeting(
    db: Session,
    org: Organization,
    *,
    title: str,
    start: datetime | None = None,
    duration_minutes: int = 30,
    agenda: str | None = None,
) -> dict:
    """Schedule a Zoom meeting via the Zoom API and return its join link.
    Requires the connected Zoom app to carry the ``meeting:write`` scope."""
    token = meeting_oauth.get_valid_access_token(db, org, "zoom")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    start = start or (datetime.now(timezone.utc) + timedelta(minutes=2))
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    duration_minutes = max(5, min(int(duration_minutes or 30), 24 * 60))
    body = {
        "topic": (title or "Meeting").strip()[:200],
        "type": 2,  # scheduled meeting
        "start_time": start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "duration": duration_minutes,
        "timezone": "UTC",
        "settings": {"join_before_host": True, "waiting_room": False},
    }
    if agenda:
        body["agenda"] = agenda.strip()[:2000]

    resp = None
    try:
        resp = httpx.post(
            f"{ZOOM_API}/users/me/meetings",
            headers=headers,
            json=body,
            timeout=_HTTP_TIMEOUT,
        )
        resp.raise_for_status()
        meeting = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise _zoom_error(exc, resp)

    return {
        "event_id": str(meeting.get("id")) if meeting.get("id") is not None else None,
        "title": meeting.get("topic") or body["topic"],
        "join_url": meeting.get("join_url"),
        "html_link": meeting.get("join_url"),
        "start": _iso_to_dt(meeting.get("start_time")),
        "duration_minutes": meeting.get("duration") or duration_minutes,
        "passcode": meeting.get("password") or meeting.get("encrypted_password"),
        "attendees": [],
    }


def _zoom_error(exc: Exception, resp: httpx.Response | None) -> meeting_oauth.MeetingOAuthError:
    status = getattr(resp, "status_code", None)
    if status in (401, 403):
        return meeting_oauth.MeetingOAuthError(
            "Zoom refused the request — your Zoom app may be missing the "
            "'meeting:write' scope. Reconnect Zoom after enabling it."
        )
    return meeting_oauth.MeetingOAuthError(f"Zoom meeting creation failed: {exc}", transient=True)


def update_zoom_meeting(
    db: Session,
    org: Organization,
    meeting_id: str,
    *,
    title: str | None = None,
    start: datetime | None = None,
    duration_minutes: int | None = None,
    agenda: str | None = None,
) -> None:
    """Update a scheduled Zoom meeting (PATCH returns 204). Zoom does NOT email
    attendees, so the backend handles invitation/update emails separately."""
    token = meeting_oauth.get_valid_access_token(db, org, "zoom")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body: dict = {}
    if title:
        body["topic"] = title.strip()[:200]
    if start is not None:
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        body["start_time"] = start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        body["timezone"] = "UTC"
    if duration_minutes is not None:
        body["duration"] = max(5, min(int(duration_minutes), 24 * 60))
    if agenda:
        body["agenda"] = agenda.strip()[:2000]
    if not body:
        return
    resp = None
    try:
        resp = httpx.patch(
            f"{ZOOM_API}/meetings/{meeting_id}",
            headers=headers,
            json=body,
            timeout=_HTTP_TIMEOUT,
        )
        resp.raise_for_status()
    except (httpx.HTTPError, ValueError) as exc:
        raise _zoom_error(exc, resp)


# --------------------------------------------------------------------------- #
# Google Meet (Meet REST API: conferenceRecords -> transcripts -> entries)
# --------------------------------------------------------------------------- #


def _meet_error(exc: Exception, resp: httpx.Response | None) -> meeting_oauth.MeetingOAuthError:
    """Map a Google Meet REST API failure to a user-facing message. A 401/403 on
    conferenceRecords almost always means one of: the Google Meet API isn't
    enabled for the connected account's Cloud project, the
    meetings.space.readonly scope was never granted (re-consent needed), or the
    account isn't a Google Workspace account (the Meet REST recordings/transcripts
    API is Workspace-only). None of these are retryable, so don't mark transient."""
    if resp is not None and resp.status_code in (401, 403):
        try:
            reason = resp.json().get("error", {}).get("message")
        except (ValueError, AttributeError):
            reason = None
        msg = (
            "Google Meet refused access to your recordings. Enable the Google Meet "
            "API for your Google account's project and reconnect Google Meet to grant "
            "recording access. Note: pulling recordings/transcripts requires a Google "
            "Workspace account — it isn't available on personal Gmail accounts"
            + (f" ({reason})." if reason else ".")
        )
        return meeting_oauth.MeetingOAuthError(msg)
    return meeting_oauth.MeetingOAuthError(f"Google Meet conference list failed: {exc}", transient=True)


def fetch_google_meet(db: Session, org: Organization, since_days: int = 30, limit: int = 20) -> list[dict]:
    token = meeting_oauth.get_valid_access_token(db, org, "google_meet")
    headers = {"Authorization": f"Bearer {token}"}
    out: list[dict] = []
    resp = None
    try:
        resp = httpx.get(
            f"{MEET_API}/conferenceRecords",
            headers=headers,
            params={"pageSize": min(limit, 50)},
            timeout=_HTTP_TIMEOUT,
        )
        resp.raise_for_status()
        records = resp.json().get("conferenceRecords", [])
    except (httpx.HTTPError, ValueError) as exc:
        raise _meet_error(exc, resp) from exc

    for record in records[:limit]:
        record_name = record.get("name")  # "conferenceRecords/{id}"
        if not record_name:
            continue
        try:
            tr = httpx.get(f"{MEET_API}/{record_name}/transcripts", headers=headers, timeout=_HTTP_TIMEOUT)
            if tr.status_code != 200:
                continue
            transcripts = tr.json().get("transcripts", [])
        except (httpx.HTTPError, ValueError):
            continue

        utterances: list[dict] = []
        speaker_map: dict[str, str] = {}
        for transcript in transcripts:
            tname = transcript.get("name")
            if not tname:
                continue
            page_token = None
            while True:
                params = {"pageSize": 1000}
                if page_token:
                    params["pageToken"] = page_token
                try:
                    er = httpx.get(f"{MEET_API}/{tname}/entries", headers=headers, params=params, timeout=_HTTP_TIMEOUT)
                    if er.status_code != 200:
                        break
                    edata = er.json()
                except (httpx.HTTPError, ValueError):
                    break
                for entry in edata.get("transcriptEntries", []):
                    participant = entry.get("participant") or "unknown"
                    if participant not in speaker_map:
                        speaker_map[participant] = f"Speaker {len(speaker_map) + 1}"
                    text = (entry.get("text") or "").strip()
                    if not text:
                        continue
                    utterances.append({
                        "speaker": speaker_map[participant],
                        "text": text,
                        "start": None,
                        "end": None,
                    })
                page_token = edata.get("nextPageToken")
                if not page_token:
                    break

        if not utterances:
            continue
        out.append({
            "external_id": record_name.replace("conferenceRecords/", ""),
            "title": record.get("space", {}).get("meetingCode") and
                     f"Google Meet {record['space']['meetingCode']}" or "Google Meet",
            "started_at": _iso_to_dt(record.get("startTime")),
            "participants": [],
            "transcript": _utterances_to_transcript(utterances),
            "utterances": utterances,
        })
    return out


# --------------------------------------------------------------------------- #
# Google Calendar (create Meet meetings + browse upcoming/recent meetings)
# --------------------------------------------------------------------------- #


def _meet_link_from_event(event: dict) -> str | None:
    """Pull the Google Meet join URL from a Calendar event. Checks the convenience
    ``hangoutLink`` first, then ``conferenceData`` entry points — accepting any
    entry point whose URI points at meet.google.com, not just those Google tags as
    ``video`` (some events carry the Meet link under a different entryPointType)."""
    link = event.get("hangoutLink")
    if link:
        return link
    for ep in (event.get("conferenceData") or {}).get("entryPoints", []) or []:
        uri = ep.get("uri") or ""
        if not uri:
            continue
        if ep.get("entryPointType") == "video" or "meet.google.com" in uri:
            return uri
    return None


def _calendar_error(exc: Exception, resp: httpx.Response | None) -> meeting_oauth.MeetingOAuthError:
    """Map a Calendar API failure to a user-facing message. A 403 almost always
    means the connected account never granted the calendar scope, so steer the
    user to reconnect rather than reporting a generic transient error."""
    if resp is not None and resp.status_code in (401, 403):
        try:
            reason = resp.json().get("error", {}).get("message")
        except (ValueError, AttributeError):
            reason = None
        msg = (
            "Google Calendar access was refused. Reconnect Google Meet to grant "
            "calendar permission" + (f" ({reason})." if reason else ".")
        )
        return meeting_oauth.MeetingOAuthError(msg)
    return meeting_oauth.MeetingOAuthError(f"Google Calendar request failed: {exc}", transient=True)


def create_google_meet(
    db: Session,
    org: Organization,
    *,
    title: str,
    start: datetime | None = None,
    duration_minutes: int = 30,
    attendees: list[str] | None = None,
    description: str | None = None,
) -> dict:
    """Create a Google Calendar event with a Google Meet conference attached and
    return its join link. Requires the ``calendar.events`` scope."""
    token = meeting_oauth.get_valid_access_token(db, org, "google_meet")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    start = start or (datetime.now(timezone.utc) + timedelta(minutes=2))
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    duration_minutes = max(5, min(int(duration_minutes or 30), 24 * 60))
    end = start + timedelta(minutes=duration_minutes)
    body = {
        "summary": (title or "Meeting").strip()[:300],
        "start": {"dateTime": start.isoformat()},
        "end": {"dateTime": end.isoformat()},
        "conferenceData": {
            "createRequest": {
                "requestId": secrets.token_hex(12),
                "conferenceSolutionKey": {"type": "hangoutsMeet"},
            }
        },
    }
    if description:
        body["description"] = description.strip()[:8000]
    clean_attendees = [a.strip() for a in (attendees or []) if a and "@" in a]
    if clean_attendees:
        body["attendees"] = [{"email": a} for a in clean_attendees[:50]]

    resp = None
    try:
        resp = httpx.post(
            f"{CALENDAR_API}/calendars/primary/events",
            headers=headers,
            params={
                "conferenceDataVersion": 1,
                "sendUpdates": "all" if clean_attendees else "none",
            },
            json=body,
            timeout=_HTTP_TIMEOUT,
        )
        resp.raise_for_status()
        event = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise _calendar_error(exc, resp)

    return {
        "event_id": event.get("id"),
        "title": event.get("summary") or body["summary"],
        "join_url": _meet_link_from_event(event),
        "html_link": event.get("htmlLink"),
        "start": _iso_to_dt((event.get("start") or {}).get("dateTime")),
        "duration_minutes": duration_minutes,
        "attendees": clean_attendees,
    }


def update_google_meet(
    db: Session,
    org: Organization,
    event_id: str,
    *,
    title: str | None = None,
    start: datetime | None = None,
    duration_minutes: int | None = None,
    attendees: list[str] | None = None,
) -> None:
    """Patch an existing Google Calendar event and let Google notify attendees
    (``sendUpdates=all``). Only the provided fields change; ``conferenceData`` is
    preserved by omitting it. Passing ``attendees`` REPLACES the attendee list —
    Google emails the calendar update/invite to everyone on it."""
    token = meeting_oauth.get_valid_access_token(db, org, "google_meet")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body: dict = {}
    if title:
        body["summary"] = title.strip()[:300]
    if start is not None:
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        body["start"] = {"dateTime": start.isoformat()}
        dur = max(5, min(int(duration_minutes or 30), 24 * 60))
        body["end"] = {"dateTime": (start + timedelta(minutes=dur)).isoformat()}
    if attendees is not None:
        clean = [a.strip() for a in attendees if a and "@" in a]
        body["attendees"] = [{"email": a} for a in clean[:50]]
    if not body:
        return
    resp = None
    try:
        resp = httpx.patch(
            f"{CALENDAR_API}/calendars/primary/events/{event_id}",
            headers=headers,
            params={"conferenceDataVersion": 1, "sendUpdates": "all"},
            json=body,
            timeout=_HTTP_TIMEOUT,
        )
        resp.raise_for_status()
    except (httpx.HTTPError, ValueError) as exc:
        raise _calendar_error(exc, resp)


def list_google_calendar_events(
    db: Session,
    org: Organization,
    *,
    past_days: int = 7,
    upcoming_days: int = 21,
    max_results: int = 30,
) -> list[dict]:
    """List the org account's Calendar meetings that carry a Google Meet link,
    spanning ``past_days`` back to ``upcoming_days`` ahead. Read via the
    ``calendar.events`` scope."""
    token = meeting_oauth.get_valid_access_token(db, org, "google_meet")
    headers = {"Authorization": f"Bearer {token}"}
    now = datetime.now(timezone.utc)
    time_min = (now - timedelta(days=max(0, past_days))).isoformat()
    time_max = (now + timedelta(days=max(1, upcoming_days))).isoformat()

    resp = None
    try:
        resp = httpx.get(
            f"{CALENDAR_API}/calendars/primary/events",
            headers=headers,
            params={
                "timeMin": time_min,
                "timeMax": time_max,
                "singleEvents": "true",
                "orderBy": "startTime",
                "maxResults": min(max(max_results, 1), 100),
                "conferenceDataVersion": 1,
            },
            timeout=_HTTP_TIMEOUT,
        )
        resp.raise_for_status()
        items = resp.json().get("items", [])
    except (httpx.HTTPError, ValueError) as exc:
        raise _calendar_error(exc, resp)

    out: list[dict] = []
    for ev in items:
        join_url = _meet_link_from_event(ev)
        if not join_url:
            continue
        start_dt = _iso_to_dt((ev.get("start") or {}).get("dateTime"))
        attendees = [
            a.get("email") for a in (ev.get("attendees") or []) if a.get("email")
        ]
        out.append({
            "event_id": ev.get("id"),
            "title": ev.get("summary") or "Meeting",
            "start": start_dt,
            "join_url": join_url,
            "html_link": ev.get("htmlLink"),
            "attendees": attendees,
            "is_past": bool(start_dt and start_dt < now),
        })
    return out


# --------------------------------------------------------------------------- #
# Microsoft Teams (Graph: online meeting transcripts)
# --------------------------------------------------------------------------- #


def fetch_ms_teams(db: Session, org: Organization, since_days: int = 30, limit: int = 20) -> list[dict]:
    token = meeting_oauth.get_valid_access_token(db, org, "ms_teams")
    headers = {"Authorization": f"Bearer {token}"}
    out: list[dict] = []
    since = (datetime.now(timezone.utc) - timedelta(days=since_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        resp = httpx.get(
            f"{GRAPH_API}/me/events",
            headers=headers,
            params={
                "$filter": f"isOnlineMeeting eq true and start/dateTime ge '{since}'",
                "$top": min(limit, 50),
                "$orderby": "start/dateTime desc",
            },
            timeout=_HTTP_TIMEOUT,
        )
        resp.raise_for_status()
        events = resp.json().get("value", [])
    except (httpx.HTTPError, ValueError) as exc:
        raise meeting_oauth.MeetingOAuthError(f"Teams events list failed: {exc}", transient=True)

    for event in events[:limit]:
        join_url = (event.get("onlineMeeting") or {}).get("joinUrl")
        if not join_url:
            continue
        try:
            mr = httpx.get(
                f"{GRAPH_API}/me/onlineMeetings",
                headers=headers,
                params={"$filter": f"JoinWebUrl eq '{join_url}'"},
                timeout=_HTTP_TIMEOUT,
            )
            if mr.status_code != 200:
                continue
            meetings = mr.json().get("value", [])
            if not meetings:
                continue
            meeting_id = meetings[0].get("id")
        except (httpx.HTTPError, ValueError):
            continue
        if not meeting_id:
            continue
        try:
            tr = httpx.get(
                f"{GRAPH_API}/me/onlineMeetings/{meeting_id}/transcripts",
                headers=headers,
                timeout=_HTTP_TIMEOUT,
            )
            if tr.status_code != 200:
                continue
            transcripts = tr.json().get("value", [])
        except (httpx.HTTPError, ValueError):
            continue

        utterances: list[dict] = []
        for transcript in transcripts:
            tid = transcript.get("id")
            if not tid:
                continue
            try:
                cr = httpx.get(
                    f"{GRAPH_API}/me/onlineMeetings/{meeting_id}/transcripts/{tid}/content",
                    headers=headers,
                    params={"$format": "text/vtt"},
                    timeout=_HTTP_TIMEOUT,
                )
                if cr.status_code != 200:
                    continue
                utterances.extend(_vtt_or_text_to_utterances(cr.text))
            except httpx.HTTPError:
                continue

        if not utterances:
            continue
        out.append({
            "external_id": str(event.get("id") or meeting_id),
            "title": event.get("subject") or "Teams meeting",
            "started_at": _iso_to_dt((event.get("start") or {}).get("dateTime")),
            "participants": [],
            "transcript": _utterances_to_transcript(utterances),
            "utterances": utterances,
        })
    return out


def _teams_error(exc: Exception, resp: httpx.Response | None) -> meeting_oauth.MeetingOAuthError:
    status = getattr(resp, "status_code", None)
    if status in (401, 403):
        return meeting_oauth.MeetingOAuthError(
            "Microsoft refused the request — your Teams connection may be missing "
            "the 'Calendars.ReadWrite' permission. Reconnect Microsoft Teams to "
            "grant it."
        )
    return meeting_oauth.MeetingOAuthError(f"Teams meeting creation failed: {exc}", transient=True)


def _graph_event_body(
    *, title: str, start: datetime, duration_minutes: int,
    attendees: list[str] | None, description: str | None, online: bool,
) -> dict:
    end = start + timedelta(minutes=duration_minutes)
    body: dict = {
        "subject": (title or "Meeting").strip()[:300],
        "start": {"dateTime": start.strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": "UTC"},
        "end": {"dateTime": end.strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": "UTC"},
    }
    if online:
        body["isOnlineMeeting"] = True
        body["onlineMeetingProvider"] = "teamsForBusiness"
    if description:
        body["body"] = {"contentType": "HTML", "content": description[:8000]}
    if attendees is not None:
        clean = [a.strip() for a in attendees if a and "@" in a]
        body["attendees"] = [
            {"emailAddress": {"address": a}, "type": "required"} for a in clean[:50]
        ]
    return body


def create_ms_teams(
    db: Session,
    org: Organization,
    *,
    title: str,
    start: datetime | None = None,
    duration_minutes: int = 30,
    attendees: list[str] | None = None,
    description: str | None = None,
) -> dict:
    """Create a Microsoft Graph calendar event configured as an online Teams
    meeting. Graph/Outlook automatically emails invitations to every attendee —
    the backend never sends Teams invitation emails. Requires the
    ``Calendars.ReadWrite`` scope."""
    token = meeting_oauth.get_valid_access_token(db, org, "ms_teams")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    start = start or (datetime.now(timezone.utc) + timedelta(minutes=2))
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    start = start.astimezone(timezone.utc)
    duration_minutes = max(5, min(int(duration_minutes or 30), 24 * 60))
    clean_attendees = [a.strip() for a in (attendees or []) if a and "@" in a]
    body = _graph_event_body(
        title=title, start=start, duration_minutes=duration_minutes,
        attendees=clean_attendees, description=description, online=True,
    )

    resp = None
    try:
        resp = httpx.post(
            f"{GRAPH_API}/me/events",
            headers=headers,
            json=body,
            timeout=_HTTP_TIMEOUT,
        )
        resp.raise_for_status()
        event = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise _teams_error(exc, resp)

    join_url = (event.get("onlineMeeting") or {}).get("joinUrl")
    return {
        "event_id": event.get("id"),
        "title": event.get("subject") or body["subject"],
        "join_url": join_url,
        "html_link": event.get("webLink"),
        "start": _iso_to_dt((event.get("start") or {}).get("dateTime")),
        "duration_minutes": duration_minutes,
        "attendees": clean_attendees,
    }


def update_ms_teams(
    db: Session,
    org: Organization,
    event_id: str,
    *,
    title: str | None = None,
    start: datetime | None = None,
    duration_minutes: int | None = None,
    attendees: list[str] | None = None,
) -> None:
    """Patch a Microsoft Graph calendar event. Graph/Outlook automatically emails
    update notifications to attendees, so the backend sends nothing. Passing
    ``attendees`` REPLACES the attendee list."""
    token = meeting_oauth.get_valid_access_token(db, org, "ms_teams")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body: dict = {}
    if title:
        body["subject"] = title.strip()[:300]
    if start is not None:
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        start = start.astimezone(timezone.utc)
        dur = max(5, min(int(duration_minutes or 30), 24 * 60))
        end = start + timedelta(minutes=dur)
        body["start"] = {"dateTime": start.strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": "UTC"}
        body["end"] = {"dateTime": end.strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": "UTC"}
    if attendees is not None:
        clean = [a.strip() for a in attendees if a and "@" in a]
        body["attendees"] = [
            {"emailAddress": {"address": a}, "type": "required"} for a in clean[:50]
        ]
    if not body:
        return
    resp = None
    try:
        resp = httpx.patch(
            f"{GRAPH_API}/me/events/{event_id}",
            headers=headers,
            json=body,
            timeout=_HTTP_TIMEOUT,
        )
        resp.raise_for_status()
    except (httpx.HTTPError, ValueError) as exc:
        raise _teams_error(exc, resp)


FETCHERS = {
    "zoom": fetch_zoom,
    "google_meet": fetch_google_meet,
    "ms_teams": fetch_ms_teams,
}

# Meeting-history (metadata only) importers, kept separate from the transcript
# FETCHERS above so recording sync stays independent. Only Zoom is wired today.
METADATA_FETCHERS = {
    "zoom": fetch_zoom_meetings,
}


def fetch_provider(db: Session, org: Organization, provider: str, since_days: int = 30, limit: int = 20) -> list[dict]:
    fetcher = FETCHERS.get(provider)
    if not fetcher:
        raise meeting_oauth.MeetingOAuthError(f"No transcript fetcher for provider: {provider}")
    return fetcher(db, org, since_days=since_days, limit=limit)


def fetch_provider_meetings(db: Session, org: Organization, provider: str, since_days: int = 30, limit: int = 50) -> list[dict]:
    fetcher = METADATA_FETCHERS.get(provider)
    if not fetcher:
        raise meeting_oauth.MeetingOAuthError(f"Meeting import is not available for provider: {provider}")
    return fetcher(db, org, since_days=since_days, limit=limit)
