from __future__ import annotations

import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import exists, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.auth import require_primary
from app.config import CLAIM_TYPES, UNCATEGORIZED, AppConfig
from app.database import get_db
from app.deps import get_effective_config
from app.models import LedgerPeriod, Transaction, TransferBuffer
from app.schemas import (
    ApproveRequest,
    BatchApproveOut,
    BatchApproveRequest,
    SplitRequest,
    TransactionListOut,
    TransactionOut,
    TransactionUpdate,
)
from app.services import ingestion, memory, rules, settlement, splits, transfers
from app.services.embeddings import EmbeddingClient
from app.services.periods import PERIOD_KEY_RE
from app.services.providers import get_embedder

router = APIRouter(prefix="/transactions", tags=["transactions"], dependencies=[Depends(require_primary)])

REVIEW_STATUSES = ("pending_review", "auto_approved", "manual_approved")
NOTE_MAX_LENGTH = 500


def _escape_like(value: str) -> str:
    """Escape LIKE wildcards so a search for ``%`` or ``_`` matches literally."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _get_or_404(db: Session, txn_id: uuid.UUID) -> Transaction:
    txn = db.get(Transaction, txn_id)
    if txn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "transaction not found")
    return txn


def _ensure_editable(db: Session, txn: Transaction) -> None:
    """Edits, approvals and deletions are refused once the period is closed."""
    if not txn.period_key:
        return
    period = db.get(LedgerPeriod, txn.period_key)
    if period is not None and period.is_closed:
        raise HTTPException(status.HTTP_409_CONFLICT, f"period {txn.period_key} is closed; reopen it first")


def _owner_for(txn: Transaction, config: AppConfig) -> str:
    acc = config.get_account(txn.account_id or "")
    if acc is not None:
        return acc.owner
    if txn.account is not None:
        return txn.account.owner_user_id
    return config.primary_user_id


def _delete_buffer_entries(db: Session, txn: Transaction) -> None:
    for entry in db.scalars(select(TransferBuffer).where(TransferBuffer.transaction_id == txn.id)).all():
        db.delete(entry)


def _unlink(db: Session, txn: Transaction) -> None:
    """Remove buffer rows and links for ``txn`` (both directions).

    A mirror leg written for an investment transfer only exists because of ``txn``,
    so it is deleted along with the link rather than left as an orphan that could be
    matched against an unrelated payment.
    """
    if txn.linked_transfer_id:
        other = db.get(Transaction, txn.linked_transfer_id)
        txn.linked_transfer_id = None
        db.flush()
        if other is not None and other.linked_transfer_id == txn.id:
            other.linked_transfer_id = None
            db.flush()
            if ingestion.is_mirror(other):
                _delete_buffer_entries(db, other)
                db.delete(other)
            else:
                other_entry = db.scalars(
                    select(TransferBuffer).where(TransferBuffer.transaction_id == other.id)
                ).first()
                if other_entry is not None:
                    other_entry.match_status = "unmatched"
                    other_entry.resolved_at = None
    _delete_buffer_entries(db, txn)
    db.flush()


def _split_guard(txn: Transaction, data: dict) -> None:
    """A split parent's money lives in its parts; a part is never a transfer.

    Classification edits on a split parent (category, subcategory, claim type) and any
    transfer flag on a parent or a part are refused with 409 so the ledger cannot end
    up with a parent and its parts disagreeing.
    """
    classification_edit = data.get("category") is not None or data.get("claim_type") is not None
    if txn.is_split and (classification_edit or "subcategory" in data):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "this transaction is split; edit its parts or remove the split first"
        )
    if (txn.is_split or txn.split_parent_id is not None) and data.get("is_internal_transfer"):
        raise HTTPException(status.HTTP_409_CONFLICT, "a split transaction cannot be an internal transfer")
    if txn.split_parent_id is not None and data.get("cleaned_merchant") is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "rename the merchant on the parent transaction")


def _flag_as_transfer(db: Session, txn: Transaction, config: AppConfig) -> None:
    """Register ``txn`` in the buffer and, for a configured transfer target, restore its mirror.

    Un-flagging deletes the mirror leg of an investment transfer (see :func:`_unlink`),
    so flagging the line again must write it back or the transfer stays unmatched and
    the investment position loses the deposit. The rule that names the target is
    looked up afresh from the description, exactly as ingestion did.
    """
    entry = transfers.register_transfer(db, txn)
    if txn.claim_type != "personal":
        txn.claim_type = "personal"
    rule = rules.match_rule(txn.raw_description, config)
    if rule is not None and rule.transfer_to_account:
        ingestion.create_mirror(db, config, txn, rule.transfer_to_account, txn.source_file or "", entry)
    transfers.match_pending(db, config)


def apply_update(db: Session, txn: Transaction, update: TransactionUpdate, config: AppConfig) -> Transaction:
    """Apply user corrections and recompute allocations (no status change).

    ``null`` clears ``subcategory`` and ``note``; for every other field ``null`` means
    "leave as is". A ``note`` is trimmed, ``""`` clears it too, and it may be at most
    ``NOTE_MAX_LENGTH`` characters; it is allowed on split parents and parts alike.
    A ``category`` must be one of ``config.categories`` (matched ignoring case and
    stored in its configured spelling) or ``Uncategorized``; ``subcategory`` is free text.
    """
    data = update.model_dump(exclude_unset=True)
    _split_guard(txn, data)
    if "note" in data:
        note = (data["note"] or "").strip()
        if len(note) > NOTE_MAX_LENGTH:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"note must be at most {NOTE_MAX_LENGTH} characters (got {len(note)})",
            )
        txn.note = note or None
    if data.get("category") is not None:
        cat = data["category"].strip()
        if not cat:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "category must not be empty")
        canonical = config.canonical_category(cat)
        if canonical is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, f"category {cat!r} is not in the configured taxonomy"
            )
        txn.category = canonical
    if "subcategory" in data:
        txn.subcategory = (data["subcategory"] or "").strip()[:128] or None
    if data.get("cleaned_merchant") is not None:
        merchant = data["cleaned_merchant"].strip()
        if not merchant:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "cleaned_merchant must not be empty")
        txn.cleaned_merchant = merchant[:255]
        splits.sync_parts_with_parent(db, txn)
    if data.get("claim_type") is not None:
        if data["claim_type"] not in CLAIM_TYPES:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid claim_type")
        txn.claim_type = data["claim_type"]
    if data.get("is_internal_transfer") is not None:
        wanted = bool(data["is_internal_transfer"])
        if wanted and not txn.is_internal_transfer:
            _flag_as_transfer(db, txn, config)
        elif not wanted and txn.is_internal_transfer:
            _unlink(db, txn)
            txn.is_internal_transfer = False
    alloc_p, alloc_s = settlement.allocate(Decimal(txn.amount), txn.claim_type, _owner_for(txn, config), config)
    txn.allocated_primary_amount = alloc_p
    txn.allocated_secondary_amount = alloc_s
    db.flush()
    return txn


def _remember(db: Session, txn: Transaction, embedder: EmbeddingClient) -> None:
    """Feed a confirmed classification back into merchant memory.

    Transfers are never merchants, and an ``Uncategorized`` answer is not knowledge:
    remembering it would silence the LLM for that merchant forever. A split (parent
    or part) is specific to one receipt, so nothing is learned from it either.
    """
    if txn.is_internal_transfer or txn.category == UNCATEGORIZED:
        return
    if txn.is_split or txn.split_parent_id is not None:
        return
    memory.remember(
        db,
        embedder,
        txn.raw_description,
        normalized_merchant=txn.cleaned_merchant,
        category=txn.category,
        claim_type=txn.claim_type,
    )


def _approve(
    db: Session, txn: Transaction, config: AppConfig, embedder: EmbeddingClient, remember: bool
) -> Transaction:
    txn.review_status = "manual_approved"
    txn.classification_source = "manual"
    txn.classification_confidence = Decimal("1.000")
    db.flush()
    if remember:
        _remember(db, txn, embedder)
    return txn


@router.get("", response_model=TransactionListOut)
def list_transactions(
    period: str | None = Query(default=None),
    status_: str | None = Query(default=None, alias="status"),
    account_id: str | None = Query(default=None),
    category: str | None = Query(default=None),
    q: str | None = Query(default=None, description="case-insensitive search in description / merchant / note"),
    include_transfers: bool = Query(default=True),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
) -> TransactionListOut:
    # Parts are embedded in their parent, never listed on their own.
    stmt = select(Transaction).where(Transaction.split_parent_id.is_(None)).options(selectinload(Transaction.parts))
    if period:
        if not PERIOD_KEY_RE.match(period):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "period must be YYYY-MM")
        stmt = stmt.where(Transaction.period_key == period)
    if status_:
        if status_ not in REVIEW_STATUSES:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid status")
        stmt = stmt.where(Transaction.review_status == status_)
    if account_id:
        stmt = stmt.where(Transaction.account_id == account_id)
    if category:
        part = Transaction.__table__.alias("part")
        in_parts = exists().where(part.c.split_parent_id == Transaction.id, part.c.category == category)
        stmt = stmt.where(or_(Transaction.category == category, in_parts))
    if q:
        pattern = f"%{_escape_like(q.strip())}%"
        part = Transaction.__table__.alias("note_part")
        part_note = exists().where(
            part.c.split_parent_id == Transaction.id, part.c.note.ilike(pattern, escape="\\")
        )
        stmt = stmt.where(
            or_(
                Transaction.raw_description.ilike(pattern, escape="\\"),
                Transaction.cleaned_merchant.ilike(pattern, escape="\\"),
                Transaction.note.ilike(pattern, escape="\\"),
                part_note,
            )
        )
    if not include_transfers:
        stmt = stmt.where(Transaction.is_internal_transfer.is_(False))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(
        stmt.order_by(Transaction.transaction_date.desc(), Transaction.created_at.desc(), Transaction.id)
        .limit(limit)
        .offset(offset)
    ).all()
    return TransactionListOut(items=[TransactionOut.model_validate(r) for r in rows], total=int(total))


@router.get("/{txn_id}", response_model=TransactionOut)
def get_transaction(txn_id: uuid.UUID, db: Session = Depends(get_db)) -> Transaction:
    return _get_or_404(db, txn_id)


@router.patch("/{txn_id}", response_model=TransactionOut)
def update_transaction(
    txn_id: uuid.UUID,
    body: TransactionUpdate,
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_effective_config),
    embedder: EmbeddingClient = Depends(get_embedder),
) -> Transaction:
    txn = _get_or_404(db, txn_id)
    _ensure_editable(db, txn)
    apply_update(db, txn, body, config)
    # Correcting an already-confirmed transaction is new evidence for the learning loop;
    # a note on its own says nothing about the classification.
    classification_fields = body.model_fields_set - {"note"}
    if txn.review_status != "pending_review" and classification_fields:
        _remember(db, txn, embedder)
    db.commit()
    db.refresh(txn)
    return txn


@router.post("/approve-batch", response_model=BatchApproveOut)
def approve_batch(
    body: BatchApproveRequest,
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_effective_config),
    embedder: EmbeddingClient = Depends(get_embedder),
) -> BatchApproveOut:
    rows = db.scalars(select(Transaction).where(Transaction.id.in_(body.ids))).all()
    found = {r.id for r in rows}
    missing = [str(i) for i in body.ids if i not in found]
    if missing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown transaction id(s): {', '.join(missing)}")
    for txn in rows:
        _ensure_editable(db, txn)
    for txn in rows:
        _approve(db, txn, config, embedder, body.remember)
    db.commit()
    for txn in rows:
        db.refresh(txn)
    return BatchApproveOut(approved=len(rows), items=[TransactionOut.model_validate(r) for r in rows])


@router.post("/{txn_id}/approve", response_model=TransactionOut)
def approve_transaction(
    txn_id: uuid.UUID,
    body: ApproveRequest | None = None,
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_effective_config),
    embedder: EmbeddingClient = Depends(get_embedder),
) -> Transaction:
    body = body or ApproveRequest()
    txn = _get_or_404(db, txn_id)
    _ensure_editable(db, txn)
    apply_update(db, txn, body, config)
    _approve(db, txn, config, embedder, body.remember)
    db.commit()
    db.refresh(txn)
    return txn


@router.delete("/{txn_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_transaction(txn_id: uuid.UUID, db: Session = Depends(get_db)) -> Response:
    txn = _get_or_404(db, txn_id)
    _ensure_editable(db, txn)
    if txn.split_parent_id is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "this row is part of a split; remove the split instead")
    _unlink(db, txn)
    db.delete(txn)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/{txn_id}/split", response_model=TransactionOut)
def split_transaction(
    txn_id: uuid.UUID,
    body: SplitRequest,
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_effective_config),
) -> Transaction:
    """Split a transaction into parts with their own category and claim type.

    Replaces any previous split. The parts must sum exactly to the amount and carry
    its sign; the parent and its parts become ``manual_approved`` (a split is a
    reviewed decision). Nothing is written to merchant memory.
    """
    txn = _get_or_404(db, txn_id)
    _ensure_editable(db, txn)
    try:
        splits.split_transaction(db, txn, body.parts, config)
    except splits.SplitRefused as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except splits.SplitError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    db.commit()
    db.refresh(txn)
    return txn


@router.delete("/{txn_id}/split", response_model=TransactionOut)
def unsplit_transaction(
    txn_id: uuid.UUID,
    db: Session = Depends(get_db),
) -> Transaction:
    """Remove a split: the parts are deleted and the parent is an ordinary row again."""
    txn = _get_or_404(db, txn_id)
    _ensure_editable(db, txn)
    try:
        splits.unsplit_transaction(db, txn)
    except splits.SplitRefused as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    db.commit()
    db.refresh(txn)
    return txn
