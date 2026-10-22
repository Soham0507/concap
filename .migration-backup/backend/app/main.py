import logging
import threading
import time
import traceback
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .database import init_db
from fastapi import Depends

from .routers import all_meetings, auth, branding, brands, captures, companies, consent, conversations, events, hubspot, imported_meetings, meetings, org, plaud, privacy, quotes, salesforce, scan, search, sessions, transcribe, visitors, voice_profile
from .routers.auth import require_user

logger = logging.getLogger("booth")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

settings = get_settings()

# Set once the DB schema migration / self-heal finishes. Until then, DB-backed
# routes return 503 (see `_readiness_gate`). Static pages + /api/health stay
# responsive so the deploy health check sees port 5000 open immediately.
_db_ready = threading.Event()
# Diagnostics surfaced via /api/health so operators can tell "starting" from
# "stuck/failing": attempt count and the last init error (if any).
_db_init_attempts = 0
_db_init_last_error: str | None = None


def _run_init_db() -> None:
    """Run init_db() in a background thread so the server can open its port
    right away — a cold Postgres start can make the migration/backfill exceed
    the platform's 60s port-open window, which previously surfaced as a
    first-boot 'Internal Server Error' until the platform retried the deploy.

    Retries indefinitely with capped exponential backoff: if the DB is briefly
    unavailable we keep trying rather than parking the whole app at 503
    forever. Each failure is logged and reflected in /api/health."""
    global _db_init_attempts, _db_init_last_error
    backoff = 1
    while True:
        _db_init_attempts += 1
        try:
            init_db()
            _db_init_last_error = None
            _db_ready.set()
            logger.info("Database ready (init attempt %s).", _db_init_attempts)
            return
        except Exception as exc:  # noqa: BLE001 — log and retry transient failures
            _db_init_last_error = f"{exc.__class__.__name__}: {exc}"
            logger.exception(
                "DB init attempt %s failed; retrying in %ss", _db_init_attempts, backoff
            )
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)


app = FastAPI(title="Booth Conversation Capture", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list or ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# Dev cache-buster: tell browsers not to cache our static frontend or HTML
# page routes. Without this, edits to styles.css / *.html / *.js look like
# they "didn't apply" because the browser is happily serving last week's
# copy. We always set this; the app is a frontend-light internal CRM where
# the request volume is fine without edge caching. If we ever add a CDN
# we can flip this to `max-age=300` for /static and keep no-cache for HTML.
@app.middleware("http")
async def _no_cache_static(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    # /api/* responses also get no-cache: without explicit headers, browsers
    # (and the PWA service worker's underlying HTTP cache) can heuristically
    # cache a GET like /api/conversations, so a backend change to the payload
    # shape (e.g. adding the `topic` field) keeps showing stale data until a
    # hard refresh. This is a live internal CRM — always serve fresh data.
    if path.startswith("/static/") or path.startswith("/api/") or path in {
        "/", "/login", "/signup", "/change-password", "/members", "/admin",
        "/dashboard", "/booth", "/long-capture", "/transcribe", "/scan",
        "/contacts", "/companies", "/conversations", "/integrations",
        "/meetings", "/imported-meetings", "/all-meetings", "/quotes", "/branding",
    }:
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Surface the real error in the HTTP response so it's visible without
    digging through terminal logs. This is fine for a single-tenant booth app;
    do NOT keep this enabled for a multi-tenant production deploy.
    """
    tb = traceback.format_exc()
    logger.error("Unhandled error on %s %s\n%s", request.method, request.url.path, tb)
    return JSONResponse(
        status_code=500,
        content={
            "error": exc.__class__.__name__,
            "detail": str(exc),
            "path": request.url.path,
            "traceback": tb.splitlines()[-12:],
        },
    )


def _start_meeting_worker_when_ready() -> None:
    """Wait for the DB schema to be ready, then start the background Meeting
    Intelligence worker. Gated on _db_ready so the worker never queries tables
    that the migration hasn't created yet on a cold boot."""
    _db_ready.wait()
    from .services.meeting_worker import start_worker
    start_worker()


@app.on_event("startup")
def _startup() -> None:
    # Kick off DB init/migration in the background (don't block port open).
    threading.Thread(target=_run_init_db, name="init-db", daemon=True).start()
    # Start the meeting-intelligence worker once the DB is ready.
    threading.Thread(
        target=_start_meeting_worker_when_ready, name="meeting-worker-boot", daemon=True
    ).start()


@app.middleware("http")
async def _readiness_gate(request: Request, call_next):
    """Return 503 (not a 500 crash) for DB-backed routes while the schema
    migration is still running on a fresh boot. Static pages, the app shell,
    and /api/health stay available so the deploy passes its health check and
    the user sees a clean 'starting up' instead of a stack trace."""
    path = request.url.path
    if path.startswith("/api/") and path != "/api/health" and not _db_ready.is_set():
        return JSONResponse(
            status_code=503,
            content={"error": "starting", "detail": "Server is starting up — please retry in a moment."},
            headers={"Retry-After": "3"},
        )
    return await call_next(request)


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "db_ready": _db_ready.is_set(),
        "db_init_attempts": _db_init_attempts,
        "db_init_error": _db_init_last_error,
        "event": settings.event_name,
        "booth": settings.booth_name,
        "openai_configured": bool(settings.openai_api_key),
    }


@app.get("/api/config", dependencies=[Depends(require_user)])
def public_config() -> dict:
    """Branding + consent config. Requires auth (the whole app is gated)."""
    return {
        "event_name": settings.event_name,
        "booth_name": settings.booth_name,
        "max_audio_mb": settings.max_audio_mb,
        "consent_version": "v1",
        "consent_text": (
            "I consent to the audio of this conversation being recorded, transcribed, "
            "and processed by AI for the purpose of follow-up and lead management by "
            f"{settings.booth_name} at {settings.event_name}. I understand I may "
            "request deletion of my data at any time by contacting the booth team."
        ),
    }


# Auth endpoints are public (you can't have a token before you log in).
app.include_router(auth.router)

# org router enforces auth (and role) per-endpoint.
app.include_router(org.router)

# HubSpot OAuth callback is a top-level browser redirect from HubSpot with no
# bearer header — it authenticates via the signed `state`, so it must NOT sit
# behind the protected dependency below.
app.include_router(hubspot.public_router)
# Same rationale for Salesforce's OAuth callback (per-org, authenticated via state).
app.include_router(salesforce.public_router)
app.include_router(imported_meetings.public_router)
# Same rationale for Plaud's OAuth callback (per-user, authenticated via state).
app.include_router(plaud.public_router)

# Everything else requires a valid bearer token. Each endpoint also takes
# the current user for org scoping; FastAPI dedups the dependency per request.
_protected = [Depends(require_user)]
app.include_router(visitors.router, dependencies=_protected)
app.include_router(consent.router, dependencies=_protected)
app.include_router(conversations.router, dependencies=_protected)
app.include_router(captures.router, dependencies=_protected)
app.include_router(sessions.router, dependencies=_protected)
app.include_router(transcribe.router, dependencies=_protected)
app.include_router(events.router, dependencies=_protected)
app.include_router(search.router, dependencies=_protected)
app.include_router(scan.router, dependencies=_protected)
app.include_router(companies.router, dependencies=_protected)
app.include_router(hubspot.router, dependencies=_protected)
app.include_router(salesforce.router, dependencies=_protected)
app.include_router(plaud.router, dependencies=_protected)
app.include_router(meetings.router, dependencies=_protected)
app.include_router(imported_meetings.router, dependencies=_protected)
app.include_router(all_meetings.router, dependencies=_protected)
app.include_router(branding.router, dependencies=_protected)
app.include_router(brands.router, dependencies=_protected)
app.include_router(privacy.router, dependencies=_protected)
app.include_router(quotes.router, dependencies=_protected)
app.include_router(voice_profile.router, dependencies=_protected)


# Serve the static frontend. The frontend folder lives one level up from /backend.
frontend_dir = Path(__file__).resolve().parent.parent.parent / "frontend"
if frontend_dir.exists():
    app.mount("/static", StaticFiles(directory=frontend_dir), name="static")

    @app.get("/favicon.ico", include_in_schema=False)
    @app.get("/favicon.svg", include_in_schema=False)
    def favicon() -> FileResponse:
        # Browsers request /favicon.ico bare; serve the SVG mark for both.
        return FileResponse(frontend_dir / "favicon.svg", media_type="image/svg+xml")

    @app.get("/")
    def root_index() -> FileResponse:
        return FileResponse(frontend_dir / "landing.html")

    @app.get("/login")
    def login_page() -> FileResponse:
        return FileResponse(frontend_dir / "login.html")

    @app.get("/signup")
    def signup_page() -> FileResponse:
        return FileResponse(frontend_dir / "signup.html")

    @app.get("/change-password")
    def change_password_page() -> FileResponse:
        return FileResponse(frontend_dir / "change-password.html")

    @app.get("/members")
    def members_page() -> FileResponse:
        return FileResponse(frontend_dir / "members.html")

    @app.get("/admin")
    def admin_page() -> FileResponse:
        return FileResponse(frontend_dir / "admin.html")

    @app.get("/dashboard")
    def dashboard_page() -> FileResponse:
        return FileResponse(frontend_dir / "dashboard.html")

    @app.get("/booth")
    def booth_page() -> FileResponse:
        return FileResponse(frontend_dir / "booth.html")

    @app.get("/long-capture")
    def long_capture_page() -> FileResponse:
        return FileResponse(frontend_dir / "long-capture.html")

    @app.get("/transcribe")
    def transcribe_page() -> FileResponse:
        return FileResponse(frontend_dir / "transcribe.html")

    @app.get("/scan")
    def scan_page() -> FileResponse:
        return FileResponse(frontend_dir / "scan.html")

    @app.get("/contacts")
    def contacts_page() -> FileResponse:
        return FileResponse(frontend_dir / "contacts.html")

    @app.get("/conversations")
    def conversations_page() -> FileResponse:
        return FileResponse(frontend_dir / "conversations.html")

    @app.get("/companies")
    def companies_page() -> FileResponse:
        return FileResponse(frontend_dir / "companies.html")

    @app.get("/integrations")
    def integrations_page() -> FileResponse:
        return FileResponse(frontend_dir / "integrations.html")

    @app.get("/meetings")
    def meetings_page() -> FileResponse:
        return FileResponse(frontend_dir / "meetings.html")

    @app.get("/imported-meetings")
    def imported_meetings_page() -> FileResponse:
        return FileResponse(frontend_dir / "imported-meetings.html")

    @app.get("/all-meetings")
    def all_meetings_page() -> FileResponse:
        return FileResponse(frontend_dir / "all-meetings.html")

    @app.get("/quotes")
    def quotes_page() -> FileResponse:
        return FileResponse(frontend_dir / "quotes.html")

    @app.get("/branding")
    def branding_page() -> FileResponse:
        return FileResponse(frontend_dir / "branding.html")

    @app.get("/brands")
    def brands_page() -> FileResponse:
        return FileResponse(frontend_dir / "brands.html")

    @app.get("/profile")
    def profile_page() -> FileResponse:
        return FileResponse(frontend_dir / "profile.html")

    # Legacy path: the standalone Consent & Privacy page now lives on the
    # unified Profile page. Keep the old URL working by serving the same page.
    @app.get("/privacy")
    def privacy_page() -> FileResponse:
        return FileResponse(frontend_dir / "profile.html")

    # Service Worker and manifest MUST be served from the root scope, not /static/,
    # otherwise the SW can only control /static/* — useless for intercepting /booth
    # and /api/*.
    @app.get("/sw.js")
    def service_worker() -> FileResponse:
        return FileResponse(
            frontend_dir / "sw.js",
            media_type="application/javascript",
            headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
        )

    @app.get("/manifest.webmanifest")
    def webmanifest() -> FileResponse:
        return FileResponse(frontend_dir / "manifest.webmanifest", media_type="application/manifest+json")
