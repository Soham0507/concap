#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PYTHONPATH="$ROOT/.pythonlibs/lib/python3.12/site-packages${PYTHONPATH:+:$PYTHONPATH}"
exec python "$ROOT/artifacts/concap/serve.py"
