from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.config import AppConfig
from app.database import get_db
from app.deps import get_config
from app.models import LedgerPeriod, Transaction
from app.schemas import PeriodOut
from app.services import auditor, settlement_snapshots
from app.services.llm import LLMClient
from app.services.periods import PERIOD_KEY_RE, close_period, get_or_create_period, reopen_period
from app.services.providers import get_llm

router = APIRouter(prefix="/periods", tags=["periods"], dependencies=[Depends(require_primary)])


def _validate_key(period_key: str) -> str:
    if not PERIOD_KEY_RE.match(period_key or ""):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "period must be YYYY-MM")
    return period_key


def _counts(db: Session) -> dict[str, tuple[int, int]]:
    rows = db.execute(
        select(
            Transaction.period_key,
            func.count(Transaction.id),
            func.count(Transaction.id).filter(Transaction.review_status == "pending_review"),
        )
        .where(Transaction.split_parent_id.is_(None))  # parts are counted through their parent
        .group_by(Transaction.period_key)
    ).all()
    return {key: (int(total), int(pending)) for key, total, pending in rows}


def _to_out(period: LedgerPeriod, counts: dict[str, tuple[int, int]]) -> PeriodOut:
    total, pending = counts.get(period.period_key, (0, 0))
    return PeriodOut(
        period_key=period.period_key,
        start_date=period.start_date,
        end_date=period.end_date,
        is_closed=bool(period.is_closed),
        closed_at=period.closed_at,
        transaction_count=total,
        pending_review_count=pending,
    )


@router.get("", response_model=list[PeriodOut])
def list_periods(db: Session = Depends(get_db)) -> list[PeriodOut]:
    counts = _counts(db)
    periods = db.scalars(select(LedgerPeriod).order_by(LedgerPeriod.period_key.desc())).all()
    return [_to_out(p, counts) for p in periods]


@router.post("/{period_key}/close", response_model=PeriodOut)
def close(
    period_key: str,
    force: bool = Query(default=False),
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_config),
    llm: LLMClient = Depends(get_llm),
) -> PeriodOut:
    _validate_key(period_key)
    period = get_or_create_period(db, period_key)
    if period.is_closed:
        raise HTTPException(status.HTTP_409_CONFLICT, f"period {period_key} is already closed; reopen it first")
    counts = _counts(db)
    _, pending = counts.get(period_key, (0, 0))
    if pending and not force:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{pending} transaction(s) are still pending review; approve them or pass force=true",
        )
    auditor.run_audit(db, config, llm, period_key)
    settlement_snapshots.snapshot_settlement(db, period_key, config)
    period = close_period(db, period_key)
    db.commit()
    return _to_out(period, counts)


@router.post("/{period_key}/reopen", response_model=PeriodOut)
def reopen(period_key: str, db: Session = Depends(get_db)) -> PeriodOut:
    _validate_key(period_key)
    period = reopen_period(db, period_key)
    db.commit()
    return _to_out(period, _counts(db))
