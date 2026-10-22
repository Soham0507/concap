---
name: Python deps live in .pythonlibs
description: How to install Python packages in this repl, and the python-version symlink trap that breaks fastapi imports.
---

# Installing Python packages

`pyproject.toml` is essentially empty — the project's real dependencies live only in `.pythonlibs/lib/python3.12/site-packages`. `uv` and plain `pip install` both fail here.

**Install pattern:**
```
python -m pip install --break-system-packages --target .pythonlibs/lib/python3.12/site-packages <pkg>
```

**Why:** `--target` puts packages where the interpreter already looks; without it they land somewhere the app can't import.

**How to apply:** any new backend dependency (this is how `anthropic`, `fpdf2`, `python-docx` were added).

**ALSO declare it in `backend/requirements.txt`.** `scripts/post-merge.sh` runs `pip install -r backend/requirements.txt` after every task merge, and `.pythonlibs` is NOT git-tracked. So a package installed only via `--target` works locally but can silently vanish on a clean install / VM deploy / post-merge. An undeclared import is a latent break (fpdf2 + python-docx were historically missing from requirements.txt despite being imported by the export code).

## python symlink trap
**Why:** installing a `python-3.11` language module repoints the `python` symlink to 3.11, but all deps are under 3.12 → fastapi (and everything) stops importing.

**How to apply:** if `python` suddenly can't find fastapi, check `python --version`. Restore with `installProgrammingLanguage({language:"python-3.12"})` via code_execution. Keep the runtime on 3.12.
