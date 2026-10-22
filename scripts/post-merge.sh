#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Local databases, audio, and Python packages are intentionally not committed.
# Transfer them from the migration backup on merge without replacing newer files.
python scripts/restore-migration-data.py
bash scripts/install-python.sh
pnpm install --frozen-lockfile
