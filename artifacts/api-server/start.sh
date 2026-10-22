#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PYTHONPATH="$ROOT/.pythonlibs/lib/python3.12/site-packages${PYTHONPATH:+:$PYTHONPATH}"
cd "$ROOT/artifacts/api-server/backend"
exec python -m uvicorn app.main:app --host 0.0.0.0 --port "${PORT:?PORT is required}"
