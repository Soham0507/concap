# Concap

Concap captures conversations, manages contacts and companies, imports meetings,
and drafts proposals. This is an existing product: preserve its original UI and
Python backend rather than rebuilding features in the workspace scaffold.

## Run & operate

- Website: managed workflow `artifacts/concap: web`.
- Backend: managed workflow `artifacts/api-server: API Server`.
- Python 3.12 is required. Dependencies are declared in
  `artifacts/api-server/backend/requirements.txt` and installed into
  `.pythonlibs/lib/python3.12/site-packages` by `scripts/install-python.sh`.
  The constraints file preserves pre-port versions; do not upgrade libraries as
  part of migration or companion work without checking legacy behavior.
- Tests: `cd backend && python -m pytest`.
- `scripts/post-merge.sh` preserves untracked migration data without overwriting
  newer files, reinstalls Python dependencies, and installs workspace packages.

## Workspace layout

- `artifacts/concap/frontend/`: original HTML, CSS, JavaScript and brand assets.
  `serve.py` serves the unchanged website routes and service worker.
- `artifacts/api-server/backend/`: original FastAPI/SQLAlchemy service, schema
  migrations, integrations and workers.
- Root `backend` and `frontend` symlinks retain compatibility with old paths.
- `lib/*` and the mockup sandbox are pre-existing scaffold packages. The legacy
  app does not use Drizzle or generated React hooks.

## Preservation constraints

- Keep the existing database connection and data technology. Do not run scaffold
  database pushes or create a replacement database.
- Backend launches from its original logical working directory; relative data
  and audio paths retain their meaning. Existing uploads, databases and backups
  remain private, untracked files.
- Development alone opts into isolated preview login. Never enable preview login
  in production or connect personal Plaud data as the shared preview user.
- Preserve same-origin `/api` paths, OAuth callbacks, authorization and org/user
  scoping. Only the Python backend starts the meeting worker.
- Preserve Concap's logos, Fraunces typography, theme tokens, light/dark behavior
  and navigation. Do not load the unused React scaffold UI.
- Existing personal-account Plaud import remains intact. Native companion and
  Plaud Embedded work are separate from this migration.
