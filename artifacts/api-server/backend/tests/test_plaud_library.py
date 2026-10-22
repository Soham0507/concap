"""Imported Plaud data is readable on Concap, scoped to its importing user."""
import pytest
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.database import get_db
from app.config import Settings
from app.models import MeetingDocument, Organization, PlaudRecording, User
from app.routers import auth, plaud
from app.services import plaud_mcp, plaud_oauth
from app.services.crypto import encrypt


def test_embedded_client_name_cannot_be_mistaken_for_account_oauth(monkeypatch):
    monkeypatch.delenv("PLAUD_ACCOUNT_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("PLAUD_ACCOUNT_OAUTH_CLIENT_SECRET", raising=False)
    monkeypatch.setenv("Plaud_Client_ID", "embedded-test-client")
    monkeypatch.setenv("Plaud_Secret_Key", "embedded-test-secret")
    settings = Settings(_env_file=None)
    assert settings.plaud_client_id == ""
    assert settings.plaud_client_secret == ""
    monkeypatch.setenv("PLAUD_ACCOUNT_OAUTH_CLIENT_ID", "account-test-client")
    monkeypatch.setenv("PLAUD_ACCOUNT_OAUTH_CLIENT_SECRET", "account-test-secret")
    settings = Settings(_env_file=None)
    assert settings.plaud_client_id == "account-test-client"
    assert settings.plaud_client_secret == "account-test-secret"


def recording(db, user, *, title="A recording", text="Original transcript", summary="Plaud summary"):
    doc = MeetingDocument(
        org_id=user.org_id, user_id=user.id, transcript_id=f"TRX-{user.id}-{title}",
        meeting_source="plaud", transcript_text=text, source_summary=summary,
        document_markdown="Concap minutes", status="completed",
    )
    db.add(doc)
    db.flush()
    row = PlaudRecording(
        org_id=user.org_id, user_id=user.id, plaud_file_id=f"file-{user.id}-{title}",
        title=title, document_id=doc.id,
    )
    db.add(row)
    db.commit()
    return row


def test_imported_text_available_without_provider_connection(db, user, monkeypatch):
    row = recording(db, user, text="<script>alert(1)</script>", summary="Original Plaud note")
    monkeypatch.setattr(plaud_oauth, "get_valid_access_token", lambda *_: pytest.fail("No provider call"))
    result = plaud.plaud_recording_detail(row.id, db=db, user=user)
    assert result["transcript"] == "<script>alert(1)</script>"
    assert result["plaud_summary"] == "Original Plaud note"
    assert result["meeting_analysis"] == "Concap minutes"
    assert result["analysis_status"] == "completed"
    assert "access_token" not in result


def test_library_only_lists_current_user_and_org(db, user):
    own = recording(db, user)
    colleague = User(org_id=user.org_id, email="other@test.invalid", password_hash="x")
    db.add(colleague)
    db.commit()
    other = recording(db, colleague)
    result = plaud.plaud_recordings(limit=20, offset=0, db=db, user=user)
    assert result["total"] == 1
    assert result["items"][0]["id"] == own.id
    with pytest.raises(HTTPException) as exc:
        plaud.plaud_recording_detail(other.id, db=db, user=user)
    assert exc.value.status_code == 404

    different_org = Organization(name="Other workspace", org_type="company")
    db.add(different_org)
    db.commit()
    user.org_id = different_org.id
    db.commit()
    assert plaud.plaud_recordings(limit=20, offset=0, db=db, user=user)["total"] == 0
    with pytest.raises(HTTPException) as exc:
        plaud.plaud_recording_detail(own.id, db=db, user=user)
    assert exc.value.status_code == 404


def test_library_pagination_and_deleted_source(db, user):
    first = recording(db, user, title="First")
    second = recording(db, user, title="Second")
    page = plaud.plaud_recordings(limit=1, offset=0, db=db, user=user)
    assert page["total"] == 2
    assert page["items"][0]["id"] == second.id
    assert plaud.plaud_recordings(limit=1, offset=1, db=db, user=user)["items"][0]["id"] == first.id
    second.document_id = None
    db.commit()
    detail = plaud.plaud_recording_detail(second.id, db=db, user=user)
    assert detail["transcript"] is None
    assert detail["analysis_status"] == "unavailable"


def test_linked_document_cannot_cross_user_boundary(db, user):
    row = recording(db, user)
    doc = db.get(MeetingDocument, row.document_id)
    doc.user_id = None
    db.commit()
    assert plaud.plaud_recording_detail(row.id, db=db, user=user)["plaud_summary"] is None


def test_library_denies_shared_preview(db, monkeypatch):
    monkeypatch.setenv("PREVIEW_AUTH_BYPASS", "1")
    monkeypatch.delenv("REPLIT_DEPLOYMENT", raising=False)
    monkeypatch.delenv("REPLIT_DEPLOYMENT_ID", raising=False)
    user = db.get(User, auth.preview_login(db=db).user.id)
    for action in (
        lambda: plaud.plaud_recordings(limit=20, offset=0, db=db, user=user),
        lambda: plaud.plaud_recording_detail(1, db=db, user=user),
    ):
        with pytest.raises(HTTPException) as exc:
            action()
        assert exc.value.status_code == 403


def test_library_http_validation_and_auth(db, user):
    app = FastAPI()
    app.include_router(plaud.router)
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)
    assert client.get("/api/plaud/recordings").status_code == 401
    app.dependency_overrides[auth.require_user] = lambda: user
    assert client.get("/api/plaud/recordings?limit=101").status_code == 422
    assert client.get("/api/plaud/recordings?offset=-1").status_code == 422
    assert client.get("/api/plaud/recordings/not-a-number").status_code == 422


def test_sync_results_can_be_read_in_library(db, user, monkeypatch):
    user.plaud_access_token_enc = encrypt("test-token")
    db.commit()
    monkeypatch.setattr(plaud_oauth, "get_valid_access_token", lambda *_: "test-token")
    monkeypatch.setattr(plaud_mcp, "list_files", lambda *_: [{"id": "cloud-file", "title": "Cloud meeting"}])
    monkeypatch.setattr(plaud_mcp, "get_transcript", lambda *_: "This is the original Plaud transcript for the meeting.")
    monkeypatch.setattr(plaud_mcp, "get_note", lambda *_: {"text": "Original Plaud summary"})
    result = plaud.plaud_sync(BackgroundTasks(), db=db, user=user)
    assert result["imported"] == 1
    page = plaud.plaud_recordings(limit=20, offset=0, db=db, user=user)
    detail = plaud.plaud_recording_detail(page["items"][0]["id"], db=db, user=user)
    assert detail["plaud_summary"] == "Original Plaud summary"
    assert detail["transcript"].startswith("This is the original Plaud transcript")
    assert detail["conversation_id"] is not None
    assert detail["document_id"] is not None
