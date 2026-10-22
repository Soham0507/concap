"""Organization + member management. Owner/Admin only for mutations.

No email delivery in this MVP: inviting a member creates the account with a
generated temporary password that is returned ONCE to the inviting admin to
hand over. The invitee is forced to change it on first login
(must_change_password=True).
"""
from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    ROLE_ADMIN,
    ROLE_MEMBER,
    ROLE_OWNER,
    ROLE_RANK,
    Conversation,
    Organization,
    Session as CaptureSession,
    User,
    Visitor,
)
from ..services.auth import hash_password
from .auth import require_admin, require_user

router = APIRouter(prefix="/api/org", tags=["org"])


class OrgOut(BaseModel):
    id: int
    name: str
    org_type: str

    class Config:
        from_attributes = True


class MemberOut(BaseModel):
    id: int
    email: EmailStr
    name: str | None
    role: str
    is_active: bool
    must_change_password: bool

    class Config:
        from_attributes = True


class InviteIn(BaseModel):
    email: EmailStr
    name: str | None = None
    role: str = Field(default=ROLE_MEMBER, pattern="^(admin|member)$")


class InviteOut(BaseModel):
    member: MemberOut
    temporary_password: str


class MemberUpdate(BaseModel):
    role: str | None = Field(default=None, pattern="^(admin|member)$")
    is_active: bool | None = None


@router.get("", response_model=OrgOut)
def get_org(user: User = Depends(require_user), db: Session = Depends(get_db)) -> OrgOut:
    org = db.get(Organization, user.org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    return OrgOut.model_validate(org)


@router.get("/members", response_model=list[MemberOut])
def list_members(user: User = Depends(require_user), db: Session = Depends(get_db)) -> list[MemberOut]:
    rows = db.scalars(
        select(User).where(User.org_id == user.org_id).order_by(User.created_at)
    ).all()
    return [MemberOut.model_validate(u) for u in rows]


@router.post("/members", response_model=InviteOut, status_code=status.HTTP_201_CREATED)
def invite_member(
    payload: InviteIn,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> InviteOut:
    org = db.get(Organization, admin.org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    if org.org_type == "individual":
        raise HTTPException(
            status_code=400,
            detail="Individual workspaces can't have additional members. Use a company account.",
        )

    email = payload.email.lower().strip()
    if db.scalar(select(User).where(func.lower(User.email) == email)) is not None:
        raise HTTPException(status_code=409, detail="A user with this email already exists")

    temp_password = secrets.token_urlsafe(9)
    member = User(
        org_id=admin.org_id,
        email=email,
        name=(payload.name or None),
        password_hash=hash_password(temp_password),
        role=payload.role,
        must_change_password=True,
        is_active=True,
    )
    db.add(member)
    db.commit()
    db.refresh(member)
    return InviteOut(member=MemberOut.model_validate(member), temporary_password=temp_password)


@router.patch("/members/{member_id}", response_model=MemberOut)
def update_member(
    member_id: int,
    payload: MemberUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MemberOut:
    member = db.get(User, member_id)
    if member is None or member.org_id != admin.org_id:
        raise HTTPException(status_code=404, detail="Member not found")
    if member.role == ROLE_OWNER:
        raise HTTPException(status_code=403, detail="The owner cannot be modified")
    if member.id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot modify your own role or status")
    # Admins can't outrank themselves; only the owner can mint admins.
    if payload.role == ROLE_ADMIN and ROLE_RANK[admin.role] < ROLE_RANK[ROLE_OWNER]:
        raise HTTPException(status_code=403, detail="Only the owner can grant the admin role")

    if payload.role is not None:
        member.role = payload.role
    if payload.is_active is not None:
        member.is_active = payload.is_active
    db.commit()
    db.refresh(member)
    return MemberOut.model_validate(member)


# -- Admin overview ---------------------------------------------------------

class RecentConversation(BaseModel):
    id: int
    visitor_name: str
    visitor_company: str | None
    staff_name: str | None
    status: str
    lead_score: int | None
    lead_temperature: str | None
    created_at: str


class OrgStats(BaseModel):
    members: int
    visitors: int
    conversations: int
    sessions: int
    hot_leads: int
    warm_leads: int


class OrgOverview(BaseModel):
    organization: OrgOut
    stats: OrgStats
    members: list[MemberOut]
    recent_conversations: list[RecentConversation]


@router.get("/overview", response_model=OrgOverview)
def org_overview(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> OrgOverview:
    """Company admin dashboard — everything scoped to the caller's org."""
    org = db.get(Organization, admin.org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")

    oid = admin.org_id

    def _count(model, *extra):
        stmt = select(func.count()).select_from(model).where(model.org_id == oid)
        for e in extra:
            stmt = stmt.where(e)
        return db.scalar(stmt) or 0

    stats = OrgStats(
        members=db.scalar(select(func.count()).select_from(User).where(User.org_id == oid)) or 0,
        visitors=_count(Visitor),
        conversations=_count(Conversation),
        sessions=_count(CaptureSession),
        hot_leads=_count(Conversation, Conversation.lead_temperature == "hot"),
        warm_leads=_count(Conversation, Conversation.lead_temperature == "warm"),
    )

    members = db.scalars(
        select(User).where(User.org_id == oid).order_by(User.created_at)
    ).all()

    rows = db.execute(
        select(Conversation, Visitor)
        .join(Visitor, Visitor.id == Conversation.visitor_id)
        .where(Conversation.org_id == oid)
        .order_by(Conversation.created_at.desc())
        .limit(10)
    ).all()
    recent = [
        RecentConversation(
            id=c.id,
            visitor_name=v.name,
            visitor_company=v.company,
            staff_name=c.staff_name,
            status=c.status,
            lead_score=c.lead_score,
            lead_temperature=c.lead_temperature,
            created_at=c.created_at.isoformat(),
        )
        for c, v in rows
    ]

    return OrgOverview(
        organization=OrgOut.model_validate(org),
        stats=stats,
        members=[MemberOut.model_validate(m) for m in members],
        recent_conversations=recent,
    )
