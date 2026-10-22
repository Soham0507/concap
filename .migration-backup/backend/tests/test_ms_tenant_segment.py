"""Unit tests for the Microsoft tenant authority resolution used to build the
Teams OAuth authorize/token URLs.

Precedence must be: ms_tenant_override -> ms_tenant -> "organizations".
The override exists because the MS_TENANT secret can be hard to change in the
UI; an empty/blank tenant must never produce a broken `//` authority (AADSTS90019).
"""
from __future__ import annotations

from types import SimpleNamespace

from app.services import meeting_oauth as oauth


def _patch_settings(monkeypatch, *, override: str, tenant: str) -> None:
    monkeypatch.setattr(
        oauth,
        "get_settings",
        lambda: SimpleNamespace(ms_tenant_override=override, ms_tenant=tenant),
    )


def test_override_wins_over_tenant(monkeypatch):
    _patch_settings(monkeypatch, override="organizations", tenant="some-guid")
    assert oauth._ms_tenant_segment() == "organizations"
    assert oauth._ms_authorize() == (
        "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize"
    )


def test_falls_back_to_tenant_when_no_override(monkeypatch):
    _patch_settings(monkeypatch, override="", tenant="my-guid")
    assert oauth._ms_tenant_segment() == "my-guid"


def test_final_fallback_is_organizations(monkeypatch):
    _patch_settings(monkeypatch, override="", tenant="")
    assert oauth._ms_tenant_segment() == "organizations"


def test_blank_values_are_stripped(monkeypatch):
    _patch_settings(monkeypatch, override="   ", tenant="  ")
    assert oauth._ms_tenant_segment() == "organizations"
