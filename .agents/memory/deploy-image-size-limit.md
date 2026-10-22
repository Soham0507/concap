---
name: Deployment image 8 GiB limit
description: Publish build failed "image size is over the limit of 8 GiB" — runtime data dir ships in the image; fix with .replitignore, never exclude .pythonlibs.
---

# Deployment image exceeds 8 GiB

**Symptom:** publish build fails near the end with `error: image size is over the
limit of 8 GiB` (build phase otherwise fine; the "Created Repl layer" step takes
many minutes because it is packing gigabytes).

**Root cause:** Replit's deployment image packs the whole workspace and does **NOT
honor `.gitignore`**. Dev-accumulated runtime data ships in the image even though
it is git-ignored. Here the bloat was `backend/data/audio` (~6.4 GB of uploaded
meeting recordings); the app writes uploads there at runtime and they pile up in
dev.

**Fix:** add a `.replitignore` (same syntax as `.gitignore`, but for the
deployment image). Exclude runtime data + tooling caches: `backend/data/`,
`data/`, `.cache/`, `.local/`, `.git/`, `attached_assets/`, `__pycache__`,
test dirs. Safe because the app self-creates its data dirs at runtime
(`config.audio_path` mkdirs on access; every upload router mkdirs its target).

**CRITICAL — do NOT exclude `.pythonlibs/`:** this project's `pyproject.toml` is
empty, so the deploy build's `uv sync` resolves ~nothing. The actual Python deps
live in `.pythonlibs` and are shipped *in the image*. Excluding it breaks prod
(no fastapi/uvicorn). See `python-deps-pythonlibs.md`.

**Why:** the limit is on the packed image, not git. The lever is `.replitignore`,
and the trap is that the very dir holding dependencies (`.pythonlibs`) looks like
a cache but is load-bearing for this repo.
