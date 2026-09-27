"""Delete a statement upload and everything it brought into the ledger.

Every line :func:`~app.services.ingestion.ingest_statement` inserts carries the
upload's id in ``transactions.upload_id``, and so do the mirror legs written for its
investment transfers and the parts of any of its lines split later. Deleting the
upload deletes those rows with their transfer-buffer rows, unlinks any counterpart
that was matched to one of them (the counterpart's buffer row goes back to
``unmatched``, as un-flagging a transfer does; a mirror leg outside the upload goes
with its source), and removes the ``statement_uploads`` row so the same file can be
uploaded again. Periods are left in place.

Uploads recorded before lines were linked ("legacy" uploads) have no transaction
carrying their id. Their lines are found by ``source_file`` (the filename) among the
lines that carry no upload id. That is only safe when no other upload that could
have brought those lines in has the same filename: an upload whose lines carry its
id, or that inserted nothing (every line was a duplicate), cannot own them.
Otherwise the delete is refused with :class:`UploadNotDeletable`.

Every function flushes its own writes and never commits; the caller owns the
transaction.
"""

from __future__ import annotations

import uuid
from collections import Counter
from collections.abc import Iterable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import LedgerPeriod, StatementUpload, Transaction, TransferBuffer
from app.services import ingestion, transfers
from app.services.periods import PeriodClosedError

LEGACY_AMBIGUOUS = (
    "this upload was recorded before lines were linked to uploads; delete its transactions from the Transactions page"
)


class UploadNotDeletable(ValueError):
    """The upload's lines cannot be told apart from another upload's (HTTP 409)."""


def _unlinked_lines(filename: str):
    return select(Transaction).where(Transaction.upload_id.is_(None), Transaction.source_file == filename)


def _has_linked_lines():
    return select(Transaction.id).where(Transaction.upload_id == StatementUpload.id).exists()


def _possible_owner_count(db: Session, filename: str) -> int:
    """Uploads named ``filename`` that inserted lines of which none carries their id."""
    stmt = (
        select(func.count())
        .select_from(StatementUpload)
        .where(StatementUpload.filename == filename, StatementUpload.transaction_count > 0, ~_has_linked_lines())
    )
    return int(db.scalar(stmt) or 0)


def upload_transactions(db: Session, upload: StatementUpload) -> list[Transaction]:
    """Every transaction ``upload`` brought in: its lines, their mirror legs and split parts.

    Falls back to the unlinked lines named after the file for a legacy upload; raises
    :class:`UploadNotDeletable` when another legacy upload has the same filename,
    since those lines could belong to either.
    """
    db.flush()
    rows = list(db.scalars(select(Transaction).where(Transaction.upload_id == upload.id)))
    if not rows and (upload.transaction_count or 0) > 0:
        legacy = list(db.scalars(_unlinked_lines(upload.filename)))
        if legacy and _possible_owner_count(db, upload.filename) > 1:
            raise UploadNotDeletable(LEGACY_AMBIGUOUS)
        rows = legacy
    ids = {row.id for row in rows}
    if ids:
        # A part goes with its parent whatever it carries.
        rows.extend(
            db.scalars(select(Transaction).where(Transaction.split_parent_id.in_(ids), Transaction.id.not_in(ids)))
        )
    return rows


def deletable_flags(db: Session, uploads: Iterable[StatementUpload]) -> dict[uuid.UUID, bool]:
    """``{upload id: deletable}``: false only where :func:`delete_upload` would raise :class:`UploadNotDeletable`."""
    uploads = list(uploads)
    names = {u.filename for u in uploads}
    if not names:
        return {}
    db.flush()
    owners = db.execute(
        select(StatementUpload.id, StatementUpload.filename).where(
            StatementUpload.filename.in_(names), StatementUpload.transaction_count > 0, ~_has_linked_lines()
        )
    ).all()
    contested = {name for name, count in Counter(name for _, name in owners).items() if count > 1}
    blocked: set[uuid.UUID] = set()
    if contested:
        with_lines = set(
            db.scalars(
                select(Transaction.source_file)
                .where(Transaction.upload_id.is_(None), Transaction.source_file.in_(contested))
                .distinct()
            )
        )
        blocked = {upload_id for upload_id, name in owners if name in with_lines}
    return {u.id: u.id not in blocked for u in uploads}


def _closed_periods(db: Session, keys: set[str]) -> list[str]:
    if not keys:
        return []
    stmt = select(LedgerPeriod.period_key).where(LedgerPeriod.period_key.in_(keys), LedgerPeriod.is_closed.is_(True))
    return sorted(db.scalars(stmt))


def delete_upload(db: Session, upload: StatementUpload) -> int:
    """Delete ``upload`` and every transaction it brought in; return how many transactions went.

    Raises :class:`~app.services.periods.PeriodClosedError` (nothing changed) when any
    of those transactions sits in a closed period, and :class:`UploadNotDeletable`
    for a legacy upload whose filename another legacy upload shares.
    """
    rows = upload_transactions(db, upload)
    closed = _closed_periods(db, {row.period_key for row in rows if row.period_key})
    if closed:
        raise PeriodClosedError(f"period {closed[0]} is closed; reopen it first")

    ids = {row.id for row in rows}
    doomed = list(rows)
    if ids:
        # Counterparts outside the upload: a mirror leg only exists because of its
        # source and goes with it; anything else waits in the buffer again.
        others = db.scalars(
            select(Transaction).where(Transaction.linked_transfer_id.in_(ids), Transaction.id.not_in(ids))
        ).all()
        for other in others:
            other.linked_transfer_id = None
            if ingestion.is_mirror(other):
                doomed.append(other)
                continue
            entry = db.scalars(select(TransferBuffer).where(TransferBuffer.transaction_id == other.id)).first()
            if entry is not None:
                entry.match_status = transfers.UNMATCHED
                entry.resolved_at = None
        # Clear the links inside the set too, so no row is deleted while another still points at it.
        for row in doomed:
            row.linked_transfer_id = None
        db.flush()

        doomed_ids = [row.id for row in doomed]
        for entry in db.scalars(select(TransferBuffer).where(TransferBuffer.transaction_id.in_(doomed_ids))).all():
            db.delete(entry)
        db.flush()
        # Parts before their parents.
        for row in sorted(doomed, key=lambda r: r.split_parent_id is None):
            db.delete(row)
        db.flush()

    db.delete(upload)
    db.flush()
    return len(doomed)
