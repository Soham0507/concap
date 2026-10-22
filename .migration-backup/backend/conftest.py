"""Shared pytest fixtures for the backend test suite.

These tests run fully offline: the database is an in-memory SQLite instance
and every HubSpot token-endpoint call is mocked, so no network or real
credentials are required.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models  # noqa: F401 — registers models on Base.metadata
from app.config import get_settings
from app.database import Base
from app.models import Organization, User


# Deterministic test config. The real Settings singleton is lru_cached and
# loads from .env; we overwrite the few values the HubSpot OAuth code reads so
# the suite doesn't depend on the host environment.
@pytest.fixture(autouse=True)
def settings():
    s = get_settings()
    overrides = {
        "auth_secret": "test-auth-secret-do-not-use-in-prod",
        "secret_encryption_key": "test-encryption-key",
        "hubspot_client_id": "test-client-id",
        "hubspot_client_secret": "test-client-secret",
        "public_base_url": "https://test.example.com",
        # Salesforce OAuth: static client + explicit login host / api version so
        # the suite never touches the network.
        "salesforce_client_id": "test-sf-client-id",
        "salesforce_client_secret": "test-sf-client-secret",
        "salesforce_login_url": "https://login.salesforce.com",
        "salesforce_api_version": "v60.0",
        "salesforce_session_lifetime_seconds": 7200,
        # Plaud OAuth: a static client + explicit endpoints so the suite never
        # touches the network for discovery or dynamic client registration.
        "plaud_mcp_url": "https://mcp.plaud.ai/mcp",
        "plaud_client_id": "test-plaud-client-id",
        "plaud_client_secret": "test-plaud-client-secret",
        "plaud_authorize_url": "https://auth.plaud.ai/authorize",
        "plaud_token_url": "https://auth.plaud.ai/token",
        "plaud_registration_url": "",
        "plaud_scopes": "",
    }
    for key, value in overrides.items():
        object.__setattr__(s, key, value)
    yield s


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        future=True,
    )
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture
def org(db):
    o = Organization(name="Test Org", org_type="company")
    db.add(o)
    db.commit()
    db.refresh(o)
    return o


@pytest.fixture
def user(db, org):
    u = User(
        org_id=org.id,
        email="member@test.example.com",
        password_hash="x",
        role="owner",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u
