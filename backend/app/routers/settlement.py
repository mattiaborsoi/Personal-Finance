from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require_any_role, require_primary
from app.config import AppConfig
from app.database import get_db
from app.deps import get_config
from app.models import PartnerClaim
from app.schemas import SettlementSnapshotOut, SettlementSummary
from app.services import settlement, settlement_snapshots
from app.services.periods import PERIOD_KEY_RE

router = APIRouter(prefix="/settlement", tags=["settlement"])


def _validate(period_key: str) -> str:
    if not PERIOD_KEY_RE.match(period_key or ""):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "period must be YYYY-MM")
    return period_key


@router.get("/{period_key}", response_model=SettlementSummary, dependencies=[Depends(require_any_role)])
def get_settlement(
    period_key: str, db: Session = Depends(get_db), config: AppConfig = Depends(get_config)
) -> SettlementSummary:
    _validate(period_key)
    summary = settlement.compute_settlement(db, period_key, config)
    # The engine keeps the exact ratios; six decimals is plenty for the API payload.
    summary.primary_ratio = settlement.quantize(summary.primary_ratio, 6)
    summary.secondary_ratio = settlement.quantize(summary.secondary_ratio, 6)
    summary.settlement_due_date = settlement_snapshots.settlement_due_date(period_key, config)
    snapshot = settlement_snapshots.latest_snapshot(db, period_key)
    if snapshot is not None:
        summary.snapshot = SettlementSnapshotOut.model_validate(snapshot)
    return summary


@router.post("/{period_key}/mark-settled", dependencies=[Depends(require_primary)])
def mark_settled(period_key: str, db: Session = Depends(get_db)) -> dict[str, int]:
    _validate(period_key)
    claims = db.scalars(
        select(PartnerClaim).where(PartnerClaim.period_key == period_key, PartnerClaim.is_settled.is_(False))
    ).all()
    for claim in claims:
        claim.is_settled = True
    db.commit()
    return {"settled_claims": len(claims)}
