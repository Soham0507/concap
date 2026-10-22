"""Plaud MCP client — talks to Plaud's remote MCP server over streamable HTTP.

Plaud exposes its recordings through MCP tools (list files, fetch a file's
transcript / AI note, identify the current account). This module wraps the
async MCP SDK with small synchronous helpers so the FastAPI request handlers
(and the per-user OAuth code) can call them with a bearer access token.

We keep the tool-name and result-shape handling defensive: MCP servers vary in
whether they return ``structuredContent`` or JSON-in-text, and Plaud's exact
tool names may differ, so each helper accepts a few likely aliases and parses
whatever comes back into plain dicts/lists.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from ..config import get_settings

logger = logging.getLogger("concap.plaud.mcp")

# Candidate tool names per logical operation. We pick the first that the server
# actually advertises (see _resolve_tool), so a rename on Plaud's side or a
# minor naming difference doesn't break the integration outright.
_LIST_FILES_TOOLS = ("list_files", "list_recordings", "listFiles", "get_files", "files")
_TRANSCRIPT_TOOLS = ("get_transcript", "get_transcription", "getTranscript", "transcript")
_NOTE_TOOLS = ("get_note", "get_summary", "get_ai_note", "getNote", "note", "summary")
_CURRENT_USER_TOOLS = ("get_current_user", "get_me", "whoami", "current_user", "me")


class PlaudMCPError(Exception):
    """A problem talking to the Plaud MCP server (tool missing, transport
    failure, unparseable result)."""


class PlaudMCPAuthError(PlaudMCPError):
    """The MCP server rejected our access token (401/403). The caller should
    treat the connection as needing reconnect."""


# ---------------------------------------------------------------------------
# Result parsing
# ---------------------------------------------------------------------------

def _content_to_obj(result: Any) -> Any:
    """Best-effort extract a Python object from a CallToolResult.

    Prefers ``structuredContent``; otherwise concatenates text blocks and tries
    to JSON-decode them, falling back to the raw text."""
    structured = getattr(result, "structuredContent", None)
    if isinstance(structured, dict) and structured:
        # MCP often wraps a list result as {"result": [...]}.
        if set(structured.keys()) == {"result"}:
            return structured["result"]
        return structured

    texts: list[str] = []
    for block in (getattr(result, "content", None) or []):
        text = getattr(block, "text", None)
        if isinstance(text, str):
            texts.append(text)
    joined = "\n".join(texts).strip()
    if not joined:
        return None
    try:
        return json.loads(joined)
    except (ValueError, json.JSONDecodeError):
        return joined


def _as_list(obj: Any) -> list[dict]:
    if obj is None:
        return []
    if isinstance(obj, dict):
        # Common envelopes: {"files": [...]}, {"items": [...]}, {"data": [...]}.
        for key in ("files", "recordings", "items", "data", "results", "list", "records"):
            val = obj.get(key)
            if isinstance(val, list):
                return [x for x in val if isinstance(x, dict)]
        # A nested envelope, e.g. {"data": {"files": [...]}}.
        for key in ("data", "result"):
            val = obj.get(key)
            if isinstance(val, dict):
                nested = _as_list(val)
                if nested:
                    return nested
        return [obj]
    if isinstance(obj, list):
        return [x for x in obj if isinstance(x, dict)]
    return []


def _kind(v: Any) -> str:
    """Type + size of a single value — never its content (PII-safe)."""
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, str):
        return f"str[{len(v)}]"
    if isinstance(v, dict):
        return f"dict[{len(v)}]"
    if isinstance(v, list):
        return f"list[{len(v)}]"
    if v is None:
        return "None"
    return type(v).__name__


def _shape(obj: Any) -> str:
    """A PII-safe structural description (types / keys / lengths, never values)
    of an MCP result — for diagnostic logs so we can see the real response shape,
    including per-field value lengths, without dumping transcript content."""
    if isinstance(obj, dict):
        items = sorted(obj.items(), key=lambda kv: str(kv[0]))[:25]
        return "dict{" + ", ".join(f"{k}:{_kind(v)}" for k, v in items) + "}"
    if isinstance(obj, list):
        head = obj[0] if obj else None
        return f"list[{len(obj)}] of " + _shape(head)
    return _kind(obj)


# ---------------------------------------------------------------------------
# Async core
# ---------------------------------------------------------------------------

def _iter_exc(exc: BaseException | None, depth: int = 0):
    """Walk an exception and everything nested inside it: ExceptionGroup members
    (the streamable-HTTP client wraps failures in an anyio TaskGroup, surfacing
    as "unhandled errors in a TaskGroup"), plus __cause__/__context__ chains."""
    if exc is None or depth > 8:
        return
    yield exc
    for sub in (getattr(exc, "exceptions", None) or []):
        yield from _iter_exc(sub, depth + 1)
    yield from _iter_exc(getattr(exc, "__cause__", None), depth + 1)
    yield from _iter_exc(getattr(exc, "__context__", None), depth + 1)


def _is_auth_error(exc: BaseException) -> bool:
    # Check the WHOLE chain — a 401/403 is often buried inside a TaskGroup
    # ExceptionGroup whose own str() is just "unhandled errors in a TaskGroup".
    for e in _iter_exc(exc):
        msg = str(e).lower()
        if "401" in msg or "403" in msg or "unauthorized" in msg or "forbidden" in msg:
            return True
    return False


def _best_message(exc: BaseException) -> str:
    """The most specific message in the chain — skip the opaque TaskGroup/group
    wrappers so callers see the real underlying transport/server error."""
    for e in _iter_exc(exc):
        m = str(e).strip()
        if m and "taskgroup" not in m.lower() and "sub-exception" not in m.lower():
            return m
    return str(exc)


async def _with_session(token: str, fn):
    """Open an authenticated MCP session and run ``fn(session)``."""
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    url = get_settings().plaud_mcp_url
    headers = {"Authorization": f"Bearer {token}"}
    try:
        async with streamablehttp_client(url, headers=headers) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return await fn(session)
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException as exc:  # noqa: BLE001
        # NOTE: we must catch BaseException, not just Exception. The streamable
        # HTTP client runs inside an anyio task group; when one task fails the
        # group cancels its siblings, so the error surfaces as a
        # *BaseExceptionGroup* (it contains CancelledError, a BaseException).
        # BaseExceptionGroup is NOT a subclass of Exception, so `except
        # Exception` would let it escape raw — past the router's PlaudMCPError
        # handlers and our own pagination fallback — and bubble up as an
        # unhandled 500 showing only the buried "[Errno 5]" message.
        if isinstance(exc, asyncio.CancelledError) and not isinstance(exc, BaseExceptionGroup):
            raise  # a genuine standalone cancellation — let it propagate.
        if _is_auth_error(exc):
            raise PlaudMCPAuthError(_best_message(exc)) from exc
        raise PlaudMCPError(f"Plaud MCP transport error: {_best_message(exc)}") from exc


# A per-recording tool needs the recording id, but servers name that argument
# differently. We read the tool's declared input schema and pass the id under
# whichever of these it actually expects (falling back to "file_id").
_FILE_ID_ARGS = ("file_id", "fileId", "id", "recording_id", "recordingId", "uuid", "file")


async def _resolve_tool(session, candidates: tuple[str, ...]):
    """Return the first advertised tool *object* matching ``candidates``."""
    listed = await session.list_tools()
    by_name = {t.name: t for t in listed.tools}
    for name in candidates:
        if name in by_name:
            return by_name[name]
    raise PlaudMCPError(
        f"Plaud MCP server exposes none of the expected tools {candidates}. "
        f"Available: {sorted(by_name)}"
    )


def _file_id_args(tool: Any, file_id: str) -> dict:
    """Map ``file_id`` onto whatever argument the tool's input schema declares,
    so a server that names it ``id``/``fileId``/etc. still works."""
    schema = getattr(tool, "inputSchema", None)
    props = schema.get("properties") if isinstance(schema, dict) else None
    if isinstance(props, dict) and props:
        for cand in _FILE_ID_ARGS:
            if cand in props:
                return {cand: file_id}
        required = schema.get("required") if isinstance(schema, dict) else None
        if isinstance(required, list) and required:
            return {str(required[0]): file_id}
        return {str(next(iter(props))): file_id}
    return {"file_id": file_id}


async def _call(session, candidates: tuple[str, ...], arguments: dict | None = None) -> Any:
    tool = await _resolve_tool(session, candidates)
    result = await session.call_tool(tool.name, arguments or {})
    if getattr(result, "isError", False):
        raise PlaudMCPError(f"Plaud MCP tool {tool.name} returned an error")
    return _content_to_obj(result)


async def _call_file(session, candidates: tuple[str, ...], file_id: str) -> Any:
    """Call a per-recording tool, passing the id under the right argument name."""
    tool = await _resolve_tool(session, candidates)
    result = await session.call_tool(tool.name, _file_id_args(tool, file_id))
    if getattr(result, "isError", False):
        raise PlaudMCPError(f"Plaud MCP tool {tool.name} returned an error")
    return _content_to_obj(result)


# ---------------------------------------------------------------------------
# Synchronous public helpers
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


# Pagination: list_files responses carry page/page_size, so the server may
# only return one page by default and newer recordings can sit on later pages.
# We request a large page and walk subsequent pages until exhausted.
_PAGE_ARGS = ("page", "page_no", "page_number", "pageNumber", "pageNo", "pageIndex")
_PAGE_SIZE_ARGS = ("page_size", "pageSize", "limit", "per_page", "perPage", "size", "count")
_PAGE_SIZE = 200   # ask for a big page; the server caps it to its own max.
_MAX_PAGES = 50    # hard stop so a misbehaving server can't loop forever.


def _rec_id(rec: dict) -> str | None:
    """The recording id under any of Plaud's naming variants (for dedup)."""
    for key in ("id", "file_id", "fileId", "recording_id", "recordingId", "uuid"):
        val = rec.get(key)
        if val not in (None, ""):
            return str(val)
    return None


async def _list_all_files(session) -> list[dict]:
    """Resolve the list tool and pull every page of recordings.

    Defensive across servers: if the tool advertises no page argument we make a
    single call (old behaviour). When it does paginate, we walk pages, dedup by
    recording id, and stop as soon as a page adds nothing new or returns fewer
    than a full page — so a server that ignores the page arg can't loop."""
    tool = await _resolve_tool(session, _LIST_FILES_TOOLS)
    schema = getattr(tool, "inputSchema", None)
    props = schema.get("properties") if isinstance(schema, dict) else None
    props = props if isinstance(props, dict) else {}
    page_arg = next((a for a in _PAGE_ARGS if a in props), None)
    size_arg = next((a for a in _PAGE_SIZE_ARGS if a in props), None)

    base_args: dict = {}
    if size_arg:
        base_args[size_arg] = _PAGE_SIZE

    # No page argument -> one shot (still pass page_size if supported).
    if not page_arg:
        result = await session.call_tool(tool.name, base_args)
        if getattr(result, "isError", False):
            raise PlaudMCPError(f"Plaud MCP tool {tool.name} returned an error")
        return _as_list(_content_to_obj(result))

    all_files: list[dict] = []
    seen: set[str] = set()
    for page in range(1, _MAX_PAGES + 1):
        try:
            result = await session.call_tool(tool.name, {**base_args, page_arg: page})
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:  # noqa: BLE001
            # Catch BaseException (not just Exception): the call can fail with an
            # anyio BaseExceptionGroup (see _with_session). Some servers reject
            # the page/page_size arguments outright. On the FIRST page we have
            # nothing useful, so let it propagate — list_files then retries with
            # a plain (no-arg) call. On a later page we already have results, so
            # keep what we collected rather than failing.
            if isinstance(exc, asyncio.CancelledError) and not isinstance(exc, BaseExceptionGroup):
                raise
            if page == 1:
                raise
            logger.warning("Plaud list_files: page %d failed; returning %d so far", page, len(all_files))
            break
        if getattr(result, "isError", False):
            if page == 1:
                raise PlaudMCPError(f"Plaud MCP tool {tool.name} returned an error")
            break
        obj = _content_to_obj(result)
        batch = _as_list(obj)
        if not batch:
            break  # empty page -> we've walked past the last page.
        added = 0
        for rec in batch:
            rid = _rec_id(rec)
            if rid is not None and rid in seen:
                continue
            if rid is not None:
                seen.add(rid)
            all_files.append(rec)
            added += 1
        # No NEW recordings means the server is returning the same page (it
        # ignored the page arg), so paging further can't help. We deliberately
        # do NOT stop on a short page: the server may cap page_size below our
        # request, and a short-but-nonempty page can still be followed by more.
        if added == 0:
            break
    return all_files


async def _list_files_plain(session) -> list[dict]:
    """Original single-call behaviour: list recordings with no arguments."""
    return _as_list(await _call(session, _LIST_FILES_TOOLS))


def list_files(token: str) -> list[dict]:
    """Return the user's Plaud recordings, walking pagination when supported.

    Pagination is best-effort: if walking pages fails (some servers reject the
    page/page_size arguments and surface it as a TaskGroup transport error), we
    fall back to a single plain call — exactly the original behaviour — so sync
    keeps working even when pagination isn't supported. Auth errors are never
    swallowed: they propagate so the caller can flag a reconnect."""
    try:
        files = _run(_with_session(token, _list_all_files))
    except PlaudMCPAuthError:
        raise
    except PlaudMCPError as exc:
        logger.warning("Plaud list_files: pagination failed (%s); retrying single call", exc)
        files = _run(_with_session(token, _list_files_plain))
    logger.info(
        "Plaud list_files: -> %d recordings%s",
        len(files),
        (" sample_keys=" + str(sorted(map(str, files[0]))[:25])) if files else "",
    )
    return files


def get_transcript(token: str, file_id: str) -> str:
    """Return the transcript text for a recording (empty string if none)."""
    async def _fn(session):
        return await _call_file(session, _TRANSCRIPT_TOOLS, file_id)
    obj = _run(_with_session(token, _fn))
    text = _coerce_text(obj, keys=("transcript", "transcription", "text", "content"))
    logger.info("Plaud get_transcript(%s): %s -> %d chars", file_id, _shape(obj), len(text))
    return text


def get_note(token: str, file_id: str) -> dict:
    """Return Plaud's AI note/summary for a recording as {text, json}."""
    async def _fn(session):
        return await _call_file(session, _NOTE_TOOLS, file_id)
    obj = _run(_with_session(token, _fn))
    text = _coerce_text(obj, keys=("summary", "note", "ai_note", "text", "content"))
    logger.info("Plaud get_note(%s): %s -> %d chars", file_id, _shape(obj), len(text))
    return {"text": text, "json": obj if isinstance(obj, dict) else None}


def get_current_user(token: str) -> dict:
    """Return the connected Plaud account info ({email, name, ...})."""
    async def _fn(session):
        return await _call(session, _CURRENT_USER_TOOLS)
    obj = _run(_with_session(token, _fn))
    if isinstance(obj, dict):
        # Some servers nest under {"user": {...}}.
        inner = obj.get("user")
        return inner if isinstance(inner, dict) else obj
    return {}


# Keys (after the caller's preferred ones) that commonly hold transcript or
# summary text, and container keys under which a server may nest it (an
# envelope like {"data": {...}}, or a transcript split into segment objects).
_TEXT_KEYS = (
    "transcript", "transcription", "transcript_text", "text", "content",
    "summary", "note", "ai_note", "body", "markdown", "md", "full_text",
    "sentence", "value",
)
_CONTAINER_KEYS = (
    "data", "result", "results", "segments", "sentences", "paragraphs",
    "items", "transcripts", "lines", "utterances", "chunks",
)
_MAX_TEXT_DEPTH = 6


def _looks_like_plaud_blocks(obj: Any) -> bool:
    """Plaud returns a recording's transcript/note as a list of "data block"
    dicts: {data_type, data_title, data_content, data_link, ...}. Detect that
    shape so we can pull text from ``data_content`` (which the generic key-based
    search would otherwise miss)."""
    return (
        isinstance(obj, list)
        and bool(obj)
        and all(isinstance(x, dict) for x in obj)
        and any(("data_content" in x or "data_type" in x) for x in obj)
    )


def _is_bare_link(s: str) -> bool:
    """A download/asset URL (audio, file blocks expose one in ``data_content``)
    rather than human transcript text — no internal whitespace."""
    return s.startswith(("http://", "https://")) and not any(c.isspace() for c in s)


def _plaud_blocks_text(blocks: list[dict]) -> str:
    """Concatenate the textual ``data_content`` of each Plaud data block, in
    order, skipping empty blocks and bare download links."""
    parts: list[str] = []
    for blk in blocks:
        content = blk.get("data_content")
        if not isinstance(content, str):
            continue
        s = content.strip()
        if not s or _is_bare_link(s):
            continue
        parts.append(s)
    return "\n\n".join(parts).strip()


def _coerce_text(obj: Any, *, keys: tuple[str, ...] = ()) -> str:
    """Best-effort pull human-readable text out of whatever an MCP tool returns.

    Handles Plaud's "data block" list (text under ``data_content``); a plain
    string; a dict keyed by the caller's preferred keys (or any well-known
    transcript/summary key); an envelope that nests the text under
    ``data``/``result``; and a transcript returned as a list of segment objects
    (each with a ``text``/``content``/``sentence`` field). Recurses with a depth
    cap so a pathological structure can't spin."""
    if _looks_like_plaud_blocks(obj):
        text = _plaud_blocks_text(obj)  # type: ignore[arg-type]
        if text:
            return text
    return _dig_text(obj, tuple(keys), 0).strip()


def _dig_text(obj: Any, prefer: tuple[str, ...], depth: int) -> str:
    if obj is None or depth > _MAX_TEXT_DEPTH:
        return ""
    if isinstance(obj, str):
        return obj.strip()
    if isinstance(obj, dict):
        # 1) A direct string under a preferred or well-known text key.
        for key in (*prefer, *_TEXT_KEYS):
            val = obj.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        # 2) Recurse into preferred/known/container keys holding a dict or list.
        for key in (*prefer, *_TEXT_KEYS, *_CONTAINER_KEYS):
            val = obj.get(key)
            if isinstance(val, (dict, list)):
                got = _dig_text(val, prefer, depth + 1)
                if got:
                    return got
        # 3) Last resort: any nested dict/list value at all.
        for val in obj.values():
            if isinstance(val, (dict, list)):
                got = _dig_text(val, prefer, depth + 1)
                if got:
                    return got
        return ""
    if isinstance(obj, list):
        parts = [_dig_text(x, prefer, depth + 1) for x in obj]
        return "\n".join(p for p in parts if p).strip()
    return ""
