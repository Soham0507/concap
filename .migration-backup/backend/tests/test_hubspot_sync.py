"""Offline tests for the HubSpot conversation sync engine.

These exercise the higher-level orchestration (`sync_conversation`) and the
new pieces — granular toggles, AI-insight custom properties, and idempotent
task creation — by stubbing `hubspot._request` so no network is touched.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

import pytest

from app.models import Company, Conversation, Visitor
from app.services import hubspot
from app.services.crypto import encrypt


@pytest.fixture(autouse=True)
def _reset_property_cache():
    """The ensured-properties cache is process-global; clear it per test so
    `ensure_custom_properties` actually issues its POSTs each time."""
    hubspot._ensured_property_portals.clear()
    yield
    hubspot._ensured_property_portals.clear()


@pytest.fixture
def connected_org(db, org):
    """Give the org a (non-expired) encrypted token so credential resolution
    takes the connected path without hitting the refresh endpoint."""
    org.hubspot_access_token_enc = encrypt("access-token")
    org.hubspot_refresh_token_enc = encrypt("refresh-token")
    org.hubspot_token_expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
    org.hubspot_needs_reconnect = False
    db.commit()
    return org


def _make_conversation(db, org, **analysis_over):
    visitor = Visitor(
        org_id=org.id,
        name="Jane Buyer",
        email="jane@acme.test",
        phone="+1 555 0100",
        company="Acme Inc",
    )
    db.add(visitor)
    db.commit()
    db.refresh(visitor)

    company = Company(org_id=org.id, name="Acme Inc", website="acme.test")
    db.add(company)
    db.commit()
    db.refresh(company)

    analysis = {
        "summary": "Great booth chat about the widget.",
        "intent": "evaluating",
        "sentiment": "positive",
        "urgency": "high",
        "buying_role": "decision maker",
        "budget_range": "$10k-$20k",
        "action_items": ["Send pricing deck", "Schedule a demo"],
        "next_action": "Email the proposal tomorrow",
    }
    analysis.update(analysis_over)

    conv = Conversation(
        org_id=org.id,
        visitor_id=visitor.id,
        company_id=company.id,
        status="analyzed",
        transcript="Hello there, tell me about pricing...",
        analysis=analysis,
        lead_score=82,
        lead_temperature="hot",
        created_at=datetime.now(timezone.utc),
    )
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return conv


class _Recorder:
    """Stub for hubspot._request that records calls and returns canned ids.

    Each POST to an object collection returns an incrementing fake id so the
    sync flow has contact/company/note/task/deal ids to thread through.
    """

    def __init__(self):
        self.calls: list[tuple[str, str, dict | None]] = []
        self._counter = 0

    def __call__(self, method, path, *, json=None, params=None):
        self.calls.append((method, path, json))
        # Search calls return "no match" so upserts take the create branch.
        if path.endswith("/search"):
            return {"results": []}
        # A create POST to a top-level object collection returns a fresh id.
        if method == "POST" and re.fullmatch(
            r"/crm/v3/objects/(contacts|companies|notes|tasks|deals)", path
        ):
            self._counter += 1
            return {"id": str(1000 + self._counter)}
        # Everything else (associations, PATCH, property creation): no body.
        return None

    def paths(self, method=None):
        return [p for (m, p, _) in self.calls if method is None or m == method]

    def posts_to(self, fragment):
        return [(m, p, j) for (m, p, j) in self.calls if m == "POST" and fragment in p]


def _install(monkeypatch, recorder):
    monkeypatch.setattr(hubspot, "_request", recorder)
    # get_account_info uses _request under the hood; force a portal id directly
    # so the URL builders have something deterministic.
    monkeypatch.setattr(hubspot, "get_account_info", lambda: {"portal_id": "42"})


def test_full_sync_creates_tasks_and_insights(db, connected_org, monkeypatch):
    conv = _make_conversation(db, connected_org)
    rec = _Recorder()
    _install(monkeypatch, rec)

    result = hubspot.sync_conversation(db, conv.id)

    assert result["ok"] is True
    # Custom property group + properties were ensured.
    assert any("/properties/contacts/groups" in p for p in rec.paths("POST"))
    assert any(p == "/crm/v3/properties/contacts" for p in rec.paths("POST"))
    # Insights PATCH onto the contact carried our custom concap_* props.
    patches = [(p, j) for (m, p, j) in rec.calls if m == "PATCH" and "/objects/contacts/" in p]
    assert patches, "expected a contact PATCH for insights"
    insight_props = {}
    for _, j in patches:
        insight_props.update((j or {}).get("properties", {}))
    assert insight_props.get("concap_lead_score") == 82
    assert insight_props.get("concap_lead_quality") == "hot"
    # Tasks: 2 action items + 1 next_action = 3 distinct tasks.
    task_posts = rec.posts_to("/objects/tasks")
    assert len(task_posts) == 3
    # Task ids recorded on the conversation for idempotency.
    db.refresh(conv)
    assert conv.hubspot_task_ids is not None
    assert len(conv.hubspot_task_ids) == 3
    assert result["task_ids"]


def test_resync_does_not_duplicate_tasks(db, connected_org, monkeypatch):
    conv = _make_conversation(db, connected_org)
    rec = _Recorder()
    _install(monkeypatch, rec)
    hubspot.sync_conversation(db, conv.id)

    # Second sync with the same action items: no new task POSTs.
    rec2 = _Recorder()
    _install(monkeypatch, rec2)
    hubspot.sync_conversation(db, conv.id)
    assert rec2.posts_to("/objects/tasks") == []

    db.refresh(conv)
    assert len(conv.hubspot_task_ids) == 3


def test_new_action_item_on_resync_adds_only_new_task(db, connected_org, monkeypatch):
    conv = _make_conversation(db, connected_org)
    rec = _Recorder()
    _install(monkeypatch, rec)
    hubspot.sync_conversation(db, conv.id)

    # Add a brand-new action item and re-sync.
    conv.analysis = {**conv.analysis, "action_items": ["Send pricing deck", "Schedule a demo", "Loop in legal"]}
    db.commit()
    rec2 = _Recorder()
    _install(monkeypatch, rec2)
    hubspot.sync_conversation(db, conv.id)

    assert len(rec2.posts_to("/objects/tasks")) == 1
    db.refresh(conv)
    assert len(conv.hubspot_task_ids) == 4


def test_toggles_gate_tasks_and_insights(db, connected_org, monkeypatch):
    connected_org.hubspot_sync_tasks = False
    connected_org.hubspot_sync_insights = False
    db.commit()
    conv = _make_conversation(db, connected_org)
    rec = _Recorder()
    _install(monkeypatch, rec)

    hubspot.sync_conversation(db, conv.id)

    assert rec.posts_to("/objects/tasks") == []
    # No custom-property group ensured when insights are off.
    assert not any("/properties/contacts/groups" in p for p in rec.paths("POST"))
    db.refresh(conv)
    assert not conv.hubspot_task_ids


def test_notes_toggle_off_skips_note(db, connected_org, monkeypatch):
    connected_org.hubspot_sync_notes = False
    db.commit()
    conv = _make_conversation(db, connected_org)
    rec = _Recorder()
    _install(monkeypatch, rec)

    result = hubspot.sync_conversation(db, conv.id)

    assert rec.posts_to("/objects/notes") == []
    assert result["note_id"] is None


def test_transcript_toggle_excludes_transcript_from_note(db, connected_org, monkeypatch):
    connected_org.hubspot_sync_transcript = False
    db.commit()
    conv = _make_conversation(db, connected_org)
    rec = _Recorder()
    _install(monkeypatch, rec)

    hubspot.sync_conversation(db, conv.id)

    note_posts = rec.posts_to("/objects/notes")
    assert note_posts, "note should still be created"
    body = note_posts[0][2]["properties"]["hs_note_body"]
    assert "Transcript" not in body
    assert "tell me about pricing" not in body


def test_unknown_portal_does_not_suppress_other_orgs_properties(db, connected_org, monkeypatch):
    """When account-info fails (portal id unknown), the property bootstrap must
    re-attempt for every org instead of caching a shared sentinel that would
    skip creation for later tenants."""
    # Two separate conversations standing in for two separate org syncs.
    conv_a = _make_conversation(db, connected_org)
    conv_b = _make_conversation(db, connected_org)
    # Force the portal id to be unknown for both syncs.
    monkeypatch.setattr(hubspot, "get_account_info", lambda: {})

    rec = _Recorder()
    monkeypatch.setattr(hubspot, "_request", rec)
    hubspot.sync_conversation(db, conv_a.id)
    groups_after_a = [p for p in rec.paths("POST") if "/properties/contacts/groups" in p]
    assert groups_after_a, "first sync should attempt property-group creation"

    rec2 = _Recorder()
    monkeypatch.setattr(hubspot, "_request", rec2)
    hubspot.sync_conversation(db, conv_b.id)
    groups_after_b = [p for p in rec2.paths("POST") if "/properties/contacts/groups" in p]
    assert groups_after_b, "second sync (unknown portal) must still attempt creation"


def test_tasks_set_default_owner_when_configured(db, connected_org, monkeypatch):
    connected_org.hubspot_default_owner_id = "777"
    db.commit()
    conv = _make_conversation(db, connected_org)
    rec = _Recorder()
    _install(monkeypatch, rec)

    hubspot.sync_conversation(db, conv.id)

    task_posts = rec.posts_to("/objects/tasks")
    assert task_posts, "tasks should be created"
    for _, _, payload in task_posts:
        assert payload["properties"].get("hubspot_owner_id") == "777"


def test_tasks_omit_owner_when_not_configured(db, connected_org, monkeypatch):
    # No default owner configured (the default).
    conv = _make_conversation(db, connected_org)
    rec = _Recorder()
    _install(monkeypatch, rec)

    hubspot.sync_conversation(db, conv.id)

    task_posts = rec.posts_to("/objects/tasks")
    assert task_posts, "tasks should still be created without an owner"
    for _, _, payload in task_posts:
        assert "hubspot_owner_id" not in payload["properties"]


def test_list_owners_paginates_and_shapes(db, connected_org, monkeypatch):
    pages = [
        {
            "results": [
                {"id": "1", "firstName": "Ada", "lastName": "Lovelace", "email": "ada@acme.test"},
                {"id": "2", "firstName": "", "lastName": "", "email": "ops@acme.test"},
            ],
            "paging": {"next": {"after": "cursor1"}},
        },
        {"results": [{"id": "3", "firstName": "Grace", "lastName": "Hopper", "email": ""}]},
    ]
    seen_after: list[str | None] = []

    def fake_request(method, path, *, json=None, params=None):
        assert method == "GET" and path == "/crm/v3/owners"
        seen_after.append((params or {}).get("after"))
        return pages.pop(0)

    monkeypatch.setattr(hubspot, "_request", fake_request)
    with hubspot.use_org_context("tok", {}):
        owners = hubspot.list_owners()

    assert seen_after == [None, "cursor1"]
    assert owners == [
        {"id": "1", "email": "ada@acme.test", "name": "Ada Lovelace"},
        {"id": "2", "email": "ops@acme.test", "name": "ops@acme.test"},
        {"id": "3", "email": "", "name": "Grace Hopper"},
    ]


def test_generic_next_action_is_skipped_as_task(db, connected_org, monkeypatch):
    conv = _make_conversation(
        db, connected_org,
        action_items=[],
        next_action="Follow up to gather more information.",
    )
    rec = _Recorder()
    _install(monkeypatch, rec)

    hubspot.sync_conversation(db, conv.id)

    assert rec.posts_to("/objects/tasks") == []
