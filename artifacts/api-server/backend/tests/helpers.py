"""Test helpers local to the HubSpot test modules."""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import httpx


class FakeResponse:
    """Minimal stand-in for httpx.Response for mocking the token endpoint."""

    def __init__(self, status_code: int, json_body: dict | None = None, text: str = ""):
        self.status_code = status_code
        self._json = json_body
        self.text = text or (str(json_body) if json_body is not None else "")

    def json(self):
        if self._json is None:
            raise ValueError("No JSON body")
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPError(f"HTTP {self.status_code}")


def make_post(*, response: FakeResponse | None = None, exc: Exception | None = None, recorder: list | None = None):
    """Build a fake httpx.post that returns `response` or raises `exc`.

    When `recorder` is provided, each call's kwargs are appended to it so a
    test can assert how the token endpoint was called.
    """

    def _post(url, *args, **kwargs):
        if recorder is not None:
            recorder.append({"url": url, **kwargs})
        if exc is not None:
            raise exc
        assert response is not None, "make_post needs either response or exc"
        return response

    return _post


def state_from_authorize_url(url: str) -> str:
    """Pull the `state` query param out of an authorize URL."""
    qs = parse_qs(urlparse(url).query)
    return qs["state"][0]


# Re-export for convenience in tests.
HTTPError = httpx.HTTPError
ConnectError = httpx.ConnectError
