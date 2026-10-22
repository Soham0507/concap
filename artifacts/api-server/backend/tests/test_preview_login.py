"""Tests for the opt-in, preview-workspace login path."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.models import Organization, User
from app.routers import auth
from app.services.auth import decode_token


def _enable_preview(monkeypatch):
    monkeypatch.setenv("PREVIEW_AUTH_BYPASS", "1")
    monkeypatch.delenv("REPLIT_DEPLOYMENT", raising=False)
    monkeypatch.delenv("REPLIT_DEPLOYMENT_ID", raising=False)


def test_preview_login_creates_isolated_owner_and_token(db, monkeypatch):
    _enable_preview(monkeypatch)

    result = auth.preview_login(db)
    payload = decode_token(result.token)
    user = db.get(User, int(payload["sub"]))

    assert result.user.email == "preview@preview.example.com"
    assert result.user.role == "owner"
    assert result.user.organization.name == "Preview Workspace"
    assert payload["preview"] is True
    assert user is not None
    assert db.query(Organization).count() == 1


def test_preview_login_reuses_preview_workspace(db, monkeypatch):
    _enable_preview(monkeypatch)

    first = auth.preview_login(db)
    second = auth.preview_login(db)

    assert first.user.id == second.user.id
    assert db.query(User).count() == 1
    assert db.query(Organization).count() == 1


def test_preview_login_is_disabled_without_preview_opt_in(db, monkeypatch):
    monkeypatch.delenv("PREVIEW_AUTH_BYPASS", raising=False)

    with pytest.raises(HTTPException) as exc:
        auth.preview_login(db)

    assert exc.value.status_code == 404
    assert db.query(User).count() == 0
    assert db.query(Organization).count() == 0


@pytest.mark.parametrize("deployment_value", ["1", "true"])
def test_preview_login_is_disabled_in_deployment(db, monkeypatch, deployment_value):
    _enable_preview(monkeypatch)
    monkeypatch.setenv("REPLIT_DEPLOYMENT", deployment_value)

    with pytest.raises(HTTPException) as exc:
        auth.preview_login(db)

    assert exc.value.status_code == 404
    assert db.query(User).count() == 0
    assert db.query(Organization).count() == 0


def test_preview_enabled_endpoint_reports_runtime_setting(monkeypatch):
    _enable_preview(monkeypatch)
    assert auth.preview_enabled() == {"enabled": True}

    monkeypatch.setenv("REPLIT_DEPLOYMENT", "1")
    assert auth.preview_enabled() == {"enabled": False}


def test_preview_token_cannot_be_used_outside_preview(db, monkeypatch):
    _enable_preview(monkeypatch)
    result = auth.preview_login(db)
    assert auth.require_user(authorization="Bearer " + result.token, db=db).id == result.user.id

    monkeypatch.delenv("PREVIEW_AUTH_BYPASS", raising=False)
    with pytest.raises(HTTPException) as exc:
        auth.require_user(authorization="Bearer " + result.token, db=db)

    assert exc.value.status_code == 401


def test_normal_user_token_still_works_without_preview(db, user, monkeypatch):
    monkeypatch.delenv("PREVIEW_AUTH_BYPASS", raising=False)
    from app.services.auth import create_token

    token = create_token(user.id, user.email)
    assert auth.require_user(authorization="Bearer " + token, db=db).id == user.id
