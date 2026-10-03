"""Apply the rules to lines already waiting for review.

Rules run when a statement is imported (``app.services.guesser``). A rule added or
edited later leaves the lines already in the approval queue with their earlier
memory or AI guess; Settings -> Rules, "Apply to waiting lines", calls
:func:`plan` and :func:`apply` to re-run the rules on them.

Scope: ``pending_review`` lines that are neither split parents nor split parts and
whose month is not closed, optionally limited to one month. Approved lines are
never touched.

Each line in scope is matched with :func:`app.services.rules.match_rule` against
its raw description and amount, exactly as at import. A line a rule matches is
filed as import would have filed it and approved the same way: category, claim
type, subcategory, the rule's merchant (only when the rule names one) and the
transfer flag, then ``auto_approved`` with source ``rule`` and confidence 1.000.
The edit goes through the transactions router's ``apply_update``, so allocations
are recomputed and a transfer rule registers the line in the transfer buffer and
writes the mirror leg for a ``transfer_to_account``. A line already filed the way
its rule says is *unchanged*: it is approved, nothing else moves.

AI accuracy follows "approve known merchants" (``app.services.auto_approve``):
``ai_accuracy.record_approval`` compares the approved fields with what the model
suggested, so a rule overriding the model counts as a suggestion not accepted.
Nothing is written to merchant memory, as at import.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from decimal import Decimal

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.config import UNCATEGORIZED, AppConfig
from app.models import LedgerPeriod, Transaction
from app.services import ai_accuracy, rules
from app.services.guesser import INTERNAL_TRANSFER_CATEGORY

SOURCE = "rule"
CONFIDENCE = Decimal("1.000")
MAX_ITEMS = 200


@dataclass(slots=True)
class Plan:
    """What a rule would do to one waiting line."""

    txn: Transaction
    rule_index: int
    category: str
    claim_type: str
    subcategory: str | None
    merchant: str | None
    """The rule's own merchant name, or ``None`` to leave the line's merchant alone."""
    internal: bool
    changed: bool


@dataclass(slots=True)
class Outcome:
    matched: int = 0
    changed: int = 0
    approved: int = 0
    unchanged: int = 0
    plans: list[Plan] = field(default_factory=list)


def waiting_lines(db: Session, period: str | None = None) -> list[Transaction]:
    """Pending lines in scope: no split parents or parts, no closed months."""
    closed = select(LedgerPeriod.period_key).where(LedgerPeriod.is_closed.is_(True))
    stmt = select(Transaction).where(
        Transaction.review_status == "pending_review",
        Transaction.split_parent_id.is_(None),
        Transaction.is_split.is_(False),
        or_(Transaction.period_key.is_(None), Transaction.period_key.not_in(closed)),
    )
    if period:
        stmt = stmt.where(Transaction.period_key == period)
    return list(db.scalars(stmt.order_by(Transaction.transaction_date, Transaction.id)).all())


def _rule_index(config: AppConfig, rule: object) -> int:
    for index, candidate in enumerate(config.deterministic_rules):
        if candidate is rule:
            return index
    return -1


def plan(db: Session, config: AppConfig, lines: Sequence[Transaction]) -> Outcome:
    """Decide every line without writing anything."""
    outcome = Outcome()
    for txn in lines:
        match = rules.match_rule(txn.raw_description, config, txn.amount)
        if match is None:
            continue
        category = match.category
        if category != UNCATEGORIZED:
            canonical = config.canonical_category(category)
            if canonical is None:
                continue  # the rule names a category no longer configured: leave the line alone
            category = canonical
        # As at import: a line filed under Transfers:Internal is a transfer, and a transfer is personal.
        internal = match.is_internal_transfer or category == INTERNAL_TRANSFER_CATEGORY
        claim_type = "personal" if internal else match.claim_type
        subcategory = (match.subcategory or "").strip()[:128] or None
        merchant = match.rule.merchant.strip()[:255] if match.rule.merchant else None
        changed = (
            txn.category != category
            or txn.claim_type != claim_type
            or (txn.subcategory or None) != subcategory
            or bool(txn.is_internal_transfer) != internal
            or (merchant is not None and txn.cleaned_merchant != merchant)
        )
        outcome.plans.append(
            Plan(
                txn=txn,
                rule_index=_rule_index(config, match.rule),
                category=category,
                claim_type=claim_type,
                subcategory=subcategory,
                merchant=merchant,
                internal=internal,
                changed=changed,
            )
        )
    outcome.matched = len(outcome.plans)
    outcome.changed = sum(1 for p in outcome.plans if p.changed)
    outcome.unchanged = outcome.matched - outcome.changed
    outcome.approved = outcome.matched
    # Lines that change first, so a capped list keeps the ones worth reading.
    outcome.plans.sort(key=lambda p: not p.changed)
    return outcome


def apply(db: Session, config: AppConfig, item: Plan) -> Transaction:
    """File the line as the rule says and approve it (allocations, transfer and mirror included)."""
    # Imported here: the transactions router imports ingestion, which imports the guesser.
    from app.routers.transactions import apply_update
    from app.schemas import TransactionUpdate

    txn = item.txn
    if item.changed:
        changes: dict = {"category": item.category, "claim_type": item.claim_type, "subcategory": item.subcategory}
        if item.merchant is not None:
            changes["cleaned_merchant"] = item.merchant
        if txn.amount != 0:
            changes["is_internal_transfer"] = item.internal
        else:
            # Import keeps a zero-amount transfer out of the buffer; only the flag is set.
            txn.is_internal_transfer = item.internal
        apply_update(db, txn, TransactionUpdate(**changes), config)
    txn.review_status = "auto_approved"
    txn.classification_source = SOURCE
    txn.classification_confidence = CONFIDENCE
    ai_accuracy.record_approval(txn)
    db.flush()
    return txn

