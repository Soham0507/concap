"""Tests for the bulk business-card upload endpoint.

These run fully offline: the Vision scan is mocked so no network or real
credentials are needed. The focus is the batch envelope — partial success
(one bad image must not abort the rest) and per-file results.

The endpoint is async; tests drive it with ``asyncio.run`` so the suite needs
no extra pytest plugins.
"""
from __future__ import annotations

import asyncio
import io

import pytest
from fastapi import HTTPException, UploadFile

from app.models import User, Visitor
from app.routers import scan as router


def _user(db, org) -> User:
    u = User(org_id=org.id, email="rep@example.com", name="Rep", password_hash="x")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _upload(name: str = "card.jpg") -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(b"fake-image-bytes"))


def _async_returning(values):
    """Build an async stand-in for _read_and_scan that yields each card in turn.

    A value that is an exception instance is raised instead of returned, to
    simulate a single bad image inside a batch.
    """
    it = iter(values)

    async def _scan(path, client_qr_payload=None):
        item = next(it)
        if isinstance(item, Exception):
            raise item
        return item

    return _scan


@pytest.fixture
def vision_on(monkeypatch):
    monkeypatch.setattr(router, "vision_configured", lambda: True)


def test_bulk_creates_one_contact_per_image(db, org, vision_on, monkeypatch):
    cards = [
        {"name": "Jane Doe", "company": "Acme", "email": "jane@acme.com", "source": "ocr"},
        {"name": "John Smith", "company": "Globex", "email": "john@globex.com", "source": "ocr"},
    ]
    monkeypatch.setattr(router, "_read_and_scan", _async_returning(cards))

    user = _user(db, org)
    out = asyncio.run(
        router.scan_bulk(
            images=[_upload("a.jpg"), _upload("b.jpg")],
            contact_type="lead",
            notes=None,
            db=db,
            user=user,
        )
    )

    assert out.ok_count == 2
    assert out.failed_count == 0
    assert [r.status for r in out.results] == ["ok", "ok"]
    names = {r.visitor.name for r in out.results}
    assert names == {"Jane Doe", "John Smith"}
    assert db.query(Visitor).filter(Visitor.org_id == org.id).count() == 2


def test_bulk_partial_success_one_bad_image(db, org, vision_on, monkeypatch):
    good = {"name": "Jane Doe", "email": "jane@acme.com", "source": "ocr"}
    monkeypatch.setattr(
        router,
        "_read_and_scan",
        _async_returning([good, HTTPException(status_code=502, detail="Vision failed")]),
    )

    user = _user(db, org)
    out = asyncio.run(
        router.scan_bulk(
            images=[_upload("good.jpg"), _upload("bad.jpg")],
            contact_type="lead",
            notes=None,
            db=db,
            user=user,
        )
    )

    assert out.ok_count == 1
    assert out.failed_count == 1
    ok_item = next(r for r in out.results if r.status == "ok")
    bad_item = next(r for r in out.results if r.status == "failed")
    assert ok_item.visitor.name == "Jane Doe"
    assert bad_item.filename == "bad.jpg"
    assert bad_item.error
    # The good contact must have been committed despite the sibling failure.
    assert db.query(Visitor).filter(Visitor.org_id == org.id).count() == 1


def test_bulk_rejects_empty_list(db, org, vision_on):
    user = _user(db, org)
    with pytest.raises(HTTPException) as ei:
        asyncio.run(
            router.scan_bulk(images=[], contact_type="lead", notes=None, db=db, user=user)
        )
    assert ei.value.status_code == 400


def test_bulk_rejects_over_limit(db, org, vision_on):
    user = _user(db, org)
    images = [_upload(f"c{i}.jpg") for i in range(router.MAX_BULK + 1)]
    with pytest.raises(HTTPException) as ei:
        asyncio.run(
            router.scan_bulk(images=images, contact_type="lead", notes=None, db=db, user=user)
        )
    assert ei.value.status_code == 400


def test_bulk_requires_vision_configured(db, org, monkeypatch):
    monkeypatch.setattr(router, "vision_configured", lambda: False)
    user = _user(db, org)
    with pytest.raises(HTTPException) as ei:
        asyncio.run(
            router.scan_bulk(
                images=[_upload("a.jpg")], contact_type="lead", notes=None, db=db, user=user
            )
        )
    assert ei.value.status_code == 503
