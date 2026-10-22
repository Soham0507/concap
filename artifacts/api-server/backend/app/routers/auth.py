"""Signup / login / me / change-password + the require_user dependency.

Signup creates an Organization:
  - account_type="individual" -> a private workspace of one (user = owner)
  - account_type="company"    -> a named company (user = owner)

Additional company users are created by an owner/admin via the org router
(invite by email); they get a temporary password and must_change_password.
"""
from __future__ import annotations

import os
import secrets
from datetime import datetime, timezone
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import ROLE_OWNER, Organization, User
from ..services import google_login_oauth
from ..services.auth import TokenError, create_token, decode_token, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


# -- Schemas ----------------------------------------------------------------

class SignupIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    name: str | None = None
    account_type: str = Field(default="individual", pattern="^(individual|company)$")
    company_name: str | None = None


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


class OrgOut(BaseModel):
    id: int
    name: str
    org_type: str

    class Config:
        from_attributes = True


class UserOut(BaseModel):
    id: int
    email: EmailStr
    name: str | None
    role: str
    must_change_password: bool
    organization: OrgOut | None
    # Primary User Voice Profile identity (set from Settings -> Profile).
    display_name: str | None = None
    job_title: str | None = None
    company_name: str | None = None
    department: str | None = None

    class Config:
        from_attributes = True


class TokenOut(BaseModel):
    token: str
    user: UserOut


_PREVIEW_EMAIL = "preview@preview.example.com"
_PREVIEW_PASSWORD_MARKER = "preview-login-disabled"


def is_preview_user(user: User) -> bool:
    """Identify the shared preview account even if its display name changes."""
    return user.password_hash == _PREVIEW_PASSWORD_MARKER


def preview_auth_enabled() -> bool:
    """The Replit preview workflow opts in; deployments never do.

    Keep this check environment-based so the public preview endpoint cannot
    enable itself from request headers or a client-side flag.
    """
    enabled = os.environ.get("PREVIEW_AUTH_BYPASS", "").strip().lower() in {"1", "true", "yes"}
    is_deployment = any(
        os.environ.get(name, "").strip().lower() not in {"", "0", "false", "no"}
        for name in ("REPLIT_DEPLOYMENT", "REPLIT_DEPLOYMENT_ID")
    )
    return enabled and not is_deployment


# -- Dependency -------------------------------------------------------------

def require_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = decode_token(token)
    except TokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if payload.get("preview") and not preview_auth_enabled():
        raise HTTPException(status_code=401, detail="Preview tokens are not valid outside preview mode")
    user = db.get(User, int(payload.get("sub", 0)))
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")
    if is_preview_user(user) and not preview_auth_enabled():
        raise HTTPException(status_code=401, detail="Preview accounts are not available outside preview mode")
    return user


def require_admin(user: User = Depends(require_user)) -> User:
    """Owner or admin only — used for member-management endpoints."""
    if user.role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Requires owner or admin role")
    return user


# -- Endpoints --------------------------------------------------------------

@router.post("/signup", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
def signup(payload: SignupIn, db: Session = Depends(get_db)) -> TokenOut:
    email = payload.email.lower().strip()
    if db.scalar(select(User).where(func.lower(User.email) == email)) is not None:
        raise HTTPException(status_code=409, detail="An account with this email already exists")

    if payload.account_type == "company":
        org_name = (payload.company_name or "").strip()
        if not org_name:
            raise HTTPException(status_code=400, detail="company_name is required for a company account")
        org = Organization(name=org_name, org_type="company")
    else:
        org = Organization(name=(payload.name or email.split("@")[0]), org_type="individual")

    db.add(org)
    db.flush()

    user = User(
        org_id=org.id,
        email=email,
        name=(payload.name or None),
        password_hash=hash_password(payload.password),
        role=ROLE_OWNER,  # whoever creates the org owns it
        must_change_password=False,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return TokenOut(token=create_token(user.id, user.email), user=UserOut.model_validate(user))


@router.post("/login", response_model=TokenOut)
def login(payload: LoginIn, db: Session = Depends(get_db)) -> TokenOut:
    email = payload.email.lower().strip()
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is disabled")
    user.last_login_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user)
    return TokenOut(token=create_token(user.id, user.email), user=UserOut.model_validate(user))


@router.get("/preview-enabled")
def preview_enabled() -> dict[str, bool]:
    """Tell the login page whether this runtime offers the preview workspace."""
    return {"enabled": preview_auth_enabled()}


@router.post("/preview", response_model=TokenOut)
def preview_login(db: Session = Depends(get_db)) -> TokenOut:
    """Issue a token for an isolated preview workspace, only in preview mode."""
    if not preview_auth_enabled():
        raise HTTPException(status_code=404, detail="Preview login is not available")

    user = db.scalar(select(User).where(func.lower(User.email) == _PREVIEW_EMAIL))
    if user is None:
        org = Organization(name="Preview Workspace", org_type="company")
        db.add(org)
        db.flush()
        user = User(
            org_id=org.id,
            email=_PREVIEW_EMAIL,
            name="Preview User",
            password_hash=_PREVIEW_PASSWORD_MARKER,
            role=ROLE_OWNER,
            must_change_password=False,
            is_active=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    elif user.password_hash != _PREVIEW_PASSWORD_MARKER or user.organization is None:
        # Never impersonate an account that happens to use the reserved email.
        raise HTTPException(status_code=409, detail="Preview account conflicts with an existing account")
    elif not user.is_active:
        raise HTTPException(status_code=403, detail="Preview account is disabled")

    return TokenOut(token=create_token(user.id, user.email, preview=True), user=UserOut.model_validate(user))


# -- Google Sign-In (login/signup) ------------------------------------------
# One button does both: an unrecognized Google email creates an account
# (individual workspace, owner role) exactly like /signup would, and a known
# one just logs in. The whole round-trip is a top-level browser redirect
# (not fetch), so the result — a session token or an error — is handed back
# to the login page via the URL fragment, which the page's own JS consumes
# and never reaches the server in any later request.

@router.get("/google/enabled")
def google_enabled() -> dict[str, bool]:
    """Tell the login/signup pages whether to show the Google button."""
    return {"enabled": get_settings().google_login_oauth_configured()}


@router.get("/google/start")
def google_start() -> RedirectResponse:
    try:
        url = google_login_oauth.authorize_url()
    except google_login_oauth.GoogleLoginError as exc:
        return RedirectResponse(url=f"/login#google_error={quote(str(exc))}")
    return RedirectResponse(url=url)


@router.get("/google/callback")
def google_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
) -> RedirectResponse:
    if error:
        return RedirectResponse(url=f"/login#google_error={quote('Google sign-in was cancelled.')}")
    if not code or not state:
        return RedirectResponse(url=f"/login#google_error={quote('Missing authorization code from Google.')}")

    try:
        profile = google_login_oauth.exchange_code(code, state)
    except google_login_oauth.GoogleLoginError as exc:
        return RedirectResponse(url=f"/login#google_error={quote(str(exc))}")

    email = profile["email"]
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    if user is None:
        org = Organization(name=(profile.get("name") or email.split("@")[0]), org_type="individual")
        db.add(org)
        db.flush()
        user = User(
            org_id=org.id,
            email=email,
            name=profile.get("name"),
            # No one can ever know this random secret, so the normal
            # password /login endpoint can never authenticate this account —
            # it's reachable only via Google from here on.
            password_hash=hash_password(secrets.token_urlsafe(32)),
            role=ROLE_OWNER,
            must_change_password=False,
            is_active=True,
        )
        db.add(user)
    elif is_preview_user(user):
        return RedirectResponse(url=f"/login#google_error={quote('That email address is reserved.')}")
    elif not user.is_active:
        return RedirectResponse(url=f"/login#google_error={quote('This account has been disabled.')}")

    user.last_login_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user)
    token = create_token(user.id, user.email)
    return RedirectResponse(url=f"/login#google_token={quote(token)}")


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(require_user)) -> UserOut:
    return UserOut.model_validate(user)


@router.post("/change-password", response_model=UserOut)
def change_password(
    payload: ChangePasswordIn,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
) -> UserOut:
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    user.password_hash = hash_password(payload.new_password)
    user.must_change_password = False
    db.commit()
    db.refresh(user)
    return UserOut.model_validate(user)
