"""Cross-ledger reconciliation & timing buffer (transfer matching engine).

Algorithm (blueprint §4):

1. A transaction whose description matches ``transfers.payment_patterns`` (or a
   deterministic rule with ``is_internal_transfer``) is flagged
   ``is_internal_transfer = TRUE`` and inserted into ``transfer_buffer`` as
   ``unmatched``.
2. The engine looks for an inverse transaction on a *different* account: amount
   within ``amount_tolerance`` of the negated amount, date within
   ``match_window_days`` calendar days, itself unmatched.
3. On success both transactions get ``linked_transfer_id`` pointing at each other,
   both buffer rows become ``matched`` with ``resolved_at`` set.
4. Unmatched rows persist across period closes and never block settlement.

Every function receives a :class:`~sqlalchemy.orm.Session`, flushes its own writes
and never commits; the caller owns the transaction. Sessions may run with
``autoflush=False``, so reads here flush first.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import AppConfig
from app.models import Transaction, TransferBuffer
from app.services.rules import match_rule

UNMATCHED = "unmatched"
MATCHED = "matched"
IGNORED = "ignored"

_CENT = Decimal("0.01")


def is_transfer_description(raw_description: str, config: AppConfig, amount: Decimal | None = None) -> bool:
    """True when the description looks like a card payment / internal transfer.

    Either a ``transfers.payment_patterns`` regex matches, or the first matching
    deterministic rule carries ``is_internal_transfer`` (a ``transfer_to_account``
    implies it). ``amount`` lets a rule with an amount range match; without it
    such a rule is skipped.
    """
    raw = raw_description or ""
    if config.transfers.is_payment(raw):
        return True
    rule = match_rule(raw, config, amount)
    return rule is not None and rule.is_internal_transfer


def register_transfer(db: Session, txn: Transaction) -> TransferBuffer:
    """Mark ``txn`` as an internal transfer and add it to the buffer (idempotent).

    The buffer row copies ``amount``, ``account_id`` and ``transaction_date`` from
    the transaction. A second call for the same transaction returns the existing
    row (``ux_transfer_buffer_transaction`` guarantees at most one per transaction).
    """
    txn.is_internal_transfer = True
    if txn.id is None:
        db.add(txn)
    db.flush()

    existing = db.scalars(select(TransferBuffer).where(TransferBuffer.transaction_id == txn.id)).first()
    if existing is not None:
        return existing

    entry = TransferBuffer(
        transaction_id=txn.id,
        account_id=txn.account_id,
        amount=Decimal(txn.amount).quantize(_CENT, rounding=ROUND_HALF_UP),
        transaction_date=txn.transaction_date,
        match_status=UNMATCHED,
    )
    db.add(entry)
    db.flush()
    return entry


def find_match(db: Session, entry: TransferBuffer, config: AppConfig) -> TransferBuffer | None:
    """Best unmatched inverse counterpart for ``entry`` (closest date wins) or None.

    Candidates are unmatched buffer rows on a different account whose amount lies
    within ``amount_tolerance`` of ``-entry.amount`` and whose date lies within
    ``match_window_days`` (inclusive, either side) of the entry's date, and whose
    transaction is not already linked. Ties on date distance are broken by the
    earlier transaction date, then the lowest buffer id, so the choice is
    deterministic for a given database state.
    """
    db.flush()
    if entry.match_status != UNMATCHED or entry.transaction_id is None or entry.amount == 0:
        return None
    if entry.transaction is not None and entry.transaction.linked_transfer_id is not None:
        return None

    target = -entry.amount
    tolerance = config.transfers.amount_tolerance
    window = timedelta(days=config.transfers.match_window_days)
    stmt = (
        select(TransferBuffer)
        .join(Transaction, TransferBuffer.transaction_id == Transaction.id)
        .where(
            TransferBuffer.id != entry.id,
            TransferBuffer.match_status == UNMATCHED,
            TransferBuffer.account_id != entry.account_id,
            TransferBuffer.amount.between(target - tolerance, target + tolerance),
            TransferBuffer.transaction_date.between(entry.transaction_date - window, entry.transaction_date + window),
            Transaction.linked_transfer_id.is_(None),
        )
    )
    candidates = list(db.scalars(stmt))
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda c: (abs((c.transaction_date - entry.transaction_date).days), c.transaction_date, c.id),
    )


def link(db: Session, a: TransferBuffer, b: TransferBuffer) -> None:
    """Link two buffer entries and their transactions as a matched pair.

    Both transactions get ``linked_transfer_id`` pointing at each other (and
    ``is_internal_transfer`` set), both buffer rows become ``matched`` with the same
    UTC ``resolved_at``. No tolerance or window checks are made here; callers
    validate.
    """
    if a.id == b.id:
        raise ValueError("cannot link a buffer entry to itself")
    txn_a = _transaction_for(db, a)
    txn_b = _transaction_for(db, b)
    if txn_a.id == txn_b.id:
        raise ValueError("both buffer entries point at the same transaction")

    now = datetime.now(UTC)
    txn_a.linked_transfer_id = txn_b.id
    txn_b.linked_transfer_id = txn_a.id
    txn_a.is_internal_transfer = True
    txn_b.is_internal_transfer = True
    for entry in (a, b):
        entry.match_status = MATCHED
        entry.resolved_at = now
    db.flush()


def match_pending(db: Session, config: AppConfig) -> int:
    """Try to match every unmatched buffer entry; return the number of pairs linked.

    Entries are visited oldest first; an entry consumed as a counterpart earlier in
    the run is skipped. Safe to call repeatedly (a second run links nothing new).
    """
    db.flush()
    linked = 0
    for entry in unmatched(db):
        if entry.match_status != UNMATCHED:
            continue  # consumed as a counterpart earlier in this run
        counterpart = find_match(db, entry, config)
        if counterpart is None:
            continue
        link(db, entry, counterpart)
        linked += 1
    return linked


def ignore(db: Session, buffer_id: uuid.UUID) -> TransferBuffer:
    """Mark a buffer entry as ``ignored`` (it stays an internal transfer).

    Raises ``KeyError`` when no entry has that id and ``ValueError`` when the entry
    is already ``matched`` (unlink is not supported). Ignoring twice is a no-op.
    """
    entry = db.get(TransferBuffer, buffer_id)
    if entry is None:
        raise KeyError(str(buffer_id))
    if entry.match_status == MATCHED:
        raise ValueError(f"buffer entry {buffer_id} is already matched")
    if entry.match_status != IGNORED:
        entry.match_status = IGNORED
        entry.resolved_at = datetime.now(UTC)
        db.flush()
    return entry


def unmatched(db: Session) -> list[TransferBuffer]:
    """All entries still waiting for a counterpart, oldest first (by transaction date, then id)."""
    db.flush()
    stmt = (
        select(TransferBuffer)
        .where(TransferBuffer.match_status == UNMATCHED)
        .order_by(TransferBuffer.transaction_date, TransferBuffer.id)
    )
    return list(db.scalars(stmt))


def manual_link(db: Session, buffer_id_a: uuid.UUID, buffer_id_b: uuid.UUID) -> tuple[TransferBuffer, TransferBuffer]:
    """Link two buffer entries by hand, bypassing the amount/date heuristics.

    Both entries must exist (``KeyError`` otherwise), be distinct, ``unmatched``, on
    different accounts and point at transactions that are not already linked
    (``ValueError`` otherwise). Returns the two entries, now ``matched``.
    """
    if buffer_id_a == buffer_id_b:
        raise ValueError("cannot link a buffer entry to itself")
    a = db.get(TransferBuffer, buffer_id_a)
    if a is None:
        raise KeyError(str(buffer_id_a))
    b = db.get(TransferBuffer, buffer_id_b)
    if b is None:
        raise KeyError(str(buffer_id_b))

    for entry in (a, b):
        if entry.match_status != UNMATCHED:
            raise ValueError(f"buffer entry {entry.id} is {entry.match_status}, not unmatched")
        if _transaction_for(db, entry).linked_transfer_id is not None:
            raise ValueError(f"transaction {entry.transaction_id} is already linked")
    if a.account_id == b.account_id:
        raise ValueError("both buffer entries are on the same account")

    link(db, a, b)
    return a, b


def _transaction_for(db: Session, entry: TransferBuffer) -> Transaction:
    txn = entry.transaction if entry.transaction_id is not None else None
    if txn is None:
        raise ValueError(f"buffer entry {entry.id} has no transaction")
    return txn
