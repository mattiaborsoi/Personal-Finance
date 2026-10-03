"""Outliers: a line filed unlike the merchant usually is on the same card.

A slip of the owner's own, or a rule or memory answer that disagrees with how the
merchant is normally filed, is flagged so it stands out on Review and Transactions.
The yardstick is the per-card history the auto-approve service builds
(:func:`app.services.auto_approve.load_history`): the approved lines of the same
merchant on the same account. A line is *unusual* when that history, without the
line itself, holds at least :data:`MIN_HISTORY` lines and the line's own
(category, claim type) pair appears in at most :data:`MAX_SHARE` of them. Split
lines and internal transfers are never flagged.

Two ways in, built on the same rule:

* :func:`annotate` works out the detail for one page of rows (the usual filing and
  the counts for the badge's tooltip) from one history query;
* :func:`unusual_condition` is the same rule as SQL, for the Transactions filter
  (``unusual=true``) and the per-month counts on the dashboard.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session, aliased

from app.config import APPROVED_STATUSES, UNCATEGORIZED, AppConfig
from app.models import Transaction
from app.services import auto_approve

MIN_HISTORY = 4
MAX_SHARE = 0.2  # 1 in 5


@dataclass(frozen=True, slots=True)
class Unusual:
    usual_category: str
    usual_claim_type: str
    times: int
    """How often the line's own filing appears in the history."""
    total: int
    """The history's size (approved lines of the merchant on this card, the line itself aside)."""


def _flaggable(txn: Transaction) -> bool:
    return not txn.is_split and txn.split_parent_id is None and not txn.is_internal_transfer


def annotate(db: Session, config: AppConfig, txns: list[Transaction]) -> dict[Any, Unusual]:
    """``{transaction id: Unusual}`` for the flagged rows of ``txns``, from one history query."""
    candidates = [t for t in txns if _flaggable(t)]
    if not candidates:
        return {}
    history = auto_approve.load_history(db, config, (t.cleaned_merchant for t in candidates))
    out: dict[Any, Unusual] = {}
    for txn in candidates:
        key = (auto_approve.merchant_key(txn.cleaned_merchant), txn.account_id)
        past = [p for p in history.get(key, []) if p.id != txn.id]
        if len(past) < MIN_HISTORY:
            continue
        filings = Counter((p.category, p.claim_type) for p in past)
        own = (config.canonical_category(txn.category) or txn.category, txn.claim_type)
        times = filings.get(own, 0)
        if times > MAX_SHARE * len(past):
            continue
        (usual_category, usual_claim_type), _ = filings.most_common(1)[0]
        out[txn.id] = Unusual(
            usual_category=usual_category, usual_claim_type=usual_claim_type, times=times, total=len(past)
        )
    return out


def _history_subqueries():
    """Per (merchant key, account): approved lines in all, and per (category, claim type)."""
    past = aliased(Transaction)
    key_expr = func.upper(func.trim(past.cleaned_merchant))
    approved = and_(
        past.review_status.in_(APPROVED_STATUSES),
        past.is_split.is_(False),
        past.is_internal_transfer.is_(False),
        past.category != UNCATEGORIZED,
    )
    same = (
        select(
            key_expr.label("key"),
            past.account_id.label("account_id"),
            past.category.label("category"),
            past.claim_type.label("claim_type"),
            func.count().label("n"),
        )
        .where(approved)
        .group_by(key_expr, past.account_id, past.category, past.claim_type)
        .subquery("same_filing")
    )
    totals = (
        select(key_expr.label("key"), past.account_id.label("account_id"), func.count().label("total"))
        .where(approved)
        .group_by(key_expr, past.account_id)
        .subquery("history_total")
    )
    return same, totals


def unusual_condition():
    """``(joins, condition)``: apply ``stmt.outerjoin(*j)`` for each join, then ``where(condition)``.

    The line's own row counts in the history when it is approved, so one is taken
    off both counts for it; a line below :data:`MIN_HISTORY` others never qualifies.
    """
    same, totals = _history_subqueries()
    own_key = func.upper(func.trim(Transaction.cleaned_merchant))
    self_counts = case(
        (
            and_(
                Transaction.review_status.in_(APPROVED_STATUSES),
                Transaction.is_split.is_(False),
                Transaction.is_internal_transfer.is_(False),
                Transaction.category != UNCATEGORIZED,
            ),
            1,
        ),
        else_=0,
    )
    total = func.coalesce(totals.c.total, 0) - self_counts
    times = func.coalesce(same.c.n, 0) - self_counts
    joins = [
        (
            same,
            and_(
                same.c.key == own_key,
                same.c.account_id == Transaction.account_id,
                same.c.category == Transaction.category,
                same.c.claim_type == Transaction.claim_type,
            ),
        ),
        (totals, and_(totals.c.key == own_key, totals.c.account_id == Transaction.account_id)),
    ]
    condition = and_(
        Transaction.is_split.is_(False),
        Transaction.split_parent_id.is_(None),
        Transaction.is_internal_transfer.is_(False),
        total >= MIN_HISTORY,
        times * 5 <= total,  # at most one in five
    )
    return joins, condition


def with_unusual_filter(stmt):
    """``stmt`` (a select over :class:`Transaction`) narrowed to the unusual lines."""
    joins, condition = unusual_condition()
    for subquery, on in joins:
        stmt = stmt.outerjoin(subquery, on)
    return stmt.where(condition)


def counts_by_period(db: Session) -> dict[str, int]:
    """``{period_key: unusual lines}`` for every month, in one query."""
    stmt = with_unusual_filter(select(Transaction.period_key, func.count(Transaction.id)))
    rows = db.execute(stmt.group_by(Transaction.period_key)).all()
    return {key: int(n) for key, n in rows if key}
