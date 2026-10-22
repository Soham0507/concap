"""HTTP-level port checks using an isolated database, never customer data."""
from pathlib import Path

import httpx
import pytest
import asyncio
import importlib.util

from app import main
from app.database import get_db
from app.models import Organization, Quote, Visitor
from app.services.auth import create_token


@pytest.fixture
def migrated_api(db):
    def database():
        yield db

    was_ready = main._db_ready.is_set()
    main._db_ready.set()
    main.app.dependency_overrides[get_db] = database
    try:
        yield main.app
    finally:
        main.app.dependency_overrides.pop(get_db, None)
        if not was_ready:
            main._db_ready.clear()


def test_authenticated_api_and_binary_downloads(migrated_api, db, user):
    quote = Quote(
        org_id=user.org_id, user_id=user.id,
        title="Migration test", proposal_text="Test proposal",
        line_items=[{"description": "Service", "quantity": 1, "unit_price": 10}],
    )
    foreign_org = Organization(name="Other tenant")
    db.add_all([quote, foreign_org])
    db.flush()
    foreign_contact = Visitor(name="Other tenant contact", org_id=foreign_org.id)
    db.add(foreign_contact)
    db.commit()
    # Keep this in-memory SQLite connection for the request's worker thread.
    db.connection()

    async def check():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=migrated_api),
            base_url="http://test",
        ) as client:
            assert (await client.get("/api/quotes")).status_code == 401
            client.headers["Authorization"] = "Bearer " + create_token(user.id, user.email)
            assert (await client.get("/api/auth/me")).status_code == 200
            assert (await client.get(f"/api/visitors/{foreign_contact.id}")).status_code == 404
            for suffix, signature, content_type in (
                ("pdf", b"%PDF-", "application/pdf"),
                ("docx", b"PK", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            ):
                response = await client.get(f"/api/quotes/{quote.id}/export.{suffix}")
                assert response.status_code == 200
                assert response.content.startswith(signature)
                assert response.headers["content-type"] == content_type
                assert "attachment;" in response.headers["content-disposition"]
    asyncio.run(check())


def test_website_routes_serve_original_bytes():
    website = Path(__file__).resolve().parents[3] / "concap"
    spec = importlib.util.spec_from_file_location("concap_website", website / "serve.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    async def check():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=module.app),
            base_url="http://test",
        ) as client:
            for path, filename in module.PAGES.items():
                response = await client.get(path)
                assert response.status_code == 200, path
                assert response.content == (module.FRONTEND / filename).read_bytes()
                assert "no-store" in response.headers["cache-control"]
            response = await client.get("/sw.js")
            assert response.headers["service-worker-allowed"] == "/"
            assert response.content == (module.FRONTEND / "sw.js").read_bytes()
            for name in ("styles.css", "appnav.js", "auth.js", "favicon.svg", "concap-mark.svg"):
                response = await client.get("/static/" + name)
                assert response.content == (module.FRONTEND / name).read_bytes()
            assert (await client.get("/manifest.webmanifest")).status_code == 200
            assert (await client.get("/does-not-exist")).status_code == 404
    asyncio.run(check())
