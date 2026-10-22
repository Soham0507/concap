"""Brand management for the Multi-Brand Quote Agent.

An org can keep several brands and pick one (plus an optional proposal template)
when drafting a proposal. A brand carries its identity, look, voice, reusable
asset text extracted from uploaded documents, and a list of proposal templates.

Org-scoped like the rest of the app: every member reads their org's brands; only
an owner/admin may create, change, or delete them (mirrors the single org-wide
branding settings). A cross-tenant id returns 404 (never 403) to avoid id
enumeration. Logos and asset text live on the row so they travel with the DB and
need no separate file store.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import Brand, Quote, User, utcnow
from ..services import document_parse
from .auth import require_admin, require_user
from .branding import MAX_LOGO_CHARS

router = APIRouter(prefix="/api/brands", tags=["brands"])

# Cap the concatenated brand asset text kept on the row, so the grounding
# context (and the model prompt) can never grow unbounded. Matches the spirit of
# document_parse.TOTAL_DOC_CHARS but is brand-wide rather than per-proposal.
MAX_ASSETS_CHARS = 120_000
# Recognised asset categories for the uploaded brand documents. "other" is the
# catch-all so the upload never fails purely on an unexpected label.
ASSET_KINDS = {
    "terms",
    "contract",
    "cover",
    "catalog",
    "pricing",
    "marketing",
    "other",
}


class TemplateIn(BaseModel):
    id: str | None = None
    name: str | None = None
    template_type: str | None = None
    instructions: str | None = None


class BrandIn(BaseModel):
    """The full editable state of a brand. The frontend sends the complete
    state on save, so an empty string clears a field."""
    name: str | None = None
    company_name: str | None = None
    logo_data_url: str | None = None
    address: str | None = None
    email: str | None = None
    phone: str | None = None
    website: str | None = None
    primary_color: str | None = None
    accent_color: str | None = None
    currency: str | None = None
    proposal_theme: str | None = None
    typography: str | None = None
    business_description: str | None = None
    brand_voice: str | None = None
    terms: str | None = None
    signature: str | None = None
    footer: str | None = None
    templates: list[TemplateIn] | None = None


def _normalize_templates(templates: list[TemplateIn] | None) -> list[dict]:
    """Coerce the incoming templates into clean dicts, dropping blank ones and
    assigning a stable id to any that lack one. A template is kept only when it
    has a name or instructions."""
    out: list[dict] = []
    for t in templates or []:
        name = (t.name or "").strip()
        instructions = (t.instructions or "").strip()
        if not name and not instructions:
            continue
        out.append(
            {
                "id": (t.id or "").strip() or uuid.uuid4().hex[:12],
                "name": name or "Untitled template",
                "template_type": (t.template_type or "").strip() or None,
                "instructions": instructions or None,
            }
        )
    return out


def _brand_out(brand: Brand) -> dict:
    """Full brand detail for the management page."""
    return {
        "id": brand.id,
        "is_default": bool(brand.is_default),
        "name": brand.name or "Brand",
        "company_name": brand.company_name,
        "logo_data_url": brand.logo_data_url,
        "address": brand.address,
        "email": brand.email,
        "phone": brand.phone,
        "website": brand.website,
        "primary_color": brand.primary_color,
        "accent_color": brand.accent_color,
        "currency": brand.currency or "$",
        "proposal_theme": brand.proposal_theme,
        "typography": brand.typography,
        "business_description": brand.business_description,
        "brand_voice": brand.brand_voice,
        "terms": brand.terms,
        "signature": brand.signature,
        "footer": brand.footer,
        "assets_text": brand.assets_text,
        "assets_meta": _assets_meta_public(brand.assets_meta),
        "templates": brand.templates or [],
        "updated_at": (brand.updated_at.isoformat() + "Z") if brand.updated_at else None,
        "ai_configured": get_settings().anthropic_configured(),
    }


def _brand_summary(brand: Brand) -> dict:
    """Lightweight brand row for lists / selectors (no heavy logo or asset text)."""
    return {
        "id": brand.id,
        "name": brand.name or "Brand",
        "company_name": brand.company_name,
        "is_default": bool(brand.is_default),
        "primary_color": brand.primary_color,
        "accent_color": brand.accent_color,
        "currency": brand.currency or "$",
        "templates": [
            {
                "id": t.get("id"),
                "name": t.get("name"),
                "template_type": t.get("template_type"),
            }
            for t in (brand.templates or [])
            if isinstance(t, dict)
        ],
    }


def brand_branding_dict(brand: Brand) -> dict:
    """The frozen branding dict stamped onto a quote at creation and read by the
    export renderers. Carries the export-visible identity/look plus the brand's
    boilerplate (terms / signature / footer). Kept in sync with
    branding.org_branding_dict so a quote renders the same way either way."""
    return {
        "company_name": brand.company_name,
        "logo_data_url": brand.logo_data_url,
        "address": brand.address,
        "email": brand.email,
        "phone": brand.phone,
        "website": brand.website,
        "primary_color": brand.primary_color,
        "accent_color": brand.accent_color,
        "currency": brand.currency or "$",
        "terms": brand.terms,
        "signature": brand.signature,
        "footer": brand.footer,
        "brand_id": brand.id,
        "brand_name": brand.name or "Brand",
    }


def _rebuild_assets_text(meta: list[dict]) -> str | None:
    """Concatenate the per-document text held in the asset metadata into one
    labelled, capped reference block. Keeping each doc's text inside the meta
    lets a single asset be deleted exactly, rather than leaving orphaned prose
    behind in a flat text column."""
    blocks: list[str] = []
    for a in meta:
        text = (a.get("text") or "").strip()
        if not text:
            continue
        name = a.get("name") or "document"
        label = (a.get("kind") or "other").title()
        blocks.append(f"### {label} — {name}\n{text}")
    combined = "\n\n".join(blocks)[:MAX_ASSETS_CHARS]
    return combined or None


def _assets_meta_public(meta: list[dict] | None) -> list[dict]:
    """The asset metadata without the bulky per-doc text — what the UI shows."""
    return [
        {"name": a.get("name"), "kind": a.get("kind"), "chars": a.get("chars")}
        for a in (meta or [])
        if isinstance(a, dict)
    ]


def _get_owned_brand(db: Session, user: User, brand_id: int) -> Brand:
    brand = db.get(Brand, brand_id)
    if brand is None or brand.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Not found")
    return brand


def _validate_logo(logo: str | None) -> None:
    if logo is not None and logo != "":
        if not logo.startswith("data:image/"):
            raise HTTPException(status_code=400, detail="Logo must be an image data URL")
        if len(logo) > MAX_LOGO_CHARS:
            raise HTTPException(
                status_code=400,
                detail="Logo image is too large — please use one under ~1 MB.",
            )


def _apply(brand: Brand, body: BrandIn) -> None:
    """Apply the full submitted state onto the brand row (empty string clears)."""
    brand.name = (body.name or "").strip()[:200] or "Brand"
    brand.company_name = (body.company_name or "").strip() or None
    if body.logo_data_url is not None:
        brand.logo_data_url = body.logo_data_url or None
    brand.address = (body.address or "").strip() or None
    brand.email = (body.email or "").strip() or None
    brand.phone = (body.phone or "").strip() or None
    brand.website = (body.website or "").strip() or None
    brand.primary_color = (body.primary_color or "").strip() or None
    brand.accent_color = (body.accent_color or "").strip() or None
    brand.currency = (body.currency or "").strip() or "$"
    brand.proposal_theme = (body.proposal_theme or "").strip() or None
    brand.typography = (body.typography or "").strip() or None
    brand.business_description = (body.business_description or "").strip() or None
    brand.brand_voice = (body.brand_voice or "").strip() or None
    brand.terms = (body.terms or "").strip() or None
    brand.signature = (body.signature or "").strip() or None
    brand.footer = (body.footer or "").strip() or None
    if body.templates is not None:
        brand.templates = _normalize_templates(body.templates)
    brand.updated_at = utcnow()


@router.get("")
def list_brands(
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> list[dict]:
    brands = (
        db.query(Brand)
        .filter(Brand.org_id == user.org_id)
        .order_by(Brand.is_default.desc(), Brand.name.asc())
        .all()
    )
    return [_brand_summary(b) for b in brands]


@router.post("", status_code=201)
def create_brand(
    body: BrandIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    _validate_logo(body.logo_data_url)
    brand = Brand(org_id=user.org_id)
    _apply(brand, body)
    # The org's first brand becomes its default so the selector always has a
    # sensible pre-selection.
    has_any = (
        db.query(Brand.id).filter(Brand.org_id == user.org_id).first() is not None
    )
    brand.is_default = not has_any
    db.add(brand)
    db.commit()
    db.refresh(brand)
    return _brand_out(brand)


@router.get("/{brand_id}")
def get_brand(
    brand_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    return _brand_out(_get_owned_brand(db, user, brand_id))


@router.put("/{brand_id}")
def update_brand(
    brand_id: int,
    body: BrandIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    brand = _get_owned_brand(db, user, brand_id)
    _validate_logo(body.logo_data_url)
    _apply(brand, body)
    db.commit()
    db.refresh(brand)
    return _brand_out(brand)


@router.delete("/{brand_id}", status_code=204)
def delete_brand(
    brand_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> None:
    brand = _get_owned_brand(db, user, brand_id)
    was_default = bool(brand.is_default)
    # Detach the brand from any quotes that referenced it before deleting. Fresh
    # DBs created from the model get ON DELETE SET NULL automatically, but DBs
    # upgraded via the database.py ALTER carry a plain column with no FK (and
    # SQLite doesn't enforce FKs by default), so do it explicitly to keep the
    # frozen branding_snapshot intact while clearing the dangling pointer.
    db.query(Quote).filter(Quote.brand_id == brand.id).update(
        {Quote.brand_id: None}, synchronize_session=False
    )
    db.delete(brand)
    db.flush()
    # If we removed the default, promote another brand so the org keeps one.
    if was_default:
        nxt = (
            db.query(Brand)
            .filter(Brand.org_id == user.org_id)
            .order_by(Brand.name.asc())
            .first()
        )
        if nxt is not None:
            nxt.is_default = True
    db.commit()


@router.put("/{brand_id}/default")
def set_default_brand(
    brand_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    brand = _get_owned_brand(db, user, brand_id)
    db.query(Brand).filter(
        Brand.org_id == user.org_id, Brand.id != brand.id
    ).update({Brand.is_default: False})
    brand.is_default = True
    brand.updated_at = utcnow()
    db.commit()
    db.refresh(brand)
    return _brand_out(brand)


@router.post("/{brand_id}/assets")
async def upload_assets(
    brand_id: int,
    files: list[UploadFile] = File(...),
    kind: str = Form("other"),
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    """Parse one or more uploaded brand documents (PDF/Word/text) into reference
    text appended to the brand's assets. The text grounds the AI as DATA only;
    it never overrides the no-inventing-prices rules."""
    brand = _get_owned_brand(db, user, brand_id)
    label = (kind or "other").strip().lower()
    if label not in ASSET_KINDS:
        label = "other"

    payloads: list[tuple[str, bytes]] = []
    for f in files:
        data = await f.read()
        payloads.append((f.filename or "document", data))
    try:
        parsed = document_parse.build_attachment_payload(payloads)
    except document_parse.DocumentParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    meta = list(brand.assets_meta or [])
    for a in parsed:
        name = a.get("name") or "document"
        text = (a.get("text") or "").strip()
        if not text:
            continue
        # Keep each doc's text inside the metadata so a single asset can later be
        # deleted exactly; assets_text is always rebuilt from these.
        meta.append({"name": name, "kind": label, "chars": len(text), "text": text})

    brand.assets_meta = meta or None
    brand.assets_text = _rebuild_assets_text(meta)
    brand.updated_at = utcnow()
    db.commit()
    db.refresh(brand)
    return _brand_out(brand)


@router.delete("/{brand_id}/assets/{index}")
def delete_asset(
    brand_id: int,
    index: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    """Remove one uploaded asset by its position. The concatenated reference text
    is rebuilt from the surviving documents, so the deleted document's text is
    dropped exactly."""
    brand = _get_owned_brand(db, user, brand_id)
    meta = list(brand.assets_meta or [])
    if index < 0 or index >= len(meta):
        raise HTTPException(status_code=404, detail="Asset not found")
    meta.pop(index)
    brand.assets_meta = meta or None
    brand.assets_text = _rebuild_assets_text(meta)
    brand.updated_at = utcnow()
    db.commit()
    db.refresh(brand)
    return _brand_out(brand)
