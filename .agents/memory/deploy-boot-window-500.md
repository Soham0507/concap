---
name: VM deploy 500s during cold-start boot window
description: Why a fresh publish can show "Internal Server Error" / healthcheck 500s that are transient, not a code crash.
---

# Deploy healthcheck 500s are often just the boot window, not a crash

**Symptom:** immediately after a publish the app shows plain "Internal Server
Error" and deployment logs are a wall of `healthcheck / returned status 500`,
sometimes preceded by `connection refused` and even
`a port configuration was specified but the required port was never opened,
expected port 5000`.

**Root cause:** the proxy/healthcheck hits `/` before uvicorn has finished its
(slow) cold start and bound port 5000. During that window the proxy returns 500
(plain text — NOT the app's custom JSON exception handler, which is the tell that
the app code never even ran). On a fresh VM the first container can exceed the
startup grace period and get killed ("port never opened"); the platform then
retries and the next container comes up fine.

**How to diagnose:** scroll the FULL deployment log to the END, not just the 500
spam at the top. Look for a later block:
`INFO: Started server process` → `Application startup complete` →
`"GET / HTTP/1.1" 200 OK`. If that appears and there are no errors after it, the
deploy self-recovered and is healthy. Confirm by curling
`"$PUBLIC_BASE_URL/api/health"` (expect 200, `db_ready:true`). Do NOT assume the
latest code change crashed `/`.

**Rule out a real crash:** if the app code had thrown, you'd see the custom JSON
error body (`{error,detail,traceback}`) or a Python traceback in the logs, not
the generic "Internal Server Error".

**Durable fix when the FIRST container is consistently killed with "port never
opened":** uvicorn cannot bind port 5000 until `import app.main` finishes, and
that import eagerly pulls every router -> service -> heavy SDK. On a cold VM,
heavy SDKs balloon: `openai` (~1.55s warm) and `google.cloud.vision` (~0.87s
warm) multiplied to ~15s cold, exceeding the deploy startup grace period.
Profile with `python -X importtime -c "import app.main"`. The fix is to
**lazy-import heavy third-party SDKs inside the functions that use them** (not at
module top level): routes still register instantly so `/` and `/api/health`
respond immediately and the port opens fast; the SDK loads on first real use.
Watch the annotation trap — a file without `from __future__ import annotations`
that has `def f() -> OpenAI:` will NameError once the import is deferred; add the
future import or quote the annotation.
**Why:** the bottleneck is pre-bind import time, not the app logic; deferring it
is what lets the deploy pass its first healthcheck instead of crash-looping.
