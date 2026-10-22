"""Carry untracked legacy data across a fork/merge; never overwrite live files."""
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[1]
BACKUP = ROOT / ".migration-backup"
for source, target in (
    (BACKUP / "backend/data", ROOT / "artifacts/api-server/backend/data"),
    (BACKUP / "data", ROOT / "data"),
    (BACKUP / ".pythonlibs", ROOT / ".pythonlibs"),
):
    if not source.is_dir():
        continue
    for file in source.rglob("*"):
        if file.is_file():
            destination = target / file.relative_to(source)
            if not destination.exists():
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(file, destination)
