"""The running settlement balance, carried from month to month.

Every figure is in "secondary owes primary" terms: positive = the secondary owes the
primary, negative = the primary owes the secondary.

::

    carried_in(P)  = balance_out(previous calendar month)   (0 before the first month with data)
    balance_out(P) = carried_in(P) + net(P) - payments(P) + adjustments(P)
    checkpoint(P)  : balance_out(P) := the agreed amount; nothing earlier is looked at

* ``net(P)`` is :func:`app.services.settlement.compute_settlement`'s
  ``net_owed_by_secondary``, unchanged.
* ``payments(P)`` is the signed reduction of what the secondary owes from money
  changing hands in P: approved ``Transfers:Settlement`` lines filed under P (either
  direction, see :func:`ledger_payment_effect`) plus manual ``payment`` entries (paid
  by the secondary: +amount; paid by the primary: -amount).
* ``adjustments(P)`` is the signed sum of the month's ``adjustment`` entries.
* A checkpoint is absolute: ``balance_out`` of its month is the agreed amount whatever
  is approved or recorded in that month afterwards. ``drift`` reports how far the
  month's net has moved since the checkpoint was set.

The walk goes back calendar month by calendar month (months without a
``ledger_periods`` row count as zero) to the nearest checkpoint at or before P, or to
the first month holding any transaction, claim or settlement entry.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import APPROVED_STATUSES, AppConfig
from app.models import PartnerClaim, SettlementEntry, Transaction
from app.schemas import (
    LedgerPaymentLine,
    SettlementAnchorOut,
    SettlementBalance,
    SettlementCheckpointOut,
    SettlementSummary,
)
from app.services import settlement
from app.services.periods import next_period_key

ZERO = Decimal("0.00")


@dataclass
class _MonthEntries:
    payments_manual: Decimal = ZERO
    adjustments: Decimal = ZERO
    checkpoint: SettlementEntry | None = None
    rows: list[SettlementEntry] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# Payments through the ledger
# --------------------------------------------------------------------------- #


def ledger_payment_effect(txn: Transaction, config: AppConfig) -> Decimal:
    """Signed reduction of "secondary owes" for one ``Transfers:Settlement`` line.

    On an account the primary pays for, a credit is the secondary paying the primary
    (reduces the debt: ``+amount``) and a debit is the primary paying the secondary
    (increases it: ``amount`` is negative). On an account the secondary pays for the
    sign flips.
    """
    amount = settlement._as_decimal(txn.amount)
    payer = settlement._payer_for_transaction(txn, config)
    return amount if config.is_primary(payer) else -amount


def _settlement_lines(db: Session, period_key: str) -> list[Transaction]:
    stmt = (
        select(Transaction)
        .where(
            Transaction.period_key == period_key,
            Transaction.review_status.in_(APPROVED_STATUSES),
            Transaction.is_split.is_not(True),
            Transaction.category == settlement.SETTLEMENT_CATEGORY,
        )
        .order_by(Transaction.transaction_date, Transaction.created_at)
    )
    return list(db.scalars(stmt))


def ledger_payments(db: Session, period_key: str, config: AppConfig) -> list[LedgerPaymentLine]:
    """The approved ``Transfers:Settlement`` lines filed under the month, with their effect."""
    decimals = config.settlement.rounding_decimals
    return [
        LedgerPaymentLine(
            transaction_id=txn.id,
            date=txn.transaction_date,
            amount=settlement._as_decimal(txn.amount),
            account_id=txn.account_id,
            description=txn.cleaned_merchant or txn.raw_description,
            effect=settlement.quantize(ledger_payment_effect(txn, config), decimals),
        )
        for txn in _settlement_lines(db, period_key)
    ]


def ledger_payments_total(db: Session, period_key: str, config: AppConfig) -> Decimal:
    """``payments_ledger``: the signed total of :func:`ledger_payments`."""
    total = sum((ledger_payment_effect(txn, config) for txn in _settlement_lines(db, period_key)), ZERO)
    return settlement.quantize(total, config.settlement.rounding_decimals)


# --------------------------------------------------------------------------- #
# Entries
# --------------------------------------------------------------------------- #


def entries_for(db: Session, period_key: str) -> list[SettlementEntry]:
    stmt = (
        select(SettlementEntry)
        .where(SettlementEntry.period_key == period_key)
        .order_by(SettlementEntry.entry_date, SettlementEntry.created_at)
    )
    return list(db.scalars(stmt))


def manual_payment_effect(entry: SettlementEntry, config: AppConfig) -> Decimal:
    """A payment entry paid by the secondary reduces the debt, one paid by the primary increases it."""
    amount = settlement._as_decimal(entry.amount)
    return -amount if config.is_primary(entry.paid_by or "") else amount


def _group_entries(entries: list[SettlementEntry], config: AppConfig) -> dict[str, _MonthEntries]:
    months: dict[str, _MonthEntries] = {}
    for entry in entries:
        month = months.setdefault(entry.period_key, _MonthEntries())
        month.rows.append(entry)
        if entry.kind == "payment":
            month.payments_manual += manual_payment_effect(entry, config)
        elif entry.kind == "adjustment":
            month.adjustments += settlement._as_decimal(entry.amount)
        elif entry.kind == "checkpoint":
            month.checkpoint = entry
    return months


def _earliest_period(db: Session) -> str | None:
    candidates = [
        db.scalar(select(func.min(model.period_key))) for model in (Transaction, PartnerClaim, SettlementEntry)
    ]
    keys = [key for key in candidates if key]
    return min(keys) if keys else None


def _latest_checkpoint(db: Session, period_key: str) -> SettlementEntry | None:
    stmt = (
        select(SettlementEntry)
        .where(SettlementEntry.kind == "checkpoint", SettlementEntry.period_key <= period_key)
        .order_by(SettlementEntry.period_key.desc())
        .limit(1)
    )
    return db.scalars(stmt).first()


def _later_checkpoint_period(db: Session, period_key: str) -> str | None:
    """The first month after ``period_key`` that holds a checkpoint, if any."""
    stmt = select(func.min(SettlementEntry.period_key)).where(
        SettlementEntry.kind == "checkpoint", SettlementEntry.period_key > period_key
    )
    return db.scalar(stmt)


# --------------------------------------------------------------------------- #
# The running balance
# --------------------------------------------------------------------------- #


def compute_balance(
    db: Session,
    period_key: str,
    config: AppConfig,
    cache: dict[str, SettlementSummary] | None = None,
) -> SettlementBalance:
    """The running balance for ``period_key`` (see the module docstring).

    ``cache`` maps period keys to :func:`settlement.compute_settlement` results already
    computed in this request; it is filled as the walk goes.
    """
    db.flush()
    decimals = config.settlement.rounding_decimals
    cache = cache if cache is not None else {}

    def summary_for(key: str) -> SettlementSummary:
        if key not in cache:
            cache[key] = settlement.compute_settlement(db, key, config)
        return cache[key]

    anchor = _latest_checkpoint(db, period_key)
    earliest = _earliest_period(db)
    start = anchor.period_key if anchor is not None else earliest
    if start is None or start > period_key:
        start = period_key

    entries = db.scalars(
        select(SettlementEntry).where(SettlementEntry.period_key >= start, SettlementEntry.period_key <= period_key)
    ).all()
    months = _group_entries(list(entries), config)

    running = ZERO
    key = start
    while True:
        month = months.get(key, _MonthEntries())
        summary = summary_for(key)
        net = summary.net_owed_by_secondary
        payments_ledger = summary.settlement_payments_received
        carried_in = running
        if month.checkpoint is not None:
            carried_in = ZERO
            balance_out = settlement._as_decimal(month.checkpoint.amount)
        else:
            balance_out = carried_in + net - payments_ledger - month.payments_manual + month.adjustments
        if key == period_key:
            break
        running = balance_out
        key = next_period_key(key)

    checkpoint_out = None
    if month.checkpoint is not None:
        cp = month.checkpoint
        net_at = settlement._as_decimal(cp.net_at_checkpoint) if cp.net_at_checkpoint is not None else None
        drift = net - net_at if net_at is not None else ZERO
        checkpoint_out = SettlementCheckpointOut(
            id=cp.id,
            amount=settlement.quantize(settlement._as_decimal(cp.amount), decimals),
            entry_date=cp.entry_date,
            note=cp.note,
            net_at_checkpoint=net_at,
            drift=settlement.quantize(drift, decimals),
            drifted=drift != 0,
        )

    later = _later_checkpoint_period(db, period_key)
    anchored_on = None
    if anchor is not None and anchor.period_key < period_key:
        anchored_on = SettlementAnchorOut(
            period_key=anchor.period_key,
            entry_date=anchor.entry_date,
            amount=settlement.quantize(settlement._as_decimal(anchor.amount), decimals),
        )
    return SettlementBalance(
        carried_in=settlement.quantize(carried_in, decimals),
        net=settlement.quantize(net, decimals),
        payments_ledger=settlement.quantize(payments_ledger, decimals),
        payments_manual=settlement.quantize(month.payments_manual, decimals),
        adjustments=settlement.quantize(month.adjustments, decimals),
        balance_out=settlement.quantize(balance_out, decimals),
        from_period=start,
        checkpoint=checkpoint_out,
        before_checkpoint=later is not None,
        later_checkpoint_period=later,
        anchored_on=anchored_on,
    )
