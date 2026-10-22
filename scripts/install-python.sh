#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p "$ROOT/.pythonlibs/lib/python3.12"
STAGING="$(mktemp -d "$ROOT/.pythonlibs/lib/python3.12/install.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
# Install into an empty target so old distribution metadata cannot survive
# beside newer module files. A failed install leaves working dependencies intact.
python -m pip install --break-system-packages \
  --target "$STAGING" \
  -c artifacts/api-server/backend/constraints.txt \
  -r artifacts/api-server/backend/requirements.txt
python - "$STAGING" "$ROOT/.pythonlibs/lib/python3.12/site-packages" <<'PY'
from pathlib import Path
import shutil
import sys

staging, target = map(Path, sys.argv[1:])
previous = target.with_name("site-packages.previous")
if previous.exists():
    shutil.rmtree(previous)
if target.exists():
    target.rename(previous)
try:
    staging.rename(target)
except BaseException:
    if previous.exists():
        previous.rename(target)
    raise
if previous.exists():
    shutil.rmtree(previous)
PY
