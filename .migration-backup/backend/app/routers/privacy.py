"""Consent & Privacy Profile endpoint.

Returns the requesting user's organization-level Consent & Privacy Profile:
the privacy score, consent statistics, earned badges, trust rating, trend
series, and encouragement notifications. Computed live from each conversation's
stored consent analysis (see services/privacy_score.py)."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User
from ..services.privacy_score import compute_privacy_profile
from .auth import require_user

router = APIRouter(prefix="/api/privacy", tags=["privacy"])


@router.get("/profile")
def privacy_profile(
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    return compute_privacy_profile(db, user.org_id)
