"""Universal, provider-independent outbound email for meeting invitations.

Meeting invitations are sent from THIS application's own backend email account
(configured via SMTP env vars) — NOT the user's connected Google / Microsoft /
Zoom account. This decouples invitation delivery from the meeting provider: a
meeting can be created or imported through any provider (Google Meet, Teams,
Zoom, an imported recording, or a custom URL), and the invitation — a branded
HTML email with an attached RFC-5545 ``.ics`` calendar invite — is always
delivered the same way.

Any SMTP-capable provider works (SendGrid, Amazon SES, Mailgun, Resend,
Postmark, Gmail / Google Workspace, ...). Configure ``SMTP_HOST`` / ``SMTP_PORT``
/ ``SMTP_USERNAME`` / ``SMTP_PASSWORD`` / ``SMTP_FROM_EMAIL``. When unconfigured
callers get a clear :class:`EmailNotConfigured` error instead of a
provider-specific "reconnect X" message.
"""
from __future__ import annotations

import logging
import smtplib
import ssl
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, make_msgid

from ..config import get_settings

logger = logging.getLogger(__name__)

_SMTP_TIMEOUT = 30  # seconds


class EmailError(Exception):
    """Base class for invitation-email failures."""


class EmailNotConfigured(EmailError):
    """Raised when no backend email transport (SMTP) is configured."""


class EmailSendError(EmailError):
    """Raised when a configured transport fails to deliver."""


# --------------------------------------------------------------------------
# Transport (provider-independent SMTP)
# --------------------------------------------------------------------------


def send_invitation(
    *,
    to: list[str],
    subject: str,
    html: str,
    text: str,
    ics_text: str | None = None,
    ics_method: str = "REQUEST",
    ics_filename: str = "invite.ics",
    sender_name: str | None = None,
    reply_to: str | None = None,
) -> dict:
    """Send one invitation email (to all recipients) via the backend SMTP
    account. Returns ``{sent, recipients, from}``.

    Raises :class:`EmailNotConfigured` when SMTP isn't set up and
    :class:`EmailSendError` when delivery fails — both provider-independent so
    the caller never surfaces a "reconnect Google/Zoom" message.
    """
    settings = get_settings()
    if not settings.email_configured():
        raise EmailNotConfigured(
            "Email sending isn't configured yet. Add the backend email (SMTP) "
            "settings — host, port, username, password and a From address — to "
            "enable meeting invitations."
        )

    recipients = [a.strip() for a in to if a and a.strip()]
    if not recipients:
        raise EmailSendError("No valid email addresses to send to.")

    from_email = settings.resolved_from_email()
    from_name = sender_name or settings.smtp_from_name or from_email

    root = MIMEMultipart("mixed")
    root["Subject"] = subject
    root["From"] = formataddr((from_name, from_email))
    root["To"] = ", ".join(recipients)
    root["Message-ID"] = make_msgid()
    if reply_to:
        root["Reply-To"] = reply_to

    alt = MIMEMultipart("alternative")
    alt.attach(MIMEText(text, "plain", "utf-8"))
    alt.attach(MIMEText(html, "html", "utf-8"))
    root.attach(alt)

    if ics_text:
        cal = MIMEText(ics_text, "calendar", "utf-8")
        cal.set_param("method", ics_method)
        cal.set_param("name", ics_filename)
        cal.add_header("Content-Disposition", "attachment", filename=ics_filename)
        root.attach(cal)

    try:
        _smtp_deliver(settings, from_email, recipients, root.as_string())
    except (smtplib.SMTPException, OSError) as exc:
        raise EmailSendError(f"Sending the invitation email failed: {exc}") from exc

    return {"sent": len(recipients), "recipients": recipients, "from": from_email}


def _smtp_deliver(settings, from_email: str, recipients: list[str], raw: str) -> None:
    host, port = settings.smtp_host, settings.smtp_port
    if settings.smtp_use_ssl:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(host, port, timeout=_SMTP_TIMEOUT, context=context) as srv:
            if settings.smtp_username:
                srv.login(settings.smtp_username, settings.smtp_password)
            srv.sendmail(from_email, recipients, raw)
        return
    with smtplib.SMTP(host, port, timeout=_SMTP_TIMEOUT) as srv:
        srv.ehlo()
        if settings.smtp_use_tls:
            srv.starttls(context=ssl.create_default_context())
            srv.ehlo()
        if settings.smtp_username:
            srv.login(settings.smtp_username, settings.smtp_password)
        srv.sendmail(from_email, recipients, raw)


# --------------------------------------------------------------------------
# RFC 5545 calendar (.ics) generation
# --------------------------------------------------------------------------


def _ics_dt(dt: datetime) -> str:
    """Format a datetime as a UTC RFC-5545 timestamp (``...Z``). Meeting times
    are stored in UTC; naive values are treated as UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _ics_escape(value: str) -> str:
    """Escape a TEXT value per RFC 5545 §3.3.11."""
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
    )


def _ics_fold(line: str) -> str:
    """Fold a content line to <=75 octets with CRLF + single space (§3.1)."""
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    chunks, start = [], 0
    limit = 74  # leave room so a continued line (with leading space) stays <=75
    while start < len(raw):
        end = min(start + limit, len(raw))
        # Don't split a multi-byte UTF-8 sequence.
        while end < len(raw) and (raw[end] & 0xC0) == 0x80:
            end -= 1
        chunks.append(raw[start:end].decode("utf-8"))
        start = end
        limit = 73  # subsequent lines carry a leading space
    return "\r\n ".join(chunks)


def build_ics(
    *,
    uid: str,
    title: str,
    start: datetime,
    duration_minutes: int | None,
    join_url: str | None = None,
    description: str | None = None,
    location: str | None = None,
    organizer_email: str | None = None,
    organizer_name: str | None = None,
    attendees: list[str] | None = None,
    sequence: int = 0,
    method: str = "REQUEST",
    cancel: bool = False,
) -> str:
    """Build an RFC-5545 VCALENDAR string for a single meeting event.

    Provider-independent: it only needs the meeting's own details. ``location``
    defaults to the join URL so calendar clients show a clickable link.
    """
    end = start + timedelta(minutes=int(duration_minutes or 30))
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Concap AI//Meeting Invitation//EN",
        "CALSCALE:GREGORIAN",
        f"METHOD:{method}",
        "BEGIN:VEVENT",
        f"UID:{_ics_escape(uid)}",
        f"DTSTAMP:{_ics_dt(datetime.now(timezone.utc))}",
        f"DTSTART:{_ics_dt(start)}",
        f"DTEND:{_ics_dt(end)}",
        f"SUMMARY:{_ics_escape(title or 'Meeting')}",
        f"SEQUENCE:{int(sequence)}",
        f"STATUS:{'CANCELLED' if cancel else 'CONFIRMED'}",
    ]
    loc = location or join_url
    if loc:
        lines.append(f"LOCATION:{_ics_escape(loc)}")
    desc_parts = [p for p in (description, (f"Join: {join_url}" if join_url else None)) if p]
    if desc_parts:
        desc_joined = "\n\n".join(desc_parts)
        lines.append(f"DESCRIPTION:{_ics_escape(desc_joined)}")
    if organizer_email:
        cn = f';CN={_ics_escape(organizer_name)}' if organizer_name else ""
        lines.append(f"ORGANIZER{cn}:mailto:{organizer_email}")
    for a in attendees or []:
        a = (a or "").strip()
        if a:
            lines.append(
                f"ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:{a}"
            )
    lines += ["END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(_ics_fold(ln) for ln in lines) + "\r\n"


# --------------------------------------------------------------------------
# Branded HTML / text invitation body
# --------------------------------------------------------------------------


def _fmt_when(start, duration_minutes) -> str:
    """Human-readable date/time line. Meeting times are stored in UTC, so we
    label them UTC rather than guessing the recipient's timezone."""
    if start is None:
        return "Time to be confirmed"
    if getattr(start, "tzinfo", None) is None:
        start = start.replace(tzinfo=timezone.utc)
    line = start.strftime("%a, %d %b %Y · %H:%M UTC")
    if duration_minutes:
        line += f" · {int(duration_minutes)} min"
    return line


def _esc(s) -> str:
    return (
        str(s).replace("&", "&amp;").replace("<", "&lt;")
        .replace(">", "&gt;").replace('"', "&quot;")
    )


def build_invitation_email(
    *,
    title: str,
    when,
    duration_minutes,
    join_url: str | None,
    meeting_id: str | None,
    passcode: str | None,
    organizer: str | None,
    kind: str = "invite",
    platform: str | None = None,
    description: str | None = None,
    company_name: str | None = None,
    primary_color: str | None = None,
    logo_url: str | None = None,
) -> tuple[str, str, str]:
    """Build (subject, html, text) for a meeting invitation or update email.

    Provider-independent: ``platform`` is just a label shown to the recipient
    ("Google Meet", "Zoom", "Microsoft Teams", ...). Branding (``company_name``,
    ``primary_color``, ``logo_url``) is the org's own — when absent, sensible
    Concap defaults are used.
    """
    title = title or "Meeting"
    accent = primary_color if (primary_color or "").startswith("#") else "#2563eb"
    brand = company_name or "Concap AI"
    when_line = _fmt_when(when, duration_minutes)
    is_update = kind == "update"
    subject = (f"Updated: {title}" if is_update else f"Invitation: {title}")
    lead = (
        "A meeting you were invited to has been updated. Here are the latest details:"
        if is_update else
        "You've been invited to a meeting. The details are below."
    )

    rows = [("When", when_line)]
    if platform:
        rows.append(("Platform", platform))
    if organizer:
        rows.append(("Organizer", organizer))
    if meeting_id:
        rows.append(("Meeting ID", meeting_id))
    if passcode:
        rows.append(("Passcode", passcode))

    rows_html = "".join(
        f'<tr><td style="padding:5px 16px 5px 0; color:#64748b; font-size:13px; white-space:nowrap;">{_esc(k)}</td>'
        f'<td style="padding:5px 0; color:#0f172a; font-size:13px; font-weight:600;">{_esc(v)}</td></tr>'
        for k, v in rows
    )
    desc_html = (
        f'<p style="color:#475569; font-size:13px; margin:0 0 18px; white-space:pre-wrap;">{_esc(description)}</p>'
        if description else ""
    )
    join_btn = (
        f'<a href="{_esc(join_url)}" style="display:inline-block; background:{accent}; '
        f'color:#ffffff; text-decoration:none; padding:11px 22px; border-radius:8px; '
        f'font-weight:600; font-size:14px;">Join Meeting</a>'
        if join_url else ""
    )
    join_fallback = (
        f'<p style="font-size:12px; color:#64748b; margin:12px 0 0;">'
        f'Or paste this link: <a href="{_esc(join_url)}" style="color:{accent};">{_esc(join_url)}</a></p>'
        if join_url else ""
    )
    logo_html = (
        f'<img src="{_esc(logo_url)}" alt="{_esc(brand)}" '
        f'style="max-height:40px; max-width:180px; margin:0 0 14px; display:block;" />'
        if logo_url else
        f'<div style="color:{accent}; font-weight:700; font-size:16px; margin:0 0 14px;">{_esc(brand)}</div>'
    )
    html = f"""\
<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif; max-width:520px; margin:0 auto; padding:16px;">
  {logo_html}
  <h2 style="color:#0f172a; font-size:20px; margin:0 0 6px;">{_esc(title)}</h2>
  <p style="color:#475569; font-size:14px; margin:0 0 18px;">{_esc(lead)}</p>
  {desc_html}
  <table style="border-collapse:collapse; margin:0 0 20px;">{rows_html}</table>
  {join_btn}
  {join_fallback}
  <p style="font-size:11px; color:#94a3b8; margin:26px 0 0;">A calendar invite (.ics) is attached. Sent by {_esc(brand)}.</p>
</div>"""

    text_lines = [title, "", lead, ""]
    if description:
        text_lines += [description, ""]
    text_lines += [f"{k}: {v}" for k, v in rows]
    if join_url:
        text_lines += ["", f"Join: {join_url}"]
    text_lines += ["", f"A calendar invite (.ics) is attached. Sent by {brand}."]
    text = "\n".join(text_lines)
    return subject, html, text
