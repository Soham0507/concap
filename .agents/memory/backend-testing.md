---
name: Backend pytest setup
description: How the backend test suite is wired (run command, offline conventions) and the package-install gotcha that bit us.
---

# Backend pytest setup

The backend (`backend/`) has a pytest suite. Config is `backend/pytest.ini`
(`pythonpath = .`, `testpaths = tests`). Run it from the backend dir:
`cd backend && python -m pytest`.

## Conventions for these tests
- Tests run fully offline. No real HubSpot creds, no network.
- DB is in-memory SQLite created from `Base.metadata.create_all` (see
  `backend/conftest.py` `db`/`org` fixtures), not the app's real engine.
- `Settings` is an lru_cached singleton loaded from `.env`. Override only the
  values under test via `object.__setattr__(get_settings(), key, value)` (the
  autouse `settings` fixture does this for auth secret, encryption key, and
  HubSpot client id/secret/base url).
- HubSpot token-endpoint calls are mocked by monkeypatching
  `hubspot_oauth.httpx.post` (the module does `import httpx`). Shared fakes
  live in `backend/tests/helpers.py` (`FakeResponse`, `make_post`,
  `state_from_authorize_url`).
- `tests/` is a real package (`tests/__init__.py`) so test modules can
  `from tests.helpers import ...`. Do NOT put shared importable helpers in a
  `conftest.py` — pytest loads conftest as a plugin, not an importable module,
  so `from .conftest import` fails with "no known parent package".
- The suite calls routers directly (not via TestClient) and there is NO
  `pytest-asyncio`. Test an `async def` route by calling it directly inside
  `asyncio.run(...)`, passing every param explicitly (FastAPI's `Form()/File()`
  defaults are FieldInfo objects, not values, so you must pass them yourself).
  Build a multipart `UploadFile` with
  `starlette.datastructures.UploadFile(file=io.BytesIO(b"..."), filename=..., headers=Headers({...}))`.

## FK enforcement is OFF in the shared `db` fixture
**Why:** The app only registers SQLite's `PRAGMA foreign_keys=ON` listener when
its *own* DB is SQLite; dev is Postgres, so importing `app.database` never arms
the pragma. The `db` fixture builds its own bare in-memory SQLite engine, so
DB-level `ON DELETE CASCADE`/`SET NULL` (declared only at the FK level, not as
ORM relationship cascades) silently do NOT fire there — a delete just orphans
child rows with no error.
**How to apply:** To prove cascade/SET-NULL side-effects (which DO fire on the
SQLite deploy engine and Postgres dev), spin up a dedicated engine and attach an
`@event.listens_for(engine, "connect")` that runs `PRAGMA foreign_keys=ON` (see
`test_conversation_delete.py` `fk_db` fixture). Don't assume the default `db`
fixture validates FK behavior.

## Install gotcha
**Why:** Installing pytest via the package-management tool (`uv add`) fails on
this image with `Permission denied` writing into the read-only `/nix/store`
python. Plain `pip install pytest` works because pip targets the writable
`.pythonlibs` prefix. Prefer `pip install` for dev/test-only packages here.
