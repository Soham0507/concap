"""Parse user-uploaded documents (PDF / Word / plain text) into grounding text
for the Quote agent, using LlamaIndex's local file readers.

No cloud parsing (LlamaParse) and no OCR — best-effort text extraction only.
Scanned/image-only PDFs yield no text and are rejected with a clear message.

The heavy ``llama-index-core`` import is done lazily inside ``_extract_text`` so
importing this module (e.g. at app startup) stays cheap.
"""
from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

# Accept the common business-document formats the local readers handle as text.
ALLOWED_EXTS = {".pdf", ".docx", ".txt", ".md"}
# Hard per-file byte cap — bound memory so a huge upload can't OOM the process.
MAX_FILE_BYTES = 20 * 1024 * 1024
# Max attachments accepted in a single request.
MAX_FILES = 10
# Cap the extracted text we keep per document and across a proposal, so the
# grounding context (and the model prompt) can never blow up unbounded.
PER_DOC_CHARS = 30_000
TOTAL_DOC_CHARS = 60_000


class DocumentParseError(ValueError):
    """An uploaded document can't be accepted or read. The message is safe to
    surface to the user verbatim (it names the file and the reason)."""


def _extract_text(path: str, ext: str) -> str:
    """Run the appropriate LlamaIndex local reader and return its text. Imports
    are lazy: ``llama-index-core`` is heavy, so only pull it when parsing."""
    file = Path(path)
    if ext == ".pdf":
        from llama_index.readers.file import PDFReader

        docs = PDFReader().load_data(file=file)
    elif ext == ".docx":
        from llama_index.readers.file import DocxReader

        docs = DocxReader().load_data(file=file)
    else:  # .txt / .md
        from llama_index.readers.file import FlatReader

        docs = FlatReader().load_data(file=file)
    return "\n".join((getattr(d, "text", "") or "") for d in docs).strip()


def parse_upload(filename: str, data: bytes) -> str:
    """Validate and extract text from a single uploaded document.

    Raises :class:`DocumentParseError` (with a user-safe message) for an
    unsupported extension, an empty or oversized file, or a file no text could
    be read from. Returns the extracted text, capped to ``PER_DOC_CHARS``.
    """
    name = Path((filename or "").strip() or "document").name
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXTS:
        raise DocumentParseError(
            f"'{name}': unsupported file type. Attach a PDF, Word (.docx), "
            "or text (.txt/.md) file."
        )
    if not data:
        raise DocumentParseError(f"'{name}': the file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise DocumentParseError(
            f"'{name}': file is too large (max {MAX_FILE_BYTES // (1024 * 1024)} MB)."
        )

    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as fh:
            fh.write(data)
            tmp_path = fh.name
        try:
            text = _extract_text(tmp_path, ext)
        except DocumentParseError:
            raise
        except Exception as exc:  # noqa: BLE001 — never surface a parse crash as 500
            logger.warning("Failed to parse upload %s: %s", name, exc)
            raise DocumentParseError(
                f"'{name}': couldn't read this file. If it's a scanned or "
                "image-only PDF, text extraction isn't supported."
            )
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    if not text.strip():
        raise DocumentParseError(
            f"'{name}': no readable text found (it may be empty or a scanned image)."
        )
    return text[:PER_DOC_CHARS]


def build_attachment_payload(files: list[tuple[str, bytes]]) -> list[dict]:
    """Parse a list of ``(filename, bytes)`` uploads into
    ``[{"name", "text"}]``. Enforces the file-count cap and raises
    :class:`DocumentParseError` naming the first bad file."""
    if not files:
        return []
    if len(files) > MAX_FILES:
        raise DocumentParseError(f"Too many files at once (max {MAX_FILES}).")
    out: list[dict] = []
    for name, data in files:
        out.append({"name": Path(name).name, "text": parse_upload(name, data)})
    return out


def _sections(attachments: list[dict]) -> tuple[str, list[dict]]:
    """Render attachments into one labelled text block plus display metadata."""
    blocks: list[str] = []
    meta: list[dict] = []
    for a in attachments:
        name = a.get("name") or "document"
        text = (a.get("text") or "").strip()
        if not text:
            continue
        blocks.append(f"### Document: {name}\n{text}")
        meta.append({"name": name, "chars": len(text)})
    return ("\n\n".join(blocks), meta)


def merge_attachments(
    existing_text: str | None,
    existing_meta: list[dict] | None,
    new_attachments: list[dict] | None,
) -> tuple[str | None, list[dict] | None]:
    """Combine already-stored attachment text/meta with newly parsed
    attachments, capped to ``TOTAL_DOC_CHARS``. Returns ``(text, meta)`` with
    ``None`` when there is nothing at all (so an empty column stays NULL)."""
    new_text, new_meta = _sections(new_attachments or [])
    combined_meta = list(existing_meta or []) + new_meta
    parts = [p for p in (existing_text, new_text) if p]
    combined_text = "\n\n".join(parts)[:TOTAL_DOC_CHARS]
    return (combined_text or None, combined_meta or None)
