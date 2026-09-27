"""Split one transaction into several parts with their own category and claim type.

A £10 supermarket receipt can be £6 of groceries shared by income plus £4 of a
personal item. The ledger records this as:

* the original row, flagged ``is_split``: it keeps its amount, merchant, provenance
  and fingerprint (so a re-upload still dedupes) but carries no money of its own -
  settlement, macro/micro metrics and the auditor skip it;
* one ``transactions`` row per part with ``split_parent_id`` pointing at the parent
  and ``split_index`` for ordering. A part copies the parent's period, account,
  date, merchant, description and upload and has its own ``amount``, ``category``,
  ``claim_type`` and allocations. Parts have no fingerprint and never enter the
  transfer buffer.

Invariants enforced here: at least two parts, every part non-zero and signed like
the parent, every category in the configured taxonomy (matched ignoring case and
stored in its configured spelling) and the parts sum exactly to the parent amount.
Splitting is a human decision, so the parent and its parts are recorded as
``manual_approved``. A split is never written to merchant memory (the parent's
classification was not confirmed as a whole) and cannot be applied to an internal
transfer, to a row in a closed period or to a part.

The liquidity view and the transactions list are the two places that *keep* the
parent and drop the parts: the parent is the real cash movement, and the list
embeds the parts in their parent.
"""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy.orm import Session

from app.config import CLAIM_TYPES, AppConfig
from app.models import Transaction
from app.schemas import SplitPartIn
from app.services import settlement

MIN_PARTS = 2
MAX_PARTS = 20


class SplitError(ValueError):
    """The requested parts are invalid for this transaction (HTTP 422)."""


class SplitRefused(ValueError):
    """The transaction cannot be split at all (HTTP 409)."""


def _owner_for(txn: Transaction, config: AppConfig) -> str:
    acc = config.get_account(txn.account_id or "")
    if acc is not None:
        return acc.owner
    if txn.account is not None:
        return txn.account.owner_user_id
    return config.primary_user_id


def validate_parts(txn: Transaction, parts: list[SplitPartIn], config: AppConfig) -> list[SplitPartIn]:
    """Check the invariants and return the parts quantised to the ledger's decimals.

    Raises :class:`SplitError` with a message suitable for the API response.
    """
    decimals = config.settlement.rounding_decimals
    if not MIN_PARTS <= len(parts) <= MAX_PARTS:
        raise SplitError(f"a split needs between {MIN_PARTS} and {MAX_PARTS} parts")
    total = Decimal(txn.amount)
    if total == 0:
        raise SplitError("a zero-amount transaction cannot be split")
    cleaned: list[SplitPartIn] = []
    running = Decimal(0)
    for index, part in enumerate(parts, start=1):
        amount = settlement.quantize(Decimal(part.amount), decimals)
        if amount == 0:
            raise SplitError(f"part {index} has a zero amount")
        if (amount < 0) != (total < 0):
            raise SplitError(f"part {index} must have the same sign as the transaction ({total})")
        if abs(amount) > abs(total):
            raise SplitError(f"part {index} ({amount}) is larger than the transaction ({total})")
        if part.claim_type not in CLAIM_TYPES:
            raise SplitError(f"part {index} has an unknown claim_type")
        category = part.category.strip()
        if not category:
            raise SplitError(f"part {index} needs a category")
        canonical = config.canonical_category(category)
        if canonical is None:
            raise SplitError(f"part {index} category {category!r} is not in the configured taxonomy")
        subcategory = (part.subcategory or "").strip() or None
        cleaned.append(
            SplitPartIn(amount=amount, category=canonical, subcategory=subcategory, claim_type=part.claim_type)
        )
        running += amount
    if running != total:
        raise SplitError(f"parts sum to {running}, not the transaction amount {total}")
    return cleaned


def ensure_splittable(txn: Transaction) -> None:
    """Raise :class:`SplitRefused` when ``txn`` can never be split."""
    if txn.split_parent_id is not None:
        raise SplitRefused("this row is already part of a split; edit the split on its parent")
    if txn.is_internal_transfer:
        raise SplitRefused("internal transfers cannot be split; un-flag the transfer first")


def split_transaction(
    db: Session, txn: Transaction, parts: list[SplitPartIn], config: AppConfig
) -> Transaction:
    """Replace ``txn``'s parts with ``parts`` and mark the split approved.

    Idempotent in shape: calling it on an already-split transaction discards the old
    parts and writes the new ones. The caller owns the transaction (no commit).
    """
    ensure_splittable(txn)
    cleaned = validate_parts(txn, parts, config)
    owner = _owner_for(txn, config)

    # Drop the previous parts first (delete-orphan cascade) so their rows never
    # coexist with the new ones in an aggregate.
    txn.parts = []
    db.flush()

    new_parts: list[Transaction] = []
    for index, part in enumerate(cleaned):
        alloc_p, alloc_s = settlement.allocate(part.amount, part.claim_type, owner, config)
        new_parts.append(
            Transaction(
                period_key=txn.period_key,
                account_id=txn.account_id,
                transaction_date=txn.transaction_date,
                post_date=txn.post_date,
                raw_description=txn.raw_description,
                cleaned_merchant=txn.cleaned_merchant,
                amount=part.amount,
                currency=txn.currency,
                category=part.category,
                subcategory=part.subcategory,
                claim_type=part.claim_type,
                allocated_primary_amount=alloc_p,
                allocated_secondary_amount=alloc_s,
                review_status="manual_approved",
                is_internal_transfer=False,
                classification_source="manual",
                classification_confidence=Decimal("1.000"),
                source_file=txn.source_file,
                upload_id=txn.upload_id,
                split_index=index,
            )
        )
    txn.parts = new_parts
    txn.is_split = True
    txn.review_status = "manual_approved"
    txn.classification_source = "manual"
    txn.classification_confidence = Decimal("1.000")
    db.flush()
    return txn


def unsplit_transaction(db: Session, txn: Transaction) -> Transaction:
    """Remove the parts and make ``txn`` an ordinary (still approved) row again."""
    if txn.split_parent_id is not None:
        raise SplitRefused("this row is a part; remove the split on its parent")
    if not txn.is_split:
        return txn
    txn.parts = []
    txn.is_split = False
    db.flush()
    return txn


def sync_parts_with_parent(db: Session, txn: Transaction) -> None:
    """Copy the parent's merchant on to its parts after the parent was edited."""
    if not txn.is_split:
        return
    for part in txn.parts:
        part.cleaned_merchant = txn.cleaned_merchant
    db.flush()
