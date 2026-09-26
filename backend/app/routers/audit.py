from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.config import AppConfig
from app.database import get_db
from app.deps import get_effective_config
from app.schemas import AuditReportOut
from app.services import auditor
from app.services.llm import LLMClient
from app.services.periods import PERIOD_KEY_RE, get_or_create_period
from app.services.providers import get_audit_llm

router = APIRouter(prefix="/audit", tags=["audit"], dependencies=[Depends(require_primary)])


def _validate(period_key: str) -> str:
    if not PERIOD_KEY_RE.match(period_key or ""):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "period must be YYYY-MM")
    return period_key


@router.post("/{period_key}/run", response_model=AuditReportOut)
def run_audit(
    period_key: str,
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_effective_config),
    llm: LLMClient = Depends(get_audit_llm),
) -> AuditReportOut:
    _validate(period_key)
    get_or_create_period(db, period_key)
    report = auditor.run_audit(db, config, llm, period_key)
    db.commit()
    return report


@router.get("/{period_key}", response_model=AuditReportOut | None)
def get_audit(period_key: str, db: Session = Depends(get_db)) -> AuditReportOut | None:
    """The latest report for the period, or ``null`` (still 200) when it has never been audited.

    "Never run" is the normal state of every period until it is closed, so it is not
    an error: the dashboard asks on every load and treats ``null`` as "not run yet".
    """
    _validate(period_key)
    return auditor.latest_report(db, period_key)
