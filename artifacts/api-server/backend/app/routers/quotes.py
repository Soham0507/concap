"""Quote agent routes — draft, edit, iterate, and export client proposals
built from booth conversation transcripts via Anthropic Claude.

Org-scoped like the rest of the app: a quote belongs to the creating user's
org and a tenancy mismatch returns 404 (not 403) to avoid id enumeration.
Drafting is conversational: a single /chat endpoint grounds a proposal in one
or many booth conversations (and/or every conversation for a pinned contact or
company), then refines it turn by turn while keeping the full chat thread.
"""
from __future__ import annotations

import io
import json
from pathlib import Path

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Brand, Company, Conversation, Organization, Quote, User, Visitor, utcnow
from ..services import document_parse, quote_ai, quote_export
from .auth import require_user
from .branding import org_branding_dict
from .brands import brand_branding_dict

router = APIRouter(prefix="/api/quotes", tags=["quotes"])


# --- request bodies -------------------------------------------------------

class ChatIn(BaseModel):
    """One message in the quote chat. With no quote_id this starts a new
    proposal grounded in the supplied conversations (and/or a contact or company
    whose conversations are aggregated); with a quote_id it refines that proposal
    and appends to its thread."""
    message: str
    quote_id: int | None = None
    conversation_ids: list[int] | None = None
    visitor_id: int | None = None
    company_id: int | None = None
    # Multi-Brand Quote Agent: which brand to draft under, and which of that
    # brand's proposal templates to follow. Both optional — with no brand the
    # agent falls back to the org's branding (unchanged legacy behaviour).
    brand_id: int | None = None
    template_id: str | None = None


class QuoteContextIn(BaseModel):
    """The full desired grounding context for an existing quote. The frontend
    sends the complete explicit conversation list (so removing a chip drops it)
    plus the optional pinned contact/company; a NEWLY pinned contact/company
    expands into its conversations server-side."""
    conversation_ids: list[int] = []
    visitor_id: int | None = None
    company_id: int | None = None


class LineItemIn(BaseModel):
    description: str
    quantity: float = 1
    unit_price: float = 0


class QuoteUpdateIn(BaseModel):
    title: str | None = None
    client_name: str | None = None
    client_company: str | None = None
    proposal_text: str | None = None
    line_items: list[LineItemIn] | None = None
    currency: str | None = None
    tax_percent: float | None = None
    discount_percent: float | None = None
    notes: str | None = None
    status: str | None = None


# --- helpers --------------------------------------------------------------

def _require_anthropic() -> None:
    problem = quote_ai.describe_anthropic_problem()
    if problem:
        raise HTTPException(status_code=400, detail=problem)


def _get_owned_quote(db: Session, user: User, quote_id: int) -> Quote:
    quote = db.get(Quote, quote_id)
    if quote is None or quote.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Not found")
    return quote


def _conv_context(conv: Conversation) -> dict:
    return {
        "date": (conv.created_at.isoformat() + "Z") if conv.created_at else None,
        "topic": conv.topic,
        "transcript": conv.transcript,
        "analysis": conv.analysis or {},
    }


def _totals(quote: Quote) -> dict:
    return quote_export.compute_totals(
        quote.line_items or [], quote.tax_percent, quote.discount_percent
    )


def _quote_out(
    quote: Quote, include_versions: bool = False, brand_name: str | None = None
) -> dict:
    out = {
        "id": quote.id,
        "source_type": quote.source_type,
        "source_conversation_id": quote.source_conversation_id,
        "visitor_id": quote.visitor_id,
        "company_id": quote.company_id,
        "brand_id": quote.brand_id,
        "brand_name": brand_name,
        "title": quote.title,
        "client_name": quote.client_name,
        "client_company": quote.client_company,
        "status": quote.status,
        "proposal_text": quote.proposal_text,
        "line_items": quote.line_items or [],
        "currency": quote.currency or "$",
        "tax_percent": quote.tax_percent or 0,
        "discount_percent": quote.discount_percent or 0,
        "notes": quote.notes,
        "totals": _totals(quote),
        "source_conversation_ids": quote.source_conversation_ids or [],
        "attachments_meta": quote.attachments_meta or [],
        "version_count": len(quote.versions or []),
        "created_at": (quote.created_at.isoformat() + "Z") if quote.created_at else None,
        "updated_at": (quote.updated_at.isoformat() + "Z") if quote.updated_at else None,
    }
    if include_versions:
        out["versions"] = quote.versions or []
        out["chat_messages"] = quote.chat_messages or []
    return out


def _gather_chat_source(
    db: Session,
    user: User,
    conversation_ids: list[int] | None,
    visitor_id: int | None,
    company_id: int | None,
) -> tuple[dict, dict]:
    """Resolve the chat's context chips into (quote_field_overrides, ai_context).

    The proposal can be grounded in one or many specific conversations, and/or
    in a contact or company whose conversations are aggregated. Every lookup is
    org-scoped: a cross-tenant id 404s (never leaks another org's data), and
    "no usable transcript" is a 400."""
    convs: list[Conversation] = []
    seen: set[int] = set()
    for cid in conversation_ids or []:
        conv = db.get(Conversation, cid)
        if conv is None or conv.org_id != user.org_id:
            raise HTTPException(status_code=404, detail="Conversation not found")
        if conv.id not in seen:
            convs.append(conv)
            seen.add(conv.id)

    visitor = None
    company = None
    client_name = None
    client_company = None
    if visitor_id:
        visitor = db.get(Visitor, visitor_id)
        if visitor is None or visitor.org_id != user.org_id:
            raise HTTPException(status_code=404, detail="Contact not found")
        client_name = visitor.name
        client_company = visitor.company
    if company_id:
        company = db.get(Company, company_id)
        if company is None or company.org_id != user.org_id:
            raise HTTPException(status_code=404, detail="Company not found")
        client_company = company.name

    # A pinned contact/company pulls in every conversation logged for them, in
    # addition to any explicit conversation chips (the chips and the
    # contact/company are an "and/or", not mutually exclusive). De-dupe while
    # preserving order: explicit conversations first, then aggregated ones.
    def _extend(query_convs):
        for conv in query_convs:
            if conv.id not in seen:
                convs.append(conv)
                seen.add(conv.id)

    if visitor is not None:
        _extend(
            db.query(Conversation)
            .filter(Conversation.org_id == user.org_id,
                    Conversation.visitor_id == visitor.id)
            .order_by(Conversation.created_at.asc())
            .all()
        )
    if company is not None:
        _extend(
            db.query(Conversation)
            .filter(Conversation.org_id == user.org_id,
                    Conversation.company_id == company.id)
            .order_by(Conversation.created_at.asc())
            .all()
        )

    usable = [c for c in convs if (c.transcript or "").strip() or c.analysis]
    if not usable:
        raise HTTPException(
            status_code=400,
            detail="Add at least one conversation with a transcript to draft from.",
        )

    # Fill in client identity from the first usable conversation when the user
    # didn't pin a contact/company. Org-scope these lookups so a dangling
    # cross-tenant id can't leak another org's name into the proposal.
    first = usable[0]
    inferred_visitor_id = first.visitor_id
    inferred_company_id = None
    if first.visitor_id:
        v = db.get(Visitor, first.visitor_id)
        if v and v.org_id == user.org_id and not client_name:
            client_name = v.name
            client_company = client_company or v.company
    if first.company_id:
        c = db.get(Company, first.company_id)
        if c and c.org_id == user.org_id:
            inferred_company_id = c.id
            if not client_company:
                client_company = c.name

    if conversation_ids:
        source_type = "conversation"
    elif visitor_id:
        source_type = "contact"
    elif company_id:
        source_type = "company"
    else:
        source_type = "conversation"

    fields = {
        "source_type": source_type,
        "source_conversation_id": usable[0].id,
        "source_conversation_ids": [c.id for c in usable],
        "visitor_id": visitor.id if visitor else inferred_visitor_id,
        "company_id": company.id if company else inferred_company_id,
        "client_name": client_name,
        "client_company": client_company,
    }

    org = db.get(Organization, user.org_id) if user.org_id else None
    branding = org_branding_dict(org)
    context = {
        "currency": branding.get("currency") or "$",
        "vendor_name": branding.get("company_name"),
        "client_name": client_name,
        "client_company": client_company,
        "conversations": [_conv_context(c) for c in usable],
    }
    return fields, context


def _rebuild_context(db: Session, user: User, quote: Quote) -> dict:
    """Re-resolve the grounding source for a follow-up chat turn so the agent can
    add detail that stays supported by the original conversation(s). Best-effort:
    if the source is gone, returns context with no conversations and the agent
    works from the current proposal plus the chat so far."""
    ids = list(quote.source_conversation_ids or [])
    if not ids and quote.source_conversation_id:
        ids = [quote.source_conversation_id]

    convs: list[Conversation] = []
    seen: set[int] = set()
    for cid in ids:
        if not cid:
            continue
        conv = db.get(Conversation, cid)
        if conv and conv.org_id == user.org_id and conv.id not in seen:
            convs.append(conv)
            seen.add(conv.id)

    if not convs:
        if quote.source_type == "contact" and quote.visitor_id:
            convs = (
                db.query(Conversation)
                .filter(Conversation.org_id == user.org_id,
                        Conversation.visitor_id == quote.visitor_id)
                .order_by(Conversation.created_at.asc())
                .all()
            )
        elif quote.source_type == "company" and quote.company_id:
            convs = (
                db.query(Conversation)
                .filter(Conversation.org_id == user.org_id,
                        Conversation.company_id == quote.company_id)
                .order_by(Conversation.created_at.asc())
                .all()
            )

    usable = [c for c in convs if (c.transcript or "").strip() or c.analysis]
    org = db.get(Organization, user.org_id) if user.org_id else None
    branding = org_branding_dict(org)
    # Refinements stay current with the live brand: rebuild the brand AI context
    # (voice/identity/assets/template) fresh each turn rather than from the frozen
    # snapshot. The selected template id was frozen into branding_snapshot.
    brand = db.get(Brand, quote.brand_id) if quote.brand_id else None
    if brand is not None and brand.org_id != user.org_id:
        brand = None
    vendor_name = branding.get("company_name")
    currency_default = branding.get("currency")
    if brand is not None:
        vendor_name = brand.company_name or brand.name or vendor_name
        currency_default = brand.currency or currency_default
    ctx = {
        "currency": quote.currency or currency_default or "$",
        "vendor_name": vendor_name,
        "client_name": quote.client_name,
        "client_company": quote.client_company,
        "conversations": [_conv_context(c) for c in usable],
    }
    if brand is not None:
        template_id = (quote.branding_snapshot or {}).get("template_id")
        ctx["brand"] = _brand_ai_context(brand, template_id)
    # Persisted attachment text travels with every refinement turn so later
    # edits still take the originally-attached documents into account.
    if quote.attachments_text:
        ctx["attachments_text"] = quote.attachments_text
    return ctx


def _entity_conv_ids(
    db: Session, user: User, *, visitor_id: int | None = None,
    company_id: int | None = None,
) -> list[int]:
    """Every conversation id logged for a contact or company, org-scoped, oldest
    first."""
    q = db.query(Conversation.id).filter(Conversation.org_id == user.org_id)
    if visitor_id is not None:
        q = q.filter(Conversation.visitor_id == visitor_id)
    if company_id is not None:
        q = q.filter(Conversation.company_id == company_id)
    return [row[0] for row in q.order_by(Conversation.created_at.asc()).all()]


def _apply_context(
    db: Session,
    user: User,
    quote: Quote,
    conversation_ids: list[int] | None,
    visitor_id: int | None,
    company_id: int | None,
    *,
    replace: bool,
) -> None:
    """Update an existing quote's grounding context. Mutates the quote (caller
    commits). Every id is org-scoped — a cross-tenant id 404s so no other org's
    data can be linked into a proposal.

    `replace=True` (context endpoint): the explicit conversation list is the full
    desired set, so removing a chip drops it. `replace=False` (chat attachment):
    the explicit conversations are merged into whatever the quote already
    references. In both modes a NEWLY pinned contact/company (one that differs
    from the quote's current pin) expands into its conversations once; an
    already-pinned or just-removed entity is not re-expanded, so individually
    removed conversations stay removed."""
    visitor = None
    company = None
    if visitor_id is not None:
        visitor = db.get(Visitor, visitor_id)
        if visitor is None or visitor.org_id != user.org_id:
            raise HTTPException(status_code=404, detail="Contact not found")
    if company_id is not None:
        company = db.get(Company, company_id)
        if company is None or company.org_id != user.org_id:
            raise HTTPException(status_code=404, detail="Company not found")

    explicit: list[int] = []
    seen: set[int] = set()
    for cid in conversation_ids or []:
        conv = db.get(Conversation, cid)
        if conv is None or conv.org_id != user.org_id:
            raise HTTPException(status_code=404, detail="Conversation not found")
        if conv.id not in seen:
            explicit.append(conv.id)
            seen.add(conv.id)

    if replace:
        final = list(explicit)
        final_seen = set(final)
    else:
        final = list(quote.source_conversation_ids or [])
        final_seen = set(final)
        for cid in explicit:
            if cid not in final_seen:
                final.append(cid)
                final_seen.add(cid)

    if visitor is not None and visitor.id != quote.visitor_id:
        for cid in _entity_conv_ids(db, user, visitor_id=visitor.id):
            if cid not in final_seen:
                final.append(cid)
                final_seen.add(cid)
    if company is not None and company.id != quote.company_id:
        for cid in _entity_conv_ids(db, user, company_id=company.id):
            if cid not in final_seen:
                final.append(cid)
                final_seen.add(cid)

    quote.source_conversation_ids = final
    quote.source_conversation_id = final[0] if final else None

    if replace:
        quote.visitor_id = visitor.id if visitor is not None else None
        quote.company_id = company.id if company is not None else None
    else:
        if visitor is not None:
            quote.visitor_id = visitor.id
        if company is not None:
            quote.company_id = company.id

    if quote.visitor_id:
        quote.source_type = "contact"
    elif quote.company_id:
        quote.source_type = "company"
    else:
        quote.source_type = "conversation"

    # Fill in client identity from a newly pinned entity only when empty, so a
    # manual edit to the client fields is never clobbered.
    if visitor is not None:
        if not quote.client_name:
            quote.client_name = visitor.name
        if not quote.client_company and visitor.company:
            quote.client_company = visitor.company
    if company is not None and not quote.client_company:
        quote.client_company = company.name


def _context_out(db: Session, user: User, quote: Quote) -> dict:
    """The grounding context as removable chips for the workspace: each source
    conversation with a readable label, plus any pinned contact/company."""
    ids = list(quote.source_conversation_ids or [])
    if not ids and quote.source_conversation_id:
        ids = [quote.source_conversation_id]

    conversations: list[dict] = []
    for cid in ids:
        conv = db.get(Conversation, cid)
        if conv is None or conv.org_id != user.org_id:
            continue
        who = None
        if conv.visitor_id:
            v = db.get(Visitor, conv.visitor_id)
            if v and v.org_id == user.org_id:
                who = v.company or v.name
        label = who or "Conversation"
        if conv.topic:
            label = f"{label} — {conv.topic}"
        conversations.append({"id": conv.id, "label": label})

    visitor_out = None
    if quote.visitor_id:
        v = db.get(Visitor, quote.visitor_id)
        if v and v.org_id == user.org_id:
            name = v.name
            if v.company:
                name = f"{name} · {v.company}"
            visitor_out = {"id": v.id, "name": name}

    company_out = None
    if quote.company_id:
        c = db.get(Company, quote.company_id)
        if c and c.org_id == user.org_id:
            company_out = {"id": c.id, "name": c.name}

    return {
        "conversations": conversations,
        "visitor": visitor_out,
        "company": company_out,
    }


# --- routes ---------------------------------------------------------------

@router.post("/chat")
def chat(
    body: ChatIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """The conversational entry point. With no quote_id the message starts a new
    proposal from the supplied context chips; with a quote_id it refines that
    proposal. Either way both messages are appended to the quote's chat thread."""
    _require_anthropic()
    message = (body.message or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    if body.quote_id:
        return _chat_continue(db, user, body, message)
    return _chat_start(db, user, body, message)


async def _read_upload_capped(f: UploadFile, max_bytes: int) -> bytes | None:
    """Stream an upload into memory in chunks, returning None once it exceeds
    max_bytes. A single unbounded ``await f.read()`` would be an OOM/DoS vector
    for a large multipart body."""
    buf = bytearray()
    while chunk := await f.read(1024 * 1024):
        buf.extend(chunk)
        if len(buf) > max_bytes:
            return None
    return bytes(buf)


def _parse_conv_ids(raw: str | None) -> list[int] | None:
    """Parse the JSON-encoded conversation_ids multipart field into ints."""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return [int(x) for x in parsed] if isinstance(parsed, list) else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid conversation_ids.")


async def _attachments_from_uploads(files: list[UploadFile]) -> list[dict]:
    """Stream, size-cap, and parse uploaded documents into grounding payloads.
    Any unreadable / oversized / unsupported file rejects the whole request with
    a clear 400 so a single bad file never crashes the turn (never a 500)."""
    real = [f for f in (files or []) if f is not None and (f.filename or "").strip()]
    if not real:
        return []
    if len(real) > document_parse.MAX_FILES:
        raise HTTPException(
            status_code=400,
            detail=f"Too many files at once (max {document_parse.MAX_FILES}).",
        )
    pairs: list[tuple[str, bytes]] = []
    for f in real:
        data = await _read_upload_capped(f, document_parse.MAX_FILE_BYTES)
        if data is None:
            cap = document_parse.MAX_FILE_BYTES // (1024 * 1024)
            raise HTTPException(
                status_code=400,
                detail=f"'{Path(f.filename).name}': file is too large (max {cap} MB).",
            )
        pairs.append((f.filename, data))
    try:
        return document_parse.build_attachment_payload(pairs)
    except document_parse.DocumentParseError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/chat/upload")
async def chat_upload(
    message: str = Form(...),
    quote_id: int | None = Form(None),
    conversation_ids: str | None = Form(None),
    visitor_id: int | None = Form(None),
    company_id: int | None = Form(None),
    brand_id: int | None = Form(None),
    template_id: str | None = Form(None),
    files: list[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """Multipart sibling of /chat: the same conversational entry point, but the
    salesperson can also attach documents. Files are parsed to text server-side
    and folded into the proposal's grounding (and persisted, so later
    refinements still see them). All other behaviour matches /chat."""
    _require_anthropic()
    msg = (message or "").strip()
    if not msg:
        raise HTTPException(status_code=400, detail="message is required")
    attachments = await _attachments_from_uploads(files)
    parsed = ChatIn(
        message=msg,
        quote_id=quote_id,
        conversation_ids=_parse_conv_ids(conversation_ids),
        visitor_id=visitor_id,
        company_id=company_id,
        brand_id=brand_id,
        template_id=template_id,
    )
    if quote_id:
        return _chat_continue(db, user, parsed, msg, attachments=attachments)
    return _chat_start(db, user, parsed, msg, attachments=attachments)


def _resolve_brand(db: Session, user: User, brand_id: int | None) -> Brand | None:
    """Pick the brand a proposal is drafted under. An explicit brand_id is
    org-scoped (a cross-tenant id 404s). With no brand_id, fall back to the org's
    default brand if one exists, else None (legacy org-branding behaviour)."""
    if brand_id is not None:
        brand = db.get(Brand, brand_id)
        if brand is None or brand.org_id != user.org_id:
            raise HTTPException(status_code=404, detail="Brand not found")
        return brand
    return (
        db.query(Brand)
        .filter(Brand.org_id == user.org_id, Brand.is_default.is_(True))
        .first()
    )


def _find_template(brand: Brand | None, template_id: str | None) -> dict | None:
    if brand is None or not template_id:
        return None
    for t in brand.templates or []:
        if isinstance(t, dict) and t.get("id") == template_id:
            return t
    return None


def _brand_ai_context(brand: Brand | None, template_id: str | None) -> dict | None:
    """The brand's voice/identity/assets and the selected template, shaped for
    the AI prompt. Built fresh from the live brand each turn so refinements stay
    current. assets_text is reference DATA only (the prompt enforces that)."""
    if brand is None:
        return None
    tmpl = _find_template(brand, template_id)
    ctx = {
        "name": brand.name,
        "company_name": brand.company_name,
        "business_description": brand.business_description,
        "voice": brand.brand_voice,
        "assets_text": brand.assets_text,
        "terms": brand.terms,
    }
    if tmpl:
        ctx["template"] = {
            "name": tmpl.get("name"),
            "template_type": tmpl.get("template_type"),
            "instructions": tmpl.get("instructions"),
        }
    return ctx


def _brand_name_for(db: Session, quote: Quote) -> str | None:
    """The display name of the quote's brand, if any (org-scoped lookup)."""
    if not quote.brand_id:
        return None
    brand = db.get(Brand, quote.brand_id)
    if brand is None or brand.org_id != quote.org_id:
        return None
    return brand.name or "Brand"


def _chat_start(
    db: Session, user: User, body: ChatIn, message: str,
    attachments: list[dict] | None = None,
) -> dict:
    """First turn: ground in the chosen conversations/contact/company, draft the
    proposal, and seed the chat thread. Any attached documents are folded into
    the grounding context and persisted on the new quote."""
    fields, context = _gather_chat_source(
        db, user, body.conversation_ids, body.visitor_id, body.company_id
    )
    att_text, att_meta = document_parse.merge_attachments(None, None, attachments)
    if att_text:
        context["attachments_text"] = att_text

    # Resolve the brand (explicit, else org default, else none). When present it
    # drives the export branding, the AI's vendor identity/voice/template, and
    # the currency; when absent we fall back to the org's branding unchanged.
    brand = _resolve_brand(db, user, body.brand_id)
    if brand is not None:
        branding = brand_branding_dict(brand)
        branding["template_id"] = body.template_id or None
        context["vendor_name"] = brand.company_name or brand.name or context.get("vendor_name")
        context["currency"] = brand.currency or context.get("currency") or "$"
        context["brand"] = _brand_ai_context(brand, body.template_id)
    else:
        org = db.get(Organization, user.org_id) if user.org_id else None
        branding = org_branding_dict(org)

    result = quote_ai.chat_turn(context, None, [], message)

    now = utcnow()
    stamp = now.isoformat() + "Z"
    thread = [
        {"role": "user", "text": message, "at": stamp},
        {
            "role": "assistant",
            "text": result.get("reply") or "Here's a first draft based on your conversation(s).",
            "at": stamp,
        },
    ]

    quote = Quote(
        org_id=user.org_id,
        user_id=user.id,
        source_type=fields["source_type"],
        source_conversation_id=fields.get("source_conversation_id"),
        source_conversation_ids=fields.get("source_conversation_ids"),
        visitor_id=fields.get("visitor_id"),
        company_id=fields.get("company_id"),
        title=result.get("title") or "Proposal",
        client_name=result.get("client_name") or fields.get("client_name"),
        client_company=result.get("client_company") or fields.get("client_company"),
        status="draft",
        proposal_text=result.get("proposal_text"),
        line_items=result.get("line_items") or [],
        currency=context.get("currency") or "$",
        tax_percent=0.0,
        discount_percent=0.0,
        notes=result.get("notes"),
        brand_id=brand.id if brand is not None else None,
        branding_snapshot=branding,
        versions=[],
        chat_messages=thread,
        attachments_text=att_text,
        attachments_meta=att_meta,
    )
    db.add(quote)
    db.commit()
    db.refresh(quote)
    return _quote_out(
        quote, include_versions=True, brand_name=_brand_name_for(db, quote)
    )


def _chat_continue(
    db: Session, user: User, body: ChatIn, message: str,
    attachments: list[dict] | None = None,
) -> dict:
    """Follow-up turn: refine the existing proposal, snapshot the prior state for
    undo, and append both messages to the thread. Any context attached to the
    message (new conversations / a contact / a company) is merged into the
    quote's grounding source before the turn so the agent can use it. Newly
    uploaded documents are appended to the quote's persisted attachments."""
    quote = _get_owned_quote(db, user, body.quote_id)
    if body.conversation_ids or body.visitor_id or body.company_id:
        _apply_context(
            db, user, quote,
            body.conversation_ids, body.visitor_id, body.company_id,
            replace=False,
        )
    if attachments:
        quote.attachments_text, quote.attachments_meta = document_parse.merge_attachments(
            quote.attachments_text, quote.attachments_meta, attachments
        )
    context = _rebuild_context(db, user, quote)
    current = {
        "title": quote.title,
        "client_name": quote.client_name,
        "client_company": quote.client_company,
        "proposal_text": quote.proposal_text,
        "line_items": quote.line_items or [],
        "notes": quote.notes,
        "currency": quote.currency or "$",
    }
    history = list(quote.chat_messages or [])
    result = quote_ai.chat_turn(context, current, history, message)

    # Snapshot the prior state before overwriting so the user keeps an undo
    # trail. SQLAlchemy needs a new list to detect the JSON change.
    snapshot = {
        "saved_at": utcnow().isoformat() + "Z",
        "feedback": message,
        "title": quote.title,
        "proposal_text": quote.proposal_text,
        "line_items": quote.line_items or [],
    }
    versions = list(quote.versions or [])
    versions.append(snapshot)
    quote.versions = versions

    # Apply the result. chat_turn always re-renders the FULL proposal, so a
    # non-empty proposal_text means the model genuinely rewrote the proposal —
    # in that case its line_items/notes are authoritative and we apply them as
    # returned (allowing an intentional clear, e.g. "remove all line items" ->
    # []). An empty proposal_text means a chat-only or hiccup response, so we
    # leave the proposal untouched and just record the reply, guarding against
    # an accidental wipe.
    quote.title = result.get("title") or quote.title
    if result.get("client_name"):
        quote.client_name = result["client_name"]
    if result.get("client_company"):
        quote.client_company = result["client_company"]
    if result.get("proposal_text"):
        quote.proposal_text = result["proposal_text"]
        quote.line_items = result.get("line_items") or []
        quote.notes = result.get("notes")

    now = utcnow()
    stamp = now.isoformat() + "Z"
    history.append({"role": "user", "text": message, "at": stamp})
    history.append(
        {
            "role": "assistant",
            "text": result.get("reply") or "Done — I've updated the proposal.",
            "at": stamp,
        }
    )
    quote.chat_messages = history
    quote.updated_at = now
    db.commit()
    db.refresh(quote)
    return _quote_out(
        quote, include_versions=True, brand_name=_brand_name_for(db, quote)
    )


@router.get("/{quote_id}/context")
def get_context(
    quote_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """The quote's grounding context as removable chips for the workspace."""
    quote = _get_owned_quote(db, user, quote_id)
    return _context_out(db, user, quote)


@router.put("/{quote_id}/context")
def set_context(
    quote_id: int,
    body: QuoteContextIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    """Replace the quote's grounding context from the workspace's chips. The body
    carries the full explicit conversation list (so removing a chip drops it) and
    the optional pinned contact/company; a newly pinned entity expands into its
    conversations. Subsequent chat turns re-ground from this updated source."""
    quote = _get_owned_quote(db, user, quote_id)
    _apply_context(
        db, user, quote,
        body.conversation_ids, body.visitor_id, body.company_id,
        replace=True,
    )
    quote.updated_at = utcnow()
    db.commit()
    db.refresh(quote)
    return _context_out(db, user, quote)


@router.get("")
def list_quotes(
    limit: int = Query(default=100, ge=1, le=300),
    brand_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> list[dict]:
    """Proposal history, newest first. An optional brand_id narrows the list to a
    single brand (org-scoped); each item carries its brand's display name so the
    UI can group/label history by brand."""
    q = db.query(Quote).filter(Quote.org_id == user.org_id)
    if brand_id is not None:
        q = q.filter(Quote.brand_id == brand_id)
    quotes = q.order_by(Quote.updated_at.desc()).limit(limit).all()
    # One lookup of the org's brands keeps the list endpoint O(1) on brand names.
    names = {
        b.id: (b.name or "Brand")
        for b in db.query(Brand).filter(Brand.org_id == user.org_id).all()
    }
    return [_quote_out(qt, brand_name=names.get(qt.brand_id)) for qt in quotes]


@router.get("/{quote_id}")
def get_quote(
    quote_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    quote = _get_owned_quote(db, user, quote_id)
    return _quote_out(
        quote, include_versions=True, brand_name=_brand_name_for(db, quote)
    )


@router.put("/{quote_id}")
def update_quote(
    quote_id: int,
    body: QuoteUpdateIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    quote = _get_owned_quote(db, user, quote_id)
    data = body.model_dump(exclude_unset=True)

    if "title" in data:
        quote.title = (data["title"] or "Proposal").strip()[:300] or "Proposal"
    if "client_name" in data:
        quote.client_name = (data["client_name"] or "").strip() or None
    if "client_company" in data:
        quote.client_company = (data["client_company"] or "").strip() or None
    if "proposal_text" in data:
        quote.proposal_text = data["proposal_text"]
    if "line_items" in data and data["line_items"] is not None:
        quote.line_items = [
            {
                "description": li["description"].strip(),
                "quantity": float(li.get("quantity", 1) or 0),
                "unit_price": round(float(li.get("unit_price", 0) or 0), 2),
            }
            for li in data["line_items"]
            if (li.get("description") or "").strip()
        ]
    if "currency" in data:
        quote.currency = (data["currency"] or "").strip() or "$"
    if "tax_percent" in data and data["tax_percent"] is not None:
        quote.tax_percent = max(0.0, float(data["tax_percent"]))
    if "discount_percent" in data and data["discount_percent"] is not None:
        quote.discount_percent = max(0.0, float(data["discount_percent"]))
    if "notes" in data:
        quote.notes = data["notes"]
    if "status" in data and data["status"] in ("draft", "final"):
        quote.status = data["status"]

    quote.updated_at = utcnow()
    db.commit()
    db.refresh(quote)
    return _quote_out(
        quote, include_versions=True, brand_name=_brand_name_for(db, quote)
    )


@router.delete("/{quote_id}", status_code=204)
def delete_quote(
    quote_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> None:
    quote = _get_owned_quote(db, user, quote_id)
    db.delete(quote)
    db.commit()


def _export_branding(db: Session, user: User, quote: Quote) -> dict:
    """Prefer the branding frozen on the quote; fall back to the org's current
    branding so quotes created before branding existed still render."""
    if quote.branding_snapshot:
        return quote.branding_snapshot
    org = db.get(Organization, user.org_id) if user.org_id else None
    return org_branding_dict(org)


def _safe_filename(quote: Quote, ext: str) -> str:
    base = (quote.title or "proposal").strip() or "proposal"
    safe = "".join(c if c.isalnum() or c in (" ", "-", "_") else "_" for c in base)
    safe = safe.strip().replace(" ", "_")[:60] or "proposal"
    return f"{safe}.{ext}"


@router.get("/{quote_id}/export.pdf")
def export_pdf(
    quote_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> StreamingResponse:
    quote = _get_owned_quote(db, user, quote_id)
    branding = _export_branding(db, user, quote)
    pdf_bytes = quote_export.render_pdf(_quote_out(quote), branding)
    filename = _safe_filename(quote, "pdf")
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{quote_id}/export.docx")
def export_docx(
    quote_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> StreamingResponse:
    quote = _get_owned_quote(db, user, quote_id)
    branding = _export_branding(db, user, quote)
    docx_bytes = quote_export.render_docx(_quote_out(quote), branding)
    filename = _safe_filename(quote, "docx")
    return StreamingResponse(
        io.BytesIO(docx_bytes),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
