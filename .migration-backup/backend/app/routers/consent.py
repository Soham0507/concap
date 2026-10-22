from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Consent, User, Visitor
from ..schemas import ConsentIn, ConsentOut
from .auth import require_user

router = APIRouter(prefix="/api/consent", tags=["consent"])


@router.post("", response_model=ConsentOut, status_code=status.HTTP_201_CREATED)
def record_consent(
    payload: ConsentIn,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> Consent:
    visitor = db.get(Visitor, payload.visitor_id)
    if visitor is None or visitor.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Visitor not found")

    if not payload.recording_consent or not payload.data_processing_consent:
        raise HTTPException(
            status_code=400,
            detail="Recording and data processing consent are required to proceed.",
        )

    consent = Consent(
        visitor_id=payload.visitor_id,
        recording_consent=payload.recording_consent,
        data_processing_consent=payload.data_processing_consent,
        marketing_consent=payload.marketing_consent,
        consent_text=payload.consent_text,
        consent_version=payload.consent_version,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    db.add(consent)
    db.commit()
    db.refresh(consent)
    return consent
