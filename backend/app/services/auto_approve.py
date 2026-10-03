"""Approve lines from merchants the owner has always filed the same way.

The approval queue fills up with lines from merchants that have been reviewed many
times before. :func:`decide` looks at one pending line next to its *history*, the
approved lines of the same merchant, and says whether it can be approved with the
category and claim type that history agrees on. Anything out of the ordinary stays
pending, with a reason:

``new_merchant``
    no approved line of this merchant yet.
``new_on_this_card``
    the merchant is known, but only from approvals on other accounts. History is
    per account: Pret on your own card may be your dining while Pret on a shared
    card is split by income, so another card's approvals are no guide.
``few_approvals``
    only one approved line: not enough to call it known.
``other_sign``
    money in where history is money out (a refund), or the other way round.
``unusual_amount``
    history is consistent but the amount is outside ``[0.5 × smallest, 1.5 × largest]``.
``mixed_history``
    the merchant has been filed more than one way (a gym that also sells smoothies)
    and the amount does not exactly repeat one that was always filed the same way.
``transfer`` / ``split`` / ``closed_period``
    an internal transfer, a split line, or a line in a closed month: never touched.

History for a line is every ``manual_approved`` or ``auto_approved`` transaction
on the same account whose merchant matches ignoring case and surrounding spaces, leaving out split
parents (their parts carry the merchant and the amounts), internal transfers,
``Uncategorized`` lines and lines filed under a category that is no longer
configured. The line itself never counts.

An approval goes through the same ``apply_update`` as a manual edit, so allocations
are recomputed, and leaves the line ``auto_approved`` with source ``memory`` and
confidence 0.950. Nothing is written to merchant memory: the history the decision
rests on is already the evidence, and a memory entry would only duplicate it.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import APPROVED_STATUSES, UNCATEGORIZED, AppConfig
from app.models import LedgerPeriod, Transaction

REASONS: tuple[str, ...] = (
    "approved",
    "new_merchant",
    "new_on_this_card",
    "few_approvals",
    "mixed_history",
    "unusual_amount",
    "other_sign",
    "transfer",
    "split",
    "closed_period",
)
MIN_HISTORY = 2
LOW_FACTOR = Decimal("0.5")
HIGH_FACTOR = Decimal("1.5")
EXACT_TOLERANCE = Decimal("0.01")
SOURCE = "memory"
CONFIDENCE = Decimal("0.950")


@dataclass(frozen=True, slots=True)
class Decision:
    approve: bool
    category: str | None
    claim_type: str | None
    reason: str


@dataclass(frozen=True, slots=True)
class Past:
    """One approved line of a merchant, as much of it as a decision needs."""

    id: Any
    amount: Decimal
    category: str
    claim_type: str


@dataclass(slots=True)
class Outcome:
    """What a run decided: the lines approved (or, on a dry run, that would be) and why the rest stay."""

    considered: int = 0
    skipped: Counter[str] = field(default_factory=Counter)
    approved: list[tuple[Transaction, Decision]] = field(default_factory=list)


def merchant_key(name: str | None) -> str:
    return (name or "").strip().upper()


def _sign(value: Decimal) -> int:
    return (value > 0) - (value < 0)


def _keep(reason: str) -> Decision:
    return Decision(approve=False, category=None, claim_type=None, reason=reason)


def decide(line: Any, history: Iterable[Any], *, closed: bool = False) -> Decision:
    """Whether ``line`` can be approved from ``history`` (see the module notes for the rules).

    ``line`` needs ``amount``, ``is_internal_transfer``, ``is_split`` and
    ``split_parent_id``; each history entry needs ``amount``, ``category`` and
    ``claim_type`` (an ``id`` equal to the line's is ignored).
    """
    if closed:
        return _keep("closed_period")
    if getattr(line, "is_split", False) or getattr(line, "split_parent_id", None) is not None:
        return _keep("split")
    if getattr(line, "is_internal_transfer", False):
        return _keep("transfer")

    line_id = getattr(line, "id", None)
    past = [h for h in history if line_id is None or getattr(h, "id", None) != line_id]
    if not past:
        return _keep("new_merchant")
    if len(past) < MIN_HISTORY:
        return _keep("few_approvals")

    amount = Decimal(line.amount)
    signs = Counter(_sign(Decimal(h.amount)) for h in past)
    top = max(signs.values())
    majority = {s for s, n in signs.items() if n == top}
    sign = _sign(amount)
    if sign not in majority:
        return _keep("other_sign")
    # Refunds say nothing about how purchases are filed (and the other way round).
    same_sign = [h for h in past if _sign(Decimal(h.amount)) == sign]
    if len(same_sign) < MIN_HISTORY:
        return _keep("few_approvals")

    size = abs(amount)
    kinds = {(h.category, h.claim_type) for h in same_sign}
    if len(kinds) == 1:
        category, claim_type = next(iter(kinds))
        sizes = [abs(Decimal(h.amount)) for h in same_sign]
        if min(sizes) * LOW_FACTOR <= size <= max(sizes) * HIGH_FACTOR:
            return Decision(approve=True, category=category, claim_type=claim_type, reason="approved")
        return _keep("unusual_amount")

    # Filed more than one way: only an amount that history has seen at least twice,
    # always filed the same way, is safe (the gym's monthly locker fee, not a smoothie).
    repeats = [h for h in same_sign if abs(abs(Decimal(h.amount)) - size) <= EXACT_TOLERANCE]
    repeat_kinds = {(h.category, h.claim_type) for h in repeats}
    if len(repeats) >= MIN_HISTORY and len(repeat_kinds) == 1:
        category, claim_type = next(iter(repeat_kinds))
        return Decision(approve=True, category=category, claim_type=claim_type, reason="approved")
    return _keep("mixed_history")


def load_history(
    db: Session, config: AppConfig, merchants: Iterable[str]
) -> dict[tuple[str, str], list[Past]]:
    """Approved lines per (merchant key, account) for ``merchants``, in one query.

    History is kept per card: Pret on your own card may be your dining while Pret on
    a shared card is split by income, so only approvals on the same account count.
    """
    keys = {merchant_key(m) for m in merchants} - {""}
    if not keys:
        return {}
    key_expr = func.upper(func.trim(Transaction.cleaned_merchant))
    rows = db.execute(
        select(
            Transaction.id,
            key_expr,
            Transaction.account_id,
            Transaction.amount,
            Transaction.category,
            Transaction.claim_type,
        ).where(
            key_expr.in_(keys),
            Transaction.review_status.in_(APPROVED_STATUSES),
            Transaction.is_split.is_(False),
            Transaction.is_internal_transfer.is_(False),
            Transaction.category != UNCATEGORIZED,
        )
    ).all()
    out: dict[tuple[str, str], list[Past]] = defaultdict(list)
    for txn_id, key, account_id, amount, category, claim_type in rows:
        canonical = config.canonical_category(category)
        if canonical is None or canonical == UNCATEGORIZED:
            continue  # a category since removed from Settings is no guide
        out[(key, account_id)].append(
            Past(id=txn_id, amount=Decimal(amount), category=canonical, claim_type=claim_type)
        )
    return out


def _closed_keys(db: Session, lines: Sequence[Transaction]) -> set[str]:
    keys = {t.period_key for t in lines if t.period_key}
    if not keys:
        return set()
    return set(
        db.scalars(
            select(LedgerPeriod.period_key).where(LedgerPeriod.period_key.in_(keys), LedgerPeriod.is_closed.is_(True))
        ).all()
    )


def pending_lines(db: Session, period: str | None = None) -> list[Transaction]:
    """The lines waiting in the approval queue, for one month or for all of them."""
    stmt = select(Transaction).where(
        Transaction.review_status == "pending_review", Transaction.split_parent_id.is_(None)
    )
    if period:
        stmt = stmt.where(Transaction.period_key == period)
    return list(db.scalars(stmt.order_by(Transaction.transaction_date, Transaction.id)).all())


def evaluate(db: Session, config: AppConfig, lines: Sequence[Transaction]) -> Outcome:
    """Decide every line in ``lines`` (two queries in all: closed months and history)."""
    outcome = Outcome(considered=len(lines))
    if not lines:
        return outcome
    closed = _closed_keys(db, lines)
    history = load_history(db, config, (t.cleaned_merchant for t in lines))
    known_anywhere = {key for key, _ in history}
    for txn in lines:
        key = merchant_key(txn.cleaned_merchant)
        decision = decide(txn, history.get((key, txn.account_id), []), closed=txn.period_key in closed)
        if decision.reason == "new_merchant" and key in known_anywhere:
            # Approved on another card only: how it is shared there says nothing about this one.
            decision = _keep("new_on_this_card")
        if decision.approve:
            outcome.approved.append((txn, decision))
        else:
            outcome.skipped[decision.reason] += 1
    return outcome


def apply(db: Session, config: AppConfig, txn: Transaction, decision: Decision) -> Transaction:
    """File ``txn`` as ``decision`` says and mark it auto-approved (allocations recomputed)."""
    # Imported here: the transactions router imports ingestion, which imports this module.
    from app.routers.transactions import apply_update
    from app.schemas import TransactionUpdate

    changes: dict[str, Any] = {"category": decision.category, "claim_type": decision.claim_type}
    if decision.category != txn.category:
        changes["subcategory"] = None  # the guess's subcategory belonged to the guessed category
    apply_update(db, txn, TransactionUpdate(**changes), config)
    txn.review_status = "auto_approved"
    txn.classification_source = SOURCE
    txn.classification_confidence = CONFIDENCE
    db.flush()
    return txn


def run(db: Session, config: AppConfig, lines: Sequence[Transaction], *, dry_run: bool = False) -> Outcome:
    """Decide ``lines`` and, unless ``dry_run``, approve those that qualify. The caller commits."""
    outcome = evaluate(db, config, lines)
    if not dry_run:
        for txn, decision in outcome.approved:
            apply(db, config, txn, decision)
    return outcome
