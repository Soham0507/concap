from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Company, Conversation, User, Visitor
from ..schemas import ContactConversation, VisitorIn, VisitorOut, VisitorUpdate
from .auth import require_user
from .companies import upsert_company_for_scan


def _resolve_owned_company(db: Session, org_id: int | None, company_id: int) -> Company:
    """Look up a Company by id and assert it belongs to the caller's org.
    Used everywhere we accept a `company_id` from user input — without this
    a caller could link visitors into another tenant's company.
    """
    c = db.get(Company, company_id)
    if c is None or c.org_id != org_id:
        raise HTTPException(status_code=404, detail="Company not found")
    return c

router = APIRouter(prefix="/api/visitors", tags=["visitors"])


@router.post("", response_model=VisitorOut, status_code=status.HTTP_201_CREATED)
def create_visitor(
    payload: VisitorIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> Visitor:
    """Create a visitor record, scoped to the caller's organization.

    Deduplicates on email/phone *within the same org* — the same email in a
    different company is a different visitor.
    """
    if payload.email or payload.phone:
        ident = []
        if payload.email:
            ident.append(Visitor.email == str(payload.email))
        if payload.phone:
            ident.append(Visitor.phone == payload.phone)
        existing = db.scalar(
            select(Visitor).where(and_(Visitor.org_id == user.org_id, or_(*ident)))
        )
        if existing:
            return existing

    visitor = Visitor(**payload.model_dump(exclude_none=True, mode="json"))
    visitor.org_id = user.org_id
    # company_id is authoritative when supplied — but must be validated as
    # owned by this org (otherwise a caller could link into another tenant).
    # When only the free-text company string is given, upsert by name.
    if visitor.company_id:
        company = _resolve_owned_company(db, user.org_id, visitor.company_id)
        visitor.company = company.name  # keep denormalized string in sync
    elif visitor.company:
        company = upsert_company_for_scan(
            db, user.org_id,
            name=visitor.company,
            website=visitor.website, industry=visitor.industry,
            address=visitor.address, gst_number=visitor.gst_number,
        )
        if company is not None:
            visitor.company_id = company.id
            visitor.company = company.name
    db.add(visitor)
    db.commit()
    db.refresh(visitor)
    return visitor


@router.get("", response_model=list[VisitorOut])
def list_visitors(
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> list[Visitor]:
    return list(
        db.scalars(
            select(Visitor)
            .where(Visitor.org_id == user.org_id)
            .order_by(Visitor.created_at.desc())
        )
    )


@router.get("/{visitor_id}", response_model=VisitorOut)
def get_visitor(
    visitor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> Visitor:
    visitor = db.get(Visitor, visitor_id)
    if visitor is None or visitor.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Visitor not found")
    return visitor


@router.get("/{visitor_id}/conversations", response_model=list[ContactConversation])
def list_visitor_conversations(
    visitor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> list[ContactConversation]:
    """A contact's conversations, newest first. Org-scoped on both the contact
    and the conversation rows so cross-tenant ids 404 / yield nothing. Company
    names are resolved only for in-org links."""
    visitor = db.get(Visitor, visitor_id)
    if visitor is None or visitor.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Visitor not found")
    rows = list(
        db.scalars(
            select(Conversation)
            .where(
                Conversation.visitor_id == visitor.id,
                Conversation.org_id == user.org_id,
            )
            .order_by(Conversation.created_at.desc())
        )
    )
    company_ids = {r.company_id for r in rows if r.company_id is not None}
    names: dict[int, str] = {}
    if company_ids:
        for co in db.scalars(
            select(Company).where(
                Company.id.in_(company_ids), Company.org_id == user.org_id
            )
        ):
            names[co.id] = co.name

    def _summary(analysis) -> str | None:
        if isinstance(analysis, dict):
            s = str(analysis.get("summary") or "").strip()
            return s or None
        return None

    def _topic(r: Conversation) -> str | None:
        if r.topic and r.topic.strip():
            return r.topic.strip()
        if isinstance(r.analysis, dict):
            t = str(r.analysis.get("topic") or "").strip()
            return t or None
        return None

    out: list[ContactConversation] = []
    for r in rows:
        cid = r.company_id if r.company_id in names else None
        out.append(
            ContactConversation(
                id=r.id,
                topic=_topic(r),
                summary=_summary(r.analysis),
                status=r.status,
                lead_score=r.lead_score,
                lead_temperature=r.lead_temperature,
                duration_seconds=r.duration_seconds,
                created_at=r.created_at,
                company_id=cid,
                company_name=names.get(cid) if cid else None,
            )
        )
    return out


@router.put("/{visitor_id}", response_model=VisitorOut)
def update_visitor(
    visitor_id: int,
    payload: VisitorUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> Visitor:
    """Partial update — only fields present in the payload are touched.

    Used by the contacts/scan UI when the user corrects a mis-parsed field
    or re-categorizes a record (lead → customer).
    """
    visitor = db.get(Visitor, visitor_id)
    if visitor is None or visitor.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Visitor not found")
    data = payload.model_dump(exclude_unset=True, mode="json")
    if "contact_type" in data and data["contact_type"] not in {"lead", "customer", "employee"}:
        raise HTTPException(status_code=422, detail="contact_type must be lead | customer | employee")

    # company_id is authoritative when explicitly sent (e.g. /scan?company_id=).
    # Pop it out so the generic setattr loop doesn't write an unvalidated value.
    explicit_cid = data.pop("company_id", "__missing__")

    for key, value in data.items():
        setattr(visitor, key, value)

    if explicit_cid != "__missing__":
        if explicit_cid is None:
            visitor.company_id = None
            visitor.company = None
        else:
            company = _resolve_owned_company(db, user.org_id, int(explicit_cid))
            visitor.company_id = company.id
            visitor.company = company.name
    elif "company" in data:
        # Name changed (or cleared) without a specific id — re-resolve by name.
        if visitor.company:
            company = upsert_company_for_scan(
                db, user.org_id,
                name=visitor.company,
                website=visitor.website, industry=visitor.industry,
                address=visitor.address, gst_number=visitor.gst_number,
            )
            if company is not None:
                visitor.company_id = company.id
                visitor.company = company.name
        else:
            visitor.company_id = None

    db.commit()
    db.refresh(visitor)
    return visitor


@router.delete("/{visitor_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_visitor(
    visitor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> None:
    visitor = db.get(Visitor, visitor_id)
    if visitor is None or visitor.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Visitor not found")
    db.delete(visitor)
    db.commit()
