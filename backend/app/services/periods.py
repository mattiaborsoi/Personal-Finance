"""Ledger period helpers (one period per calendar month, keyed ``YYYY-MM``)."""

from __future__ import annotations

import calendar
import re
from datetime import UTC, date, datetime

from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from app.models import (
    AuditReport,
    LedgerPeriod,
    PartnerClaim,
    SettlementEntry,
    SettlementSnapshot,
    StatementUpload,
    Transaction,
)

# Every table with a foreign key to ``ledger_periods`` (keep in step with schema.sql).
_REFERENCING_MODELS = (Transaction, PartnerClaim, StatementUpload, AuditReport, SettlementSnapshot, SettlementEntry)

PERIOD_KEY_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


class PeriodClosedError(ValueError):
    """Raised when writing into a period that has been closed."""


def period_key_for(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def period_bounds(period_key: str) -> tuple[date, date]:
    if not PERIOD_KEY_RE.match(period_key or ""):
        raise ValueError(f"invalid period key {period_key!r}; expected YYYY-MM")
    year, month = int(period_key[:4]), int(period_key[5:7])
    last = calendar.monthrange(year, month)[1]
    return date(year, month, 1), date(year, month, last)


def previous_period_key(period_key: str, steps: int = 1) -> str:
    start, _ = period_bounds(period_key)
    year, month = start.year, start.month
    for _ in range(steps):
        month -= 1
        if month == 0:
            month = 12
            year -= 1
    return f"{year:04d}-{month:02d}"


def next_period_key(period_key: str) -> str:
    start, _ = period_bounds(period_key)
    if start.month == 12:
        return f"{start.year + 1:04d}-01"
    return f"{start.year:04d}-{start.month + 1:02d}"


def get_or_create_period(db: Session, period_key: str) -> LedgerPeriod:
    period = db.get(LedgerPeriod, period_key)
    if period is None:
        start, end = period_bounds(period_key)
        period = LedgerPeriod(period_key=period_key, start_date=start, end_date=end, is_closed=False)
        db.add(period)
        db.flush()
    return period


def ensure_open(db: Session, period_key: str) -> LedgerPeriod:
    period = get_or_create_period(db, period_key)
    if period.is_closed:
        raise PeriodClosedError(f"period {period_key} is closed")
    return period


def close_period(db: Session, period_key: str) -> LedgerPeriod:
    period = get_or_create_period(db, period_key)
    period.is_closed = True
    period.closed_at = datetime.now(UTC)
    db.flush()
    return period


def reopen_period(db: Session, period_key: str) -> LedgerPeriod:
    period = get_or_create_period(db, period_key)
    period.is_closed = False
    period.closed_at = None
    db.flush()
    return period


def is_referenced(db: Session, period_key: str) -> bool:
    """True when a transaction, claim, upload, audit report, snapshot or settlement entry files under it."""
    db.flush()
    return any(
        db.scalar(select(exists().where(model.period_key == period_key))) for model in _REFERENCING_MODELS
    )


def delete_if_unreferenced(db: Session, period_key: str) -> bool:
    """Remove the ``ledger_periods`` row when it is open and nothing refers to it any more.

    A period is created on the fly by the first claim or upload dated in it, so a
    claim typed with the wrong month would otherwise leave an empty month behind in
    every period list. A closed period is never removed (it records a settlement).
    Returns ``True`` when the row was deleted.
    """
    period = db.get(LedgerPeriod, period_key)
    if period is None or period.is_closed or is_referenced(db, period_key):
        return False
    db.delete(period)
    db.flush()
    return True
