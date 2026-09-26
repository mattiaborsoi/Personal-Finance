from __future__ import annotations

import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import Role, require_any_role
from app.config import AppConfig
from app.database import get_db
from app.deps import get_config
from app.models import LedgerPeriod, PartnerClaim
from app.schemas import ClaimCreate, ClaimOut
from app.services import settlement
from app.services.periods import PERIOD_KEY_RE, PeriodClosedError, ensure_open, period_key_for

router = APIRouter(prefix="/claims", tags=["claims"])

# Claims are for money already spent; allow a day of slack for time zones.
FUTURE_TOLERANCE = timedelta(days=1)


@router.post("", response_model=ClaimOut, status_code=status.HTTP_201_CREATED)
def create_claim(
    body: ClaimCreate,
    role: Role = Depends(require_any_role),
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_config),
) -> PartnerClaim:
    if role == "secondary":
        paid_by = config.secondary_user_id
    else:
        paid_by = body.paid_by or config.secondary_user_id
    if paid_by not in config.user_ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "paid_by must be a configured user")
    if body.claim_date > date.today() + FUTURE_TOLERANCE:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "claim_date cannot be in the future")
    period_key = period_key_for(body.claim_date)
    try:
        ensure_open(db, period_key)
    except PeriodClosedError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    amount = settlement.quantize(body.amount, config.settlement.rounding_decimals)
    if amount <= 0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "amount must round to a positive value")
    primary_owes, secondary_owes = settlement.claim_shares(amount, body.claim_type, paid_by, config)
    claim = PartnerClaim(
        period_key=period_key,
        claim_date=body.claim_date,
        paid_by=paid_by,
        merchant=body.merchant.strip()[:255],
        description=(body.description or "").strip() or None,
        amount=amount,
        claim_type=body.claim_type,
        primary_owes=primary_owes,
        secondary_owes=secondary_owes,
        is_settled=False,
    )
    db.add(claim)
    db.commit()
    db.refresh(claim)
    return claim


@router.get("", response_model=list[ClaimOut], dependencies=[Depends(require_any_role)])
def list_claims(
    period: str | None = Query(default=None),
    settled: bool | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
) -> list[PartnerClaim]:
    stmt = select(PartnerClaim)
    if period:
        if not PERIOD_KEY_RE.match(period):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "period must be YYYY-MM")
        stmt = stmt.where(PartnerClaim.period_key == period)
    if settled is not None:
        stmt = stmt.where(PartnerClaim.is_settled.is_(settled))
    stmt = stmt.order_by(PartnerClaim.claim_date.desc(), PartnerClaim.created_at.desc()).limit(limit)
    return list(db.scalars(stmt).all())


@router.delete("/{claim_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_claim(
    claim_id: uuid.UUID,
    role: Role = Depends(require_any_role),
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_config),
) -> Response:
    claim = db.get(PartnerClaim, claim_id)
    if claim is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "claim not found")
    if role == "secondary" and (claim.paid_by != config.secondary_user_id or claim.is_settled):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "secondary users may only delete their own unsettled claims")
    period = db.get(LedgerPeriod, claim.period_key) if claim.period_key else None
    if period is not None and period.is_closed:
        raise HTTPException(status.HTTP_409_CONFLICT, f"period {claim.period_key} is closed; reopen it first")
    db.delete(claim)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
