"""Parsing of MCP CallToolResult shapes into plain dicts/lists/text."""
from __future__ import annotations

from app.services import plaud_mcp


class _Block:
    def __init__(self, text):
        self.text = text


class _Result:
    def __init__(self, *, content=None, structured=None, is_error=False):
        self.content = content or []
        self.structuredContent = structured
        self.isError = is_error


def test_structured_content_preferred():
    r = _Result(structured={"files": [{"id": "a"}]})
    assert plaud_mcp._content_to_obj(r) == {"files": [{"id": "a"}]}


def test_structured_result_envelope_unwrapped():
    r = _Result(structured={"result": [{"id": "a"}]})
    assert plaud_mcp._content_to_obj(r) == [{"id": "a"}]


def test_json_in_text_decoded():
    r = _Result(content=[_Block('{"transcript": "hi there"}')])
    assert plaud_mcp._content_to_obj(r) == {"transcript": "hi there"}


def test_plain_text_passthrough():
    r = _Result(content=[_Block("just words")])
    assert plaud_mcp._content_to_obj(r) == "just words"


def test_as_list_envelopes():
    assert plaud_mcp._as_list({"files": [{"id": 1}]}) == [{"id": 1}]
    assert plaud_mcp._as_list([{"id": 1}, "skip"]) == [{"id": 1}]
    assert plaud_mcp._as_list({"id": 1}) == [{"id": 1}]
    assert plaud_mcp._as_list(None) == []


def test_coerce_text_keys():
    assert plaud_mcp._coerce_text({"summary": "S"}, keys=("summary", "text")) == "S"
    assert plaud_mcp._coerce_text("raw", keys=("text",)) == "raw"
    assert plaud_mcp._coerce_text(None, keys=("text",)) == ""


def test_coerce_text_nested_envelope():
    # Plaud may wrap the transcript under data/result rather than at the top.
    obj = {"data": {"transcription": "the full meeting transcript text"}}
    assert plaud_mcp._coerce_text(obj, keys=("transcript",)) == "the full meeting transcript text"
    obj2 = {"result": {"transcript": {"text": "nested two levels down"}}}
    assert plaud_mcp._coerce_text(obj2, keys=("transcript",)) == "nested two levels down"


def test_coerce_text_segment_list():
    # A transcript returned as a list of segment objects gets joined in order.
    segs = [
        {"speaker": "A", "text": "hello there"},
        {"speaker": "B", "content": "general kenobi"},
        {"sentence": "you are a bold one"},
    ]
    assert plaud_mcp._coerce_text({"segments": segs}, keys=("transcript",)) == (
        "hello there\ngeneral kenobi\nyou are a bold one"
    )
    # Or as a bare list at the top level.
    assert plaud_mcp._coerce_text(segs, keys=("transcript",)).startswith("hello there")


def test_coerce_text_ignores_non_text_scalars():
    # No usable text -> empty (ids/durations must not be returned as "text").
    assert plaud_mcp._coerce_text({"id": "r1", "duration": 90}, keys=("transcript",)) == ""


def test_coerce_text_plaud_data_blocks():
    # Plaud's real shape: transcript/note come back as a list of "data block"
    # dicts where the text lives in data_content (not text/content). The text
    # blocks are concatenated in order; empty blocks and bare download links
    # (audio/file assets) are skipped.
    blocks = [
        {"data_type": "title", "data_content": "Booth chat", "data_link": ""},
        {"data_type": "transcript", "data_content": "Speaker A: hi there", "data_link": "x"},
        {"data_type": "audio", "data_content": "https://files.plaud.ai/abc.mp3"},
        {"data_type": "empty", "data_content": ""},
    ]
    out = plaud_mcp._coerce_text(blocks, keys=("transcript", "text", "content"))
    assert "Booth chat" in out and "Speaker A: hi there" in out
    assert "abc.mp3" not in out  # bare link must not pollute the transcript

    note = [{"data_type": "summary", "data_content": "AI summary text", "data_error_code": 0}]
    assert plaud_mcp._coerce_text(note, keys=("summary", "text")) == "AI summary text"

    # All-empty / link-only blocks -> empty so the row is correctly skipped.
    only_link = [{"data_type": "audio", "data_content": "https://files.plaud.ai/x.mp3"}]
    assert plaud_mcp._coerce_text(only_link, keys=("transcript",)) == ""


def test_as_list_nested_envelope():
    assert plaud_mcp._as_list({"data": {"files": [{"id": 1}]}}) == [{"id": 1}]


class _Tool:
    def __init__(self, name, schema):
        self.name = name
        self.inputSchema = schema


def test_file_id_args_matches_schema():
    # Server names the arg "id" -> we pass the file id under "id", not "file_id".
    tool = _Tool("get_transcript", {"properties": {"id": {"type": "string"}}})
    assert plaud_mcp._file_id_args(tool, "rec1") == {"id": "rec1"}
    # Standard "file_id" still works.
    tool2 = _Tool("get_transcript", {"properties": {"file_id": {"type": "string"}}})
    assert plaud_mcp._file_id_args(tool2, "rec1") == {"file_id": "rec1"}


def test_file_id_args_falls_back_to_required_then_first_prop():
    tool = _Tool("get_transcript", {"properties": {"recordingUuid": {}}, "required": ["recordingUuid"]})
    assert plaud_mcp._file_id_args(tool, "rec1") == {"recordingUuid": "rec1"}
    # No schema at all -> default to file_id.
    assert plaud_mcp._file_id_args(_Tool("t", None), "rec1") == {"file_id": "rec1"}


# --- pagination of list_files --------------------------------------------
import asyncio


class _ListResult:
    def __init__(self, tools):
        self.tools = tools


class _FakeSession:
    """Minimal session stub: advertises one list tool and serves recordings,
    recording every call_tool argument set so tests can assert paging."""

    def __init__(self, tool, pages_by_arg):
        self._tool = tool
        self._pages_by_arg = pages_by_arg  # callable(args) -> list[dict]
        self.calls = []

    async def list_tools(self):
        return _ListResult([self._tool])

    async def call_tool(self, name, args):
        self.calls.append(dict(args))
        return _Result(structured={"files": self._pages_by_arg(args)})


def _run_list_all(session):
    return asyncio.run(plaud_mcp._list_all_files(session))


def test_list_files_no_page_arg_single_call():
    # Tool advertises no page argument -> exactly one call, no pagination loop.
    tool = _Tool("list_files", {"properties": {}})
    recs = [{"id": "a"}, {"id": "b"}]
    session = _FakeSession(tool, lambda args: recs)
    out = _run_list_all(session)
    assert out == recs
    assert len(session.calls) == 1
    assert "page" not in session.calls[0]


def test_list_files_walks_multiple_pages():
    # Server caps page size well below our request and paginates; we must keep
    # going past a short page until an empty page ends the walk.
    tool = _Tool("list_files", {"properties": {"page": {}, "page_size": {}}})
    pages = {1: [{"id": "a"}, {"id": "b"}], 2: [{"id": "c"}], 3: []}
    session = _FakeSession(tool, lambda args: pages.get(args["page"], []))
    out = _run_list_all(session)
    assert [r["id"] for r in out] == ["a", "b", "c"]
    assert [c["page"] for c in session.calls] == [1, 2, 3]
    assert session.calls[0]["page_size"] == plaud_mcp._PAGE_SIZE


def test_list_files_stops_when_server_ignores_page_arg():
    # Server returns the same page regardless of the page number -> we detect no
    # NEW records on page 2 and stop instead of looping forever.
    tool = _Tool("list_files", {"properties": {"page": {}}})
    same = [{"id": "a"}, {"id": "b"}]
    session = _FakeSession(tool, lambda args: same)
    out = _run_list_all(session)
    assert [r["id"] for r in out] == ["a", "b"]
    assert len(session.calls) == 2  # page 1 collected, page 2 added nothing


def test_list_files_keeps_collected_when_later_page_errors():
    # A later page raises (server rejects deep paging) -> keep what we collected.
    tool = _Tool("list_files", {"properties": {"page": {}}})
    def pages(args):
        if args["page"] == 1:
            return [{"id": "a"}]
        raise RuntimeError("server hated page 2")
    session = _FakeSession(tool, pages)
    out = _run_list_all(session)
    assert [r["id"] for r in out] == ["a"]


def test_list_files_first_page_error_propagates():
    # If page 1 itself fails, propagate so list_files can fall back to no-arg.
    tool = _Tool("list_files", {"properties": {"page": {}}})
    def pages(args):
        raise RuntimeError("server rejected page arg")
    session = _FakeSession(tool, pages)
    import pytest
    with pytest.raises(RuntimeError):
        _run_list_all(session)


def test_list_files_falls_back_to_plain_call(monkeypatch):
    # Paginated attempt raises a transport error -> list_files retries with a
    # plain (no-arg) call and still returns recordings.
    received = []

    async def fake_with_session(token, fn):
        received.append(fn)
        if fn is plaud_mcp._list_all_files:
            raise plaud_mcp.PlaudMCPError("Plaud MCP transport error: TaskGroup")
        tool = _Tool("list_files", {"properties": {}})
        return await fn(_FakeSession(tool, lambda args: [{"id": "z"}]))

    monkeypatch.setattr(plaud_mcp, "_with_session", fake_with_session)
    out = plaud_mcp.list_files("tok")
    assert [r["id"] for r in out] == ["z"]
    assert plaud_mcp._list_all_files in received and len(received) == 2


def test_list_files_auth_error_not_swallowed(monkeypatch):
    # An auth failure during the paginated attempt must NOT trigger the plain
    # fallback — it propagates so the router can flag a reconnect.
    async def fake_with_session(token, fn):
        raise plaud_mcp.PlaudMCPAuthError("401 unauthorized")

    monkeypatch.setattr(plaud_mcp, "_with_session", fake_with_session)
    import pytest
    with pytest.raises(plaud_mcp.PlaudMCPAuthError):
        plaud_mcp.list_files("tok")


def test_is_auth_error_unwraps_exception_group():
    # A 401 buried inside a TaskGroup ExceptionGroup is still detected.
    inner = RuntimeError("HTTP 401 unauthorized")
    group = ExceptionGroup("unhandled errors in a TaskGroup", [inner])
    assert plaud_mcp._is_auth_error(group) is True
    # A plain transport failure is not mistaken for auth.
    benign = ExceptionGroup("unhandled errors in a TaskGroup", [RuntimeError("connection reset")])
    assert plaud_mcp._is_auth_error(benign) is False


def test_best_message_skips_taskgroup_wrapper():
    inner = RuntimeError("connection reset by peer")
    group = ExceptionGroup("unhandled errors in a TaskGroup (1 sub-exception)", [inner])
    assert plaud_mcp._best_message(group) == "connection reset by peer"


def test_base_exception_group_is_not_exception():
    # The reason _with_session must catch BaseException: anyio cancels sibling
    # tasks on failure, so the error arrives as a BaseExceptionGroup carrying a
    # CancelledError (a BaseException). Such a group is NOT an Exception, so a
    # plain `except Exception` would let it escape raw.
    group = BaseExceptionGroup(
        "unhandled errors in a TaskGroup (1 sub-exception)",
        [OSError(5, "Input/output error"), asyncio.CancelledError()],
    )
    assert not isinstance(group, Exception)
    # Our helpers still dig out the real error and don't misread it as auth.
    assert plaud_mcp._best_message(group) == "[Errno 5] Input/output error"
    assert plaud_mcp._is_auth_error(group) is False


def test_base_exception_group_auth_detected():
    # A 401 buried inside a BaseExceptionGroup still flips reconnect.
    group = BaseExceptionGroup(
        "unhandled errors in a TaskGroup",
        [OSError("HTTP 401 unauthorized"), asyncio.CancelledError()],
    )
    assert plaud_mcp._is_auth_error(group) is True


# --- _with_session wrapping at the MCP client boundary ----------------------
# Stub the `mcp` SDK so we can exercise _with_session's except clause without a
# live server. The point: a raw BaseExceptionGroup raised inside the session
# must be wrapped into PlaudMCPError (never escape as-is past the router).

class _StubStreamCtx:
    async def __aenter__(self):
        return (object(), object(), None)

    async def __aexit__(self, *exc):
        return False


class _StubSessionCtx:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def initialize(self):
        return None


def _install_stub_mcp(monkeypatch):
    import sys
    import types

    mcp_mod = types.ModuleType("mcp")
    mcp_mod.ClientSession = lambda read, write: _StubSessionCtx()
    streamable_mod = types.ModuleType("mcp.client.streamable_http")
    streamable_mod.streamablehttp_client = lambda url, headers=None: _StubStreamCtx()
    client_mod = types.ModuleType("mcp.client")
    monkeypatch.setitem(sys.modules, "mcp", mcp_mod)
    monkeypatch.setitem(sys.modules, "mcp.client", client_mod)
    monkeypatch.setitem(sys.modules, "mcp.client.streamable_http", streamable_mod)


def test_with_session_wraps_base_exception_group(monkeypatch):
    _install_stub_mcp(monkeypatch)

    async def boom(session):
        raise BaseExceptionGroup(
            "unhandled errors in a TaskGroup (1 sub-exception)",
            [OSError(5, "Input/output error"), asyncio.CancelledError()],
        )

    import pytest
    with pytest.raises(plaud_mcp.PlaudMCPError) as ei:
        plaud_mcp._run(plaud_mcp._with_session("tok", boom))
    # The opaque TaskGroup wrapper is unwrapped to the real inner error, and it
    # is NOT misclassified as an auth failure.
    assert "[Errno 5] Input/output error" in str(ei.value)
    assert not isinstance(ei.value, plaud_mcp.PlaudMCPAuthError)


def test_with_session_wraps_base_exception_group_auth(monkeypatch):
    _install_stub_mcp(monkeypatch)

    async def boom(session):
        raise BaseExceptionGroup(
            "unhandled errors in a TaskGroup",
            [OSError("HTTP 401 unauthorized"), asyncio.CancelledError()],
        )

    import pytest
    with pytest.raises(plaud_mcp.PlaudMCPAuthError):
        plaud_mcp._run(plaud_mcp._with_session("tok", boom))
