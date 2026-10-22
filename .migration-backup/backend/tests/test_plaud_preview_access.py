"""Private Plaud data must never be attached to the shared preview account."""
import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models import User
from app.routers import auth, plaud


@pytest.fixture
def preview_user(db, monkeypatch):
    monkeypatch.setenv("PREVIEW_AUTH_BYPASS", "1")
    monkeypatch.delenv("REPLIT_DEPLOYMENT", raising=False)
    monkeypatch.delenv("REPLIT_DEPLOYMENT_ID", raising=False)
    result = auth.preview_login(db=db)
    return db.get(User, result.user.id)


def test_preview_status_requires_personal_sign_in(db, preview_user):
    result = plaud.plaud_status(db=db, user=preview_user)
    assert result["preview_only"] is True
    assert result["connected"] is False
    assert result["oauth_configured"] is False


@pytest.mark.parametrize("action", ["connect", "sync"])
def test_preview_cannot_connect_or_sync_private_recordings(db, preview_user, monkeypatch, action):
    def unexpected_network_call(*args, **kwargs):
        pytest.fail("Preview account must be rejected before calling Plaud")

    monkeypatch.setattr(plaud.oauth, "authorize_url", unexpected_network_call)
    monkeypatch.setattr(plaud.oauth, "get_valid_access_token", unexpected_network_call)
    with pytest.raises(HTTPException) as exc:
        if action == "connect":
            plaud.plaud_oauth_start(db=db, user=preview_user)
        else:
            plaud.plaud_sync(BackgroundTasks(), db=db, user=preview_user)
    assert exc.value.status_code == 403


def test_preview_callback_cannot_finish_connection(db, preview_user, monkeypatch):
    monkeypatch.setattr(plaud.oauth, "verify_state", lambda state: {"uid": preview_user.id})
    def unexpected_exchange(*args, **kwargs):
        pytest.fail("Preview callback must be rejected before exchanging tokens")
    monkeypatch.setattr(plaud.oauth, "complete_connection", unexpected_exchange)
    response = plaud.plaud_oauth_callback(db=db, code="test-code", state="test-state", error=None)
    assert response.status_code == 302
    assert "plaud_error=" in response.headers["location"]
    assert "plaud=connected" not in response.headers["location"]


def test_personal_account_can_start_plaud_connection(db, user, monkeypatch):
    monkeypatch.setattr(plaud.oauth, "authorize_url", lambda db, user: "https://test.plaud.ai/authorize")
    assert plaud.plaud_oauth_start(db=db, user=user) == {
        "authorize_url": "https://test.plaud.ai/authorize",
    }
