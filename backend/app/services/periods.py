"""Ledger period helpers (one period per calendar month, keyed ``YYYY-MM``)."""

from __future__ import annotations

import calendar
import re
from collections.abc import Iterable
from datetime import UTC, date, datetime

from sqlalchemy import exists, select, union
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
# What makes a month worth listing: an upload's provenance month alone does not.
_CONTENT_MODELS = (Transaction, PartnerClaim, SettlementEntry, SettlementSnapshot, AuditReport)

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


def months_between(first: str | None, last: str | None) -> list[str]:
    """Every period key from ``first`` to ``last`` inclusive; ``[]`` when either is missing or invalid."""
    if not first or not last or not PERIOD_KEY_RE.match(first) or not PERIOD_KEY_RE.match(last) or last < first:
        return []
    keys = [first]
    while keys[-1] < last:
        keys.append(next_period_key(keys[-1]))
    return keys


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


def delete_unreferenced(db: Session, period_keys: Iterable[str | None]) -> list[str]:
    """:func:`delete_if_unreferenced` for each key; returns the keys whose row went."""
    return sorted(key for key in {k for k in period_keys if k} if delete_if_unreferenced(db, key))


def keys_with_content(db: Session) -> set[str]:
    """Period keys that a transaction, claim, settlement entry, snapshot or audit report files under."""
    db.flush()
    stmt = union(*(select(model.period_key).where(model.period_key.is_not(None)) for model in _CONTENT_MODELS))
    return set(db.scalars(stmt))


def listed_periods(db: Session, today: date | None = None) -> list[LedgerPeriod]:
    """The periods a period selector offers, newest first.

    An open period with nothing in it (no transaction, claim, settlement entry,
    snapshot or audit report) is left out: a statement spanning two months can
    create the earlier month's row without a line landing in it. The current
    calendar month and every closed period are always listed.
    """
    current = period_key_for(today or date.today())
    content = keys_with_content(db)
    rows = db.scalars(select(LedgerPeriod).order_by(LedgerPeriod.period_key.desc())).all()
    return [p for p in rows if p.is_closed or p.period_key == current or p.period_key in content]
