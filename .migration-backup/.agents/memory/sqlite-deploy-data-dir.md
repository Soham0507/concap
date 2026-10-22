---
name: SQLite data dir must self-create on deploy
description: Why fresh publishes 500'd with "Internal Server Error" and the durable fix + persistence caveat.
---

# SQLite on a fresh deploy: create the parent dir, and beware data loss

**Symptom:** every publish showed "Internal Server Error". On a clean build the
SQLite DB's `data/` directory is absent (it is gitignored), and SQLite will NOT
create intermediate directories — it raises "unable to open database file".
That crashed `init_db`, the readiness gate never opened, and all API routes
failed after publishing.

**Fix (durable rule):** before creating the engine, ensure the parent directory
of any file-backed SQLite DB exists (idempotent mkdir). The DB path's directory
is NOT created for free — only the audio dir was being created (as a side
effect of its accessor), which is why dev happened to work but fresh deploys
didn't.

**Why it kept recurring:** this deploy uses `deploymentTarget = "vm"` with
SQLite. A new publish rebuilds the filesystem from the repo, so the gitignored
`data/` dir (and the DB inside it) is gone each time.

**How to apply / caveat:** the dir-creation fix stops the error permanently, but
SQLite data does NOT persist across publishes on a VM deploy — each publish
starts with an empty DB. For durable multi-tenant data, migrate production to
PostgreSQL (the code already supports it via `database_url`; pool_pre_ping +
pool_recycle are wired for managed Postgres). Recommend Postgres when the user
needs data to survive deploys.
