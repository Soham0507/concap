"""Regression: a fresh deploy must self-create the SQLite data directory.

The `data/` folder is gitignored, so it is absent from a clean build. SQLite
will NOT create intermediate directories and crashes with "unable to open
database file" — which previously surfaced as an "Internal Server Error" right
after publishing. `_ensure_sqlite_dir` must create the parent directory so the
first boot succeeds.
"""
from __future__ import annotations

import os
import tempfile

from app.database import _ensure_sqlite_dir


def test_creates_missing_nested_dir():
    root = tempfile.mkdtemp()
    db_file = os.path.join(root, "data", "nested", "booth.db")
    assert not os.path.exists(os.path.dirname(db_file))

    _ensure_sqlite_dir(f"sqlite:///{db_file}")

    assert os.path.isdir(os.path.dirname(db_file))


def test_idempotent_when_dir_exists():
    root = tempfile.mkdtemp()
    db_file = os.path.join(root, "booth.db")
    # Directory already exists; should be a no-op (no error).
    _ensure_sqlite_dir(f"sqlite:///{db_file}")
    _ensure_sqlite_dir(f"sqlite:///{db_file}")
    assert os.path.isdir(root)


def test_absolute_file_url():
    root = tempfile.mkdtemp()
    db_file = os.path.join(root, "abs", "booth.db")
    # Absolute SQLite URL uses four slashes: sqlite:////abs/path.db
    _ensure_sqlite_dir(f"sqlite:///{db_file}")
    assert os.path.isdir(os.path.dirname(db_file))


def test_non_file_urls_are_noops():
    # In-memory and non-sqlite URLs must not raise.
    _ensure_sqlite_dir("sqlite://")
    _ensure_sqlite_dir("sqlite:///:memory:")
    _ensure_sqlite_dir("postgresql://user:pass@host/db")
