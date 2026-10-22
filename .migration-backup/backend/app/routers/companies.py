"""Companies (CRM "Accounts") — first-class records.

A Company groups many contact persons (Visitor rows) and, transitively,
many Conversations (transcripts). Created automatically by the scanner
when a business card is captured, and editable/creatable manually here.

Endpoints
---------
GET    /api/companies                 — summary list (counts only)
POST   /api/companies                 — create a company manually
GET    /api/companies/{id}            — full detail + contacts + conversations
PUT    /api/companies/{id}            — partial update
DELETE /api/companies/{id}            — delete; contacts are unlinked, not deleted
POST   /api/companies/{id}/contacts   — add a contact person to this company
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Company, Conversation, User, Visitor
from ..services.address import parse_address
from ..schemas import (
    CompanyConversation,
    CompanyDetail,
    CompanyIn,
    CompanyOut,
    CompanySummary,
    CompanyUpdate,
    VisitorIn,
    VisitorOut,
)
from .auth import require_user

router = APIRouter(prefix="/api/companies", tags=["companies"])


def _find_company_by_name(db: Session, org_id: int | None, name: str) -> Company | None:
    """Case-insensitive lookup, scoped to the org. Used by the scanner."""
    clean = (name or "").strip()
    if not clean:
        return None
    return db.scalar(
        select(Company).where(
            Company.org_id == org_id,
            Company.name.ilike(clean),
        )
    )


def upsert_company_for_scan(
    db: Session,
    org_id: int | None,
    *,
    name: str,
    website: str | None = None,
    industry: str | None = None,
    address: str | None = None,
    gst_number: str | None = None,
    phone: str | None = None,
    email: str | None = None,
    city: str | None = None,
    state: str | None = None,
    country: str | None = None,
) -> Company | None:
    """Find-or-create a Company by name within an org, enriching empty
    fields from new scan data without overwriting any manual edits.

    A scanned card carries a single combined address; when city / state /
    country aren't supplied explicitly we split that address so those columns
    get populated too (see ``services.address.parse_address``).
    """
    if not (name or "").strip():
        return None
    if address and not (city and state and country):
        p_city, p_state, p_country = parse_address(address)
        city = city or p_city
        state = state or p_state
        country = country or p_country
    company = _find_company_by_name(db, org_id, name)
    if company is None:
        company = Company(
            org_id=org_id,
            name=name.strip(),
            website=website,
            industry=industry,
            address=address,
            gst_number=gst_number,
            phone=phone,
            email=email,
            city=city,
            state=state,
            country=country,
        )
        db.add(company)
        db.flush()
        return company
    # Enrichment only — don't clobber existing values.
    for attr, value in (
        ("website", website), ("industry", industry), ("address", address),
        ("gst_number", gst_number), ("phone", phone), ("email", email),
        ("city", city), ("state", state), ("country", country),
    ):
        if value and not getattr(company, attr, None):
            setattr(company, attr, value)
    return company


def _summary_for(c: Company, contacts: list[Visitor], conv_count: int) -> CompanySummary:
    return CompanySummary(
        **CompanyOut.model_validate(c).model_dump(),
        contact_count=len(contacts),
        lead_count=sum(1 for v in contacts if (v.contact_type or "lead") == "lead"),
        customer_count=sum(1 for v in contacts if v.contact_type == "customer"),
        employee_count=sum(1 for v in contacts if v.contact_type == "employee"),
        conversation_count=conv_count,
    )


@router.get("", response_model=list[CompanySummary])
def list_companies(
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> list[CompanySummary]:
    companies = list(
        db.scalars(select(Company).where(Company.org_id == user.org_id))
    )
    if not companies:
        return []
    # One-shot fetch of contacts + conversation counts for the whole org so
    # this stays O(1) queries regardless of company count.
    visitors = list(
        db.scalars(select(Visitor).where(Visitor.org_id == user.org_id))
    )
    by_company: dict[int, list[Visitor]] = {}
    for v in visitors:
        if v.company_id:
            by_company.setdefault(v.company_id, []).append(v)

    # Count conversations per company directly off Conversation.company_id —
    # the authoritative link now that Option 5 Hybrid is in place. Scoped
    # to the org so a stray cross-tenant link can't inflate counts.
    conv_counts: dict[int, int] = {}
    conv_rows = list(
        db.execute(
            select(Conversation.company_id)
            .where(
                Conversation.org_id == user.org_id,
                Conversation.company_id.is_not(None),
            )
        )
    )
    for (cid,) in conv_rows:
        conv_counts[cid] = conv_counts.get(cid, 0) + 1

    out = [
        _summary_for(c, by_company.get(c.id, []), conv_counts.get(c.id, 0))
        for c in companies
    ]
    out.sort(key=lambda s: s.name.lower())
    return out


@router.post("", response_model=CompanyOut, status_code=status.HTTP_201_CREATED)
def create_company(
    payload: CompanyIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> Company:
    existing = _find_company_by_name(db, user.org_id, payload.name)
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=f"A company named '{payload.name}' already exists.",
        )
    company = Company(org_id=user.org_id, **payload.model_dump(exclude_none=True, mode="json"))
    db.add(company)
    db.commit()
    db.refresh(company)
    return company


def _get_owned(db: Session, company_id: int, user: User) -> Company:
    c = db.get(Company, company_id)
    if c is None or c.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Company not found")
    return c


@router.get("/{company_id}", response_model=CompanyDetail)
def company_detail(
    company_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> CompanyDetail:
    c = _get_owned(db, company_id, user)
    # Belt-and-braces: scope the contact lookup by org_id too. If a stray
    # cross-tenant link ever slipped in (bug, manual SQL, …) we still won't
    # surface it on someone else's company page.
    contacts = list(
        db.scalars(
            select(Visitor)
            .where(Visitor.company_id == c.id, Visitor.org_id == user.org_id)
            .order_by(Visitor.created_at.desc())
        )
    )
    # Transcript list: union of
    #   (a) "direct" — Conversation.company_id == this company, AND
    #   (b) "via_visitor" — legacy rows where the contact still belongs
    #       to this company but the conversation itself wasn't relinked.
    # (b) shrinks over time as the backfill runs and new captures set
    # company_id at write time, but it keeps the page useful right now.
    convs: list[CompanyConversation] = []
    visitor_name_by_id = {v.id: v.name for v in contacts}

    direct_rows = list(
        db.scalars(
            select(Conversation)
            .where(
                Conversation.company_id == c.id,
                Conversation.org_id == user.org_id,
            )
            .order_by(Conversation.created_at.desc())
        )
    )
    seen_ids = {r.id for r in direct_rows}

    via_visitor_rows: list[Conversation] = []
    if contacts:
        visitor_ids = [v.id for v in contacts]
        via_visitor_rows = list(
            db.scalars(
                select(Conversation)
                .where(
                    Conversation.visitor_id.in_(visitor_ids),
                    Conversation.org_id == user.org_id,
                    Conversation.company_id.is_(None),
                )
                .order_by(Conversation.created_at.desc())
            )
        )

    def _row(r: Conversation, link_source: str) -> CompanyConversation:
        return CompanyConversation(
            id=r.id,
            visitor_id=r.visitor_id,
            visitor_name=visitor_name_by_id.get(r.visitor_id),
            staff_name=r.staff_name,
            transcript=r.transcript,
            status=r.status,
            lead_score=r.lead_score,
            lead_temperature=r.lead_temperature,
            duration_seconds=r.duration_seconds,
            created_at=r.created_at,
            link_source=link_source,
        )

    convs = [_row(r, "direct") for r in direct_rows]
    convs.extend(_row(r, "via_visitor") for r in via_visitor_rows if r.id not in seen_ids)
    convs.sort(key=lambda x: x.created_at, reverse=True)

    base = CompanyOut.model_validate(c).model_dump()
    return CompanyDetail(
        **base,
        contacts=[VisitorOut.model_validate(v) for v in contacts],
        conversations=convs,
        contact_count=len(contacts),
        lead_count=sum(1 for v in contacts if (v.contact_type or "lead") == "lead"),
        customer_count=sum(1 for v in contacts if v.contact_type == "customer"),
        employee_count=sum(1 for v in contacts if v.contact_type == "employee"),
    )


@router.put("/{company_id}", response_model=CompanyOut)
def update_company(
    company_id: int,
    payload: CompanyUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> Company:
    c = _get_owned(db, company_id, user)
    data = payload.model_dump(exclude_unset=True, mode="json")

    # If the name changed, reject collisions and sync each contact's
    # denormalized `company` string so the contacts list stays consistent.
    if "name" in data and data["name"] and data["name"].strip().lower() != c.name.strip().lower():
        clash = _find_company_by_name(db, user.org_id, data["name"])
        if clash and clash.id != c.id:
            raise HTTPException(
                status_code=409,
                detail=f"A company named '{data['name']}' already exists.",
            )
        new_name = data["name"].strip()
        for v in db.scalars(
            select(Visitor).where(Visitor.company_id == c.id, Visitor.org_id == user.org_id)
        ):
            v.company = new_name

    for k, v in data.items():
        setattr(c, k, v)
    db.commit()
    db.refresh(c)
    return c


@router.delete("/{company_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_company(
    company_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> None:
    c = _get_owned(db, company_id, user)
    # Unlink contacts — keeps their data + transcripts intact. The FK is
    # `ON DELETE SET NULL`, but we also clear the denormalized string so
    # they don't appear to "still belong" to a deleted company in lists.
    for v in db.scalars(
        select(Visitor).where(Visitor.company_id == c.id, Visitor.org_id == user.org_id)
    ):
        v.company_id = None
        v.company = None
    db.delete(c)
    db.commit()


@router.post("/{company_id}/contacts", response_model=VisitorOut, status_code=status.HTTP_201_CREATED)
def add_contact_to_company(
    company_id: int,
    payload: VisitorIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> Visitor:
    """Add a contact person under this company. Dedups by email/phone
    within the org so re-adding the same person updates the link."""
    c = _get_owned(db, company_id, user)

    existing: Visitor | None = None
    if payload.email or payload.phone:
        clauses = []
        if payload.email:
            clauses.append(Visitor.email == str(payload.email))
        if payload.phone:
            clauses.append(Visitor.phone == payload.phone)
        existing = db.scalar(
            select(Visitor).where(and_(Visitor.org_id == user.org_id, or_(*clauses)))
        )
    if existing is not None:
        existing.company_id = c.id
        existing.company = c.name
        if payload.designation and not existing.designation:
            existing.designation = payload.designation
        if payload.contact_type:
            existing.contact_type = payload.contact_type
        db.commit()
        db.refresh(existing)
        return existing

    data = payload.model_dump(exclude_none=True, mode="json")
    data.pop("company_id", None)  # we set it explicitly below
    data["company"] = c.name
    visitor = Visitor(**data)
    visitor.org_id = user.org_id
    visitor.company_id = c.id
    db.add(visitor)
    db.commit()
    db.refresh(visitor)
    return visitor
