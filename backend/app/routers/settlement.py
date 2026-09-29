from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require_any_role, require_primary
from app.config import AppConfig
from app.database import get_db
from app.deps import get_effective_config
from app.models import LedgerPeriod, PartnerClaim, SettlementEntry
from app.schemas import (
    SettlementEntryCreate,
    SettlementEntryOut,
    SettlementSnapshotOut,
    SettlementSummary,
)
from app.services import balance, settlement, settlement_snapshots
from app.services.periods import (
    PERIOD_KEY_RE,
    delete_if_unreferenced,
    get_or_create_period,
    period_key_for,
)

router = APIRouter(prefix="/settlement", tags=["settlement"])


def _validate(period_key: str) -> str:
    if not PERIOD_KEY_RE.match(period_key or ""):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "period must be YYYY-MM")
    return period_key


def _mark_claims_settled(db: Session, period_key: str) -> int:
    """Flag every unsettled partner claim of the month as settled; returns how many."""
    claims = db.scalars(
        select(PartnerClaim).where(PartnerClaim.period_key == period_key, PartnerClaim.is_settled.is_(False))
    ).all()
    for claim in claims:
        claim.is_settled = True
    return len(claims)


@router.get("/{period_key}", response_model=SettlementSummary, dependencies=[Depends(require_any_role)])
def get_settlement(
    period_key: str, db: Session = Depends(get_db), config: AppConfig = Depends(get_effective_config)
) -> SettlementSummary:
    _validate(period_key)
    summary = settlement.compute_settlement(db, period_key, config)
    summary.balance = balance.compute_balance(db, period_key, config, cache={period_key: summary})
    summary.entries = [SettlementEntryOut.model_validate(e) for e in balance.entries_for(db, period_key)]
    summary.ledger_payments = balance.ledger_payments(db, period_key, config)
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
    settled = _mark_claims_settled(db, period_key)
    db.commit()
    return {"settled_claims": settled}


def _closed_conflict(period_key: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, f"period {period_key} is closed; reopen it first")


@router.post(
    "/entries",
    response_model=SettlementEntryOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_primary)],
)
def create_entry(
    body: SettlementEntryCreate,
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_effective_config),
) -> SettlementEntry:
    decimals = config.settlement.rounding_decimals
    amount = settlement.quantize(body.amount, decimals)
    user_ids = (config.primary_user_id, config.secondary_user_id)
    if body.kind == "payment":
        if body.paid_by not in user_ids:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"paid_by must be one of {', '.join(user_ids)}")
        if amount <= 0:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "a payment amount must be greater than 0")
    elif body.paid_by is not None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "paid_by is only recorded on payments")
    if body.kind == "adjustment" and amount == 0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "an adjustment amount must not be 0")

    period_key = period_key_for(body.entry_date)
    period = get_or_create_period(db, period_key)
    if period.is_closed and body.kind != "checkpoint":
        raise _closed_conflict(period_key)

    note = (body.note or "").strip() or None
    entry: SettlementEntry | None = None
    if body.kind == "checkpoint":
        entry = db.scalars(
            select(SettlementEntry).where(
                SettlementEntry.period_key == period_key, SettlementEntry.kind == "checkpoint"
            )
        ).first()
    if entry is None:
        entry = SettlementEntry(period_key=period_key, kind=body.kind)
        db.add(entry)
    else:
        entry.created_at = datetime.now(UTC)
    entry.entry_date = body.entry_date
    entry.amount = amount
    entry.paid_by = body.paid_by if body.kind == "payment" else None
    entry.note = note
    entry.created_by = config.primary_user_id
    if body.kind == "checkpoint":
        entry.net_at_checkpoint = settlement.compute_settlement(db, period_key, config).net_owed_by_secondary
    if body.kind == "payment":
        _mark_claims_settled(db, period_key)
    db.commit()
    db.refresh(entry)
    return entry


@router.delete(
    "/entries/{entry_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_primary)]
)
def delete_entry(entry_id: uuid.UUID, db: Session = Depends(get_db)) -> Response:
    entry = db.get(SettlementEntry, entry_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "settlement entry not found")
    period_key = entry.period_key
    period = db.get(LedgerPeriod, period_key)
    if entry.kind != "checkpoint" and period is not None and period.is_closed:
        raise _closed_conflict(period_key)
    db.delete(entry)
    db.flush()
    delete_if_unreferenced(db, period_key)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
