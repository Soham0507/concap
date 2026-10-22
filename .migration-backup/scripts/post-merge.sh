#!/bin/bash
set -e

# Install backend Python dependencies (including test-only deps like pytest).
# The Nix-provided interpreter is "externally managed" (PEP 668), so pip needs
# --break-system-packages to install into the user .pythonlibs prefix.
python -m pip install --break-system-packages --quiet -r backend/requirements.txt
