"""Settlement ledger persistence: snapshot the month's reconciliation debt on close.

The live figure (``settlement.compute_settlement``) is always recomputed from the
ledger; closing a period additionally records it in ``settlement_snapshots`` so the
household has a durable record of what was owed at the time of settling, even if
transactions are edited later.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from sqlalchemy.orm import Session

from app.config import AppConfig
from app.models import SettlementSnapshot
from app.services import settlement
from app.services.periods import period_bounds


def settlement_due_date(period_key: str, config: AppConfig) -> date:
    """The configured settlement day in the month after ``period_key``."""
    _, end = period_bounds(period_key)
    first_of_next = end + timedelta(days=1)
    return first_of_next.replace(day=config.settlement.settlement_day_of_month)


def snapshot_settlement(db: Session, period_key: str, config: AppConfig) -> SettlementSnapshot:
    """Compute the live settlement and upsert it as the period's snapshot."""
    summary = settlement.compute_settlement(db, period_key, config)
    row = db.get(SettlementSnapshot, period_key)
    if row is None:
        row = SettlementSnapshot(period_key=period_key)
        db.add(row)
    row.net_owed_by_secondary = summary.net_owed_by_secondary
    row.secondary_share_of_primary_paid_shared = summary.secondary_share_of_primary_paid_shared
    row.primary_share_of_secondary_paid_shared = summary.primary_share_of_secondary_paid_shared
    row.secondary_personal_on_primary_paid = summary.secondary_personal_on_primary_paid
    row.primary_personal_on_secondary_paid = summary.primary_personal_on_secondary_paid
    row.settlement_payments_received = summary.settlement_payments_received
    row.line_count = len(summary.lines)
    row.snapshot_at = datetime.now(UTC)
    db.flush()
    return row


def latest_snapshot(db: Session, period_key: str) -> SettlementSnapshot | None:
    return db.get(SettlementSnapshot, period_key)
