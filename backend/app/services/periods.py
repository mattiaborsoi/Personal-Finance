"""Ledger period helpers (one period per calendar month, keyed ``YYYY-MM``)."""

from __future__ import annotations

import calendar
import re
from datetime import UTC, date, datetime

from sqlalchemy.orm import Session

from app.models import LedgerPeriod

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
