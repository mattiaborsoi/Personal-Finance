from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.config import AppConfig
from app.database import get_db
from app.deps import get_effective_config
from app.schemas import InvestmentSummary, MetricsOut, TrendPoint, YearMetricsOut
from app.services import metrics
from app.services.periods import PERIOD_KEY_RE

router = APIRouter(prefix="/metrics", tags=["metrics"], dependencies=[Depends(require_primary)])


# NB: the literal routes must be declared before "/{period_key}".
@router.get("/trends", response_model=list[TrendPoint])
def get_trends(
    periods: int = Query(default=6, ge=1, le=36),
    ending: str | None = Query(default=None),
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_effective_config),
) -> list[TrendPoint]:
    if ending and not PERIOD_KEY_RE.match(ending):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "ending must be YYYY-MM")
    return metrics.trends(db, config, periods=periods, ending=ending)


@router.get("/year/{year}", response_model=YearMetricsOut)
def get_year(
    year: int, db: Session = Depends(get_db), config: AppConfig = Depends(get_effective_config)
) -> YearMetricsOut:
    if not 2000 <= year <= 2100:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "year must be between 2000 and 2100")
    return metrics.year_metrics(db, config, year)


@router.get("/investment", response_model=InvestmentSummary)
def get_investment(
    db: Session = Depends(get_db), config: AppConfig = Depends(get_effective_config)
) -> InvestmentSummary:
    return metrics.investment_summary(db, config)


@router.get("/{period_key}", response_model=MetricsOut)
def get_metrics(
    period_key: str, db: Session = Depends(get_db), config: AppConfig = Depends(get_effective_config)
) -> MetricsOut:
    if not PERIOD_KEY_RE.match(period_key or ""):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "period must be YYYY-MM")
    return metrics.period_metrics(db, config, period_key)
