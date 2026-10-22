"""Tests for the Multi-Brand Quote Agent — brand CRUD, default management, asset
upload, and the brand's effect on quote drafting / export / history filtering.

Fully offline: routes are called directly (the suite's convention), the Anthropic
key check is forced "configured", and chat_turn is monkeypatched, so no network or
real credentials run. Asset uploads use plain text, which document_parse handles
natively (no external parsers needed).
"""
from __future__ import annotations

import asyncio
import io

import pytest
from fastapi import HTTPException
from starlette.datastructures import Headers, UploadFile

from app.models import Brand, Conversation, Organization, User, Visitor
from app.routers import brands as brouter
from app.routers import quotes as qrouter


# --- fixtures / helpers ---------------------------------------------------

def _user(db, org, email="rep@example.com", role="owner") -> User:
    u = User(org_id=org.id, email=email, name="Rep", password_hash="x", role=role)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _other_org_user(db) -> User:
    o = Organization(name="Other Org", org_type="company")
    db.add(o)
    db.commit()
    db.refresh(o)
    return _user(db, o, email="intruder@example.com")


def _visitor(db, org, name="Jane Doe", company="Acme") -> Visitor:
    v = Visitor(org_id=org.id, name=name, company=company)
    db.add(v)
    db.commit()
    db.refresh(v)
    return v


def _conversation(db, org, visitor, transcript="We need 100 widgets next quarter.") -> Conversation:
    conv = Conversation(
        org_id=org.id,
        visitor_id=visitor.id,
        transcript=transcript,
        topic="Widget supply",
        status="analyzed",
    )
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return conv


def _upload(filename: str, data: bytes) -> UploadFile:
    return UploadFile(
        file=io.BytesIO(data),
        filename=filename,
        headers=Headers({"content-type": "application/octet-stream"}),
    )


def _make_brand(db, user, **over) -> dict:
    body = brouter.BrandIn(
        name=over.pop("name", "Aurora"),
        company_name=over.pop("company_name", "Aurora Marine Ltd"),
        currency=over.pop("currency", "€"),
        primary_color=over.pop("primary_color", "#0E2A47"),
        accent_color=over.pop("accent_color", "#FF5B2E"),
        **over,
    )
    return brouter.create_brand(body, db=db, user=user)


@pytest.fixture
def ai_ok(monkeypatch):
    """Force the AI 'configured' check on and replace chat_turn with a
    deterministic stub that records the context it was handed so brand wiring is
    observable."""
    monkeypatch.setattr(qrouter.quote_ai, "describe_anthropic_problem", lambda: None)

    seen = {}

    def _turn(context, current, history, message):
        seen["context"] = context
        if current is None:
            return {
                "reply": "First draft.",
                "title": "Widget Supply Proposal",
                "client_name": context.get("client_name"),
                "client_company": context.get("client_company"),
                "proposal_text": "Here's our proposal.",
                "line_items": [{"description": "Widgets", "quantity": 100, "unit_price": 5.0}],
                "notes": "Valid for 30 days.",
            }
        return {
            "reply": "Revised.",
            "title": current.get("title"),
            "client_name": None,
            "client_company": None,
            "proposal_text": (current.get("proposal_text") or "") + " (revised)",
            "line_items": current.get("line_items") or [],
            "notes": current.get("notes"),
        }

    monkeypatch.setattr(qrouter.quote_ai, "chat_turn", _turn)
    return seen


# --- brand CRUD ----------------------------------------------------------

def test_create_first_brand_becomes_default(db, org):
    user = _user(db, org)
    out = _make_brand(db, user)
    assert out["id"] > 0
    assert out["name"] == "Aurora"
    assert out["company_name"] == "Aurora Marine Ltd"
    assert out["currency"] == "€"
    # The org's first brand is auto-defaulted so the selector has a pre-selection.
    assert out["is_default"] is True


def test_second_brand_is_not_default(db, org):
    user = _user(db, org)
    _make_brand(db, user, name="Aurora")
    second = _make_brand(db, user, name="Borealis")
    assert second["is_default"] is False


def test_list_brands_scoped_and_ordered(db, org):
    user = _user(db, org)
    _make_brand(db, user, name="Zephyr")
    _make_brand(db, user, name="Aurora")  # default (first created? no — Zephyr first)
    # An intruder's brand must not appear.
    intruder = _other_org_user(db)
    _make_brand(db, intruder, name="Intruder Brand")

    rows = brouter.list_brands(db=db, user=user)
    names = [r["name"] for r in rows]
    assert "Intruder Brand" not in names
    assert set(names) == {"Zephyr", "Aurora"}
    # Default first, then alphabetical. Zephyr was created first → default.
    assert rows[0]["name"] == "Zephyr"
    assert rows[0]["is_default"] is True
    # Summary carries the selector essentials.
    assert "currency" in rows[0] and "templates" in rows[0]


def test_get_brand_and_cross_org_404(db, org):
    user = _user(db, org)
    out = _make_brand(db, user)
    got = brouter.get_brand(out["id"], db=db, user=user)
    assert got["id"] == out["id"]

    intruder = _other_org_user(db)
    with pytest.raises(HTTPException) as ei:
        brouter.get_brand(out["id"], db=db, user=intruder)
    assert ei.value.status_code == 404


def test_update_brand_applies_full_state(db, org):
    user = _user(db, org)
    out = _make_brand(db, user)
    body = brouter.BrandIn(
        name="Aurora Renamed",
        company_name="Aurora Marine Ltd",
        currency="$",
        business_description="We fit out luxury yachts.",
        brand_voice="Warm, precise, premium.",
        terms="Net 30.",
        signature="Signed: Aurora",
        footer="Aurora Marine Ltd — confidential",
        templates=[brouter.TemplateIn(name="Standard SOW", template_type="sow", instructions="Use sections.")],
    )
    upd = brouter.update_brand(out["id"], body, db=db, user=user)
    assert upd["name"] == "Aurora Renamed"
    assert upd["currency"] == "$"
    assert upd["brand_voice"] == "Warm, precise, premium."
    assert len(upd["templates"]) == 1
    assert upd["templates"][0]["name"] == "Standard SOW"
    # The template was assigned a stable id.
    assert upd["templates"][0]["id"]


def test_blank_templates_are_dropped(db, org):
    user = _user(db, org)
    out = _make_brand(db, user)
    body = brouter.BrandIn(
        name="Aurora",
        templates=[
            brouter.TemplateIn(name="", instructions=""),  # dropped
            brouter.TemplateIn(name="Keeper", instructions="Do it."),
        ],
    )
    upd = brouter.update_brand(out["id"], body, db=db, user=user)
    assert [t["name"] for t in upd["templates"]] == ["Keeper"]


def test_update_cross_org_404(db, org):
    user = _user(db, org)
    out = _make_brand(db, user)
    intruder = _other_org_user(db)
    with pytest.raises(HTTPException) as ei:
        brouter.update_brand(out["id"], brouter.BrandIn(name="x"), db=db, user=intruder)
    assert ei.value.status_code == 404


# --- default management --------------------------------------------------

def test_set_default_moves_the_flag(db, org):
    user = _user(db, org)
    a = _make_brand(db, user, name="Aurora")  # default
    b = _make_brand(db, user, name="Borealis")
    upd = brouter.set_default_brand(b["id"], db=db, user=user)
    assert upd["is_default"] is True
    # The old default was cleared.
    assert brouter.get_brand(a["id"], db=db, user=user)["is_default"] is False


def test_delete_promotes_a_new_default(db, org):
    user = _user(db, org)
    a = _make_brand(db, user, name="Aurora")  # default
    b = _make_brand(db, user, name="Borealis")
    brouter.delete_brand(a["id"], db=db, user=user)
    # With the default gone, the surviving brand is promoted.
    assert brouter.get_brand(b["id"], db=db, user=user)["is_default"] is True


def test_delete_brand_detaches_quotes(db, org, ai_ok):
    # Deleting a brand must clear brand_id on quotes that used it (so upgraded DBs
    # without an ON DELETE SET NULL FK never carry a dangling pointer), while the
    # frozen branding_snapshot stays intact for the export.
    user = _user(db, org)
    visitor = _visitor(db, org)
    conv = _conversation(db, org, visitor)
    brand = _make_brand(db, user, name="Aurora")
    out = qrouter.chat(
        qrouter.ChatIn(message="Draft it", conversation_ids=[conv.id], brand_id=brand["id"]),
        db=db, user=user,
    )
    from app.models import Quote
    assert db.get(Quote, out["id"]).brand_id == brand["id"]

    brouter.delete_brand(brand["id"], db=db, user=user)
    db.expire_all()
    q = db.get(Quote, out["id"])
    assert q.brand_id is None
    # The export branding was frozen at creation, so it survives the brand delete.
    assert q.branding_snapshot["company_name"] == "Aurora Marine Ltd"


def test_delete_cross_org_404(db, org):
    user = _user(db, org)
    out = _make_brand(db, user)
    intruder = _other_org_user(db)
    with pytest.raises(HTTPException) as ei:
        brouter.delete_brand(out["id"], db=db, user=intruder)
    assert ei.value.status_code == 404


# --- asset upload --------------------------------------------------------

def test_upload_and_delete_asset(db, org):
    user = _user(db, org)
    out = _make_brand(db, user)
    files = [_upload("catalogue.txt", b"Premium teak decking. Hand-stitched leather.")]
    res = asyncio.run(
        brouter.upload_assets(out["id"], files=files, kind="catalog", db=db, user=user)
    )
    assert len(res["assets_meta"]) == 1
    assert res["assets_meta"][0]["name"] == "catalogue.txt"
    assert res["assets_meta"][0]["kind"] == "catalog"
    # The reference text is built from the uploaded doc.
    assert "teak decking" in (res["assets_text"] or "")
    # The public meta must NOT leak the bulky per-doc text.
    assert "text" not in res["assets_meta"][0]

    # Deleting the only asset clears the reference text.
    res2 = brouter.delete_asset(out["id"], 0, db=db, user=user)
    assert res2["assets_meta"] == []
    assert res2["assets_text"] is None


def test_delete_asset_out_of_range_404(db, org):
    user = _user(db, org)
    out = _make_brand(db, user)
    with pytest.raises(HTTPException) as ei:
        brouter.delete_asset(out["id"], 5, db=db, user=user)
    assert ei.value.status_code == 404


# --- quote drafting under a brand ----------------------------------------

def test_quote_with_brand_freezes_snapshot_and_sets_brand_id(db, org, ai_ok):
    user = _user(db, org)
    visitor = _visitor(db, org)
    conv = _conversation(db, org, visitor)
    body = brouter.BrandIn(
        name="Aurora",
        company_name="Aurora Marine Ltd",
        currency="€",
        terms="Net 30.",
        signature="Aurora team",
        footer="Confidential",
        brand_voice="Premium and warm.",
        business_description="Yacht fit-outs.",
        templates=[brouter.TemplateIn(name="SOW", template_type="sow", instructions="Sections please.")],
    )
    brand = brouter.create_brand(body, db=db, user=user)
    template_id = brand["templates"][0]["id"]

    out = qrouter.chat(
        qrouter.ChatIn(
            message="Draft it",
            conversation_ids=[conv.id],
            brand_id=brand["id"],
            template_id=template_id,
        ),
        db=db, user=user,
    )
    assert out["brand_id"] == brand["id"]
    assert out["brand_name"] == "Aurora"
    # The brand currency overrode the default.
    assert out["currency"] == "€"

    # The branding snapshot is frozen from the brand (export reads this), and the
    # selected template id was frozen in.
    from app.models import Quote
    q = db.get(Quote, out["id"])
    snap = q.branding_snapshot
    assert snap["company_name"] == "Aurora Marine Ltd"
    assert snap["terms"] == "Net 30."
    assert snap["template_id"] == template_id

    # The AI was handed the brand voice + template context, built fresh.
    brand_ctx = ai_ok["context"]["brand"]
    assert brand_ctx["voice"] == "Premium and warm."
    assert brand_ctx["template"]["instructions"] == "Sections please."


def test_quote_without_brand_unchanged(db, org, ai_ok):
    # Existing single-org behaviour: no brands at all → brand_id None, org branding.
    user = _user(db, org)
    visitor = _visitor(db, org)
    conv = _conversation(db, org, visitor)
    out = qrouter.chat(
        qrouter.ChatIn(message="Draft it", conversation_ids=[conv.id]),
        db=db, user=user,
    )
    assert out["brand_id"] is None
    assert out["brand_name"] is None
    # No brand context was injected into the AI turn.
    assert ai_ok["context"].get("brand") is None


def test_quote_falls_back_to_default_brand(db, org, ai_ok):
    # With a default brand and no explicit brand_id, the default is applied.
    user = _user(db, org)
    visitor = _visitor(db, org)
    conv = _conversation(db, org, visitor)
    brand = _make_brand(db, user, name="Aurora", currency="€")  # auto-default
    out = qrouter.chat(
        qrouter.ChatIn(message="Draft it", conversation_ids=[conv.id]),
        db=db, user=user,
    )
    assert out["brand_id"] == brand["id"]
    assert out["currency"] == "€"


def test_quote_cross_org_brand_404(db, org, ai_ok):
    user = _user(db, org)
    visitor = _visitor(db, org)
    conv = _conversation(db, org, visitor)
    intruder = _other_org_user(db)
    foreign = _make_brand(db, intruder, name="Foreign")
    with pytest.raises(HTTPException) as ei:
        qrouter.chat(
            qrouter.ChatIn(message="Draft it", conversation_ids=[conv.id], brand_id=foreign["id"]),
            db=db, user=user,
        )
    assert ei.value.status_code == 404


# --- branded export ------------------------------------------------------

def test_branded_export_renders(db, org, ai_ok):
    user = _user(db, org)
    visitor = _visitor(db, org)
    conv = _conversation(db, org, visitor)
    body = brouter.BrandIn(
        name="Aurora",
        company_name="Aurora Marine Ltd",
        currency="€",
        terms="**Net 30.** Payment due on receipt.",
        signature="Authorised: Aurora",
        footer="Aurora Marine Ltd — confidential",
    )
    brand = brouter.create_brand(body, db=db, user=user)
    out = qrouter.chat(
        qrouter.ChatIn(message="Draft it", conversation_ids=[conv.id], brand_id=brand["id"]),
        db=db, user=user,
    )
    pdf = qrouter.export_pdf(out["id"], db=db, user=user)
    docx = qrouter.export_docx(out["id"], db=db, user=user)
    assert pdf.media_type == "application/pdf"
    assert docx.media_type.endswith("wordprocessingml.document")


# --- history filtering ---------------------------------------------------

def test_list_quotes_filters_by_brand(db, org, ai_ok):
    user = _user(db, org)
    visitor = _visitor(db, org)
    conv = _conversation(db, org, visitor)
    a = _make_brand(db, user, name="Aurora")
    b = _make_brand(db, user, name="Borealis")
    qa = qrouter.chat(
        qrouter.ChatIn(message="Draft A", conversation_ids=[conv.id], brand_id=a["id"]),
        db=db, user=user,
    )
    qb = qrouter.chat(
        qrouter.ChatIn(message="Draft B", conversation_ids=[conv.id], brand_id=b["id"]),
        db=db, user=user,
    )

    all_rows = qrouter.list_quotes(limit=100, brand_id=None, db=db, user=user)
    assert {r["id"] for r in all_rows} == {qa["id"], qb["id"]}
    # Each row carries its brand name for grouping in the UI.
    by_id = {r["id"]: r for r in all_rows}
    assert by_id[qa["id"]]["brand_name"] == "Aurora"
    assert by_id[qb["id"]]["brand_name"] == "Borealis"

    only_a = qrouter.list_quotes(limit=100, brand_id=a["id"], db=db, user=user)
    assert {r["id"] for r in only_a} == {qa["id"]}
