"""Category suggestions for the picker (``GET /categories/suggestions``).

Two short lists, both limited to categories still in the taxonomy and never
:data:`~app.config.UNCATEGORIZED`:

* ``merchant``: the categories a merchant was filed under before. Approved
  transactions (``auto_approved`` or ``manual_approved``) whose ``cleaned_merchant``
  matches ignoring case and surrounding spaces are counted; split parents are left
  out and their parts, which carry the parent's merchant, counted instead. A
  merchant-memory row whose ``normalized_merchant`` matches adds its category with a
  count of at least 1. Ranked by count, then by the most recent use.
* ``frequent``: the categories used most by approved transactions (split parts
  instead of their parents) dated within the last 12 months.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import APPROVED_STATUSES, UNCATEGORIZED, AppConfig
from app.models import MerchantMemory, Transaction
from app.schemas import CategoryCount, CategorySuggestionsOut


def _year_before(day: date) -> date:
    try:
        return day.replace(year=day.year - 1)
    except ValueError:  # 29 February
        return day.replace(year=day.year - 1, day=28)


def _approved_leaves():
    """Approved rows that carry their own category: not split parents, not Uncategorized."""
    return (
        Transaction.review_status.in_(APPROVED_STATUSES),
        Transaction.is_split.is_(False),
        func.lower(Transaction.category) != UNCATEGORIZED.lower(),
    )


def _canonical(config: AppConfig, category: str | None) -> str | None:
    name = config.canonical_category(category)
    return None if name is None or name == UNCATEGORIZED else name


def merchant_categories(db: Session, config: AppConfig, merchant: str, limit: int) -> list[CategoryCount]:
    key = merchant.strip().lower()
    counts: dict[str, int] = {}
    latest: dict[str, date] = {}

    def add(category: str | None, count: int, when: date | None) -> None:
        name = _canonical(config, category)
        if name is None:
            return
        counts[name] = counts.get(name, 0) + count
        if when is not None and (name not in latest or when > latest[name]):
            latest[name] = when

    rows = db.execute(
        select(Transaction.category, func.count(), func.max(Transaction.transaction_date))
        .where(func.lower(func.trim(Transaction.cleaned_merchant)) == key, *_approved_leaves())
        .group_by(Transaction.category)
    )
    for category, count, when in rows:
        add(category, int(count), when)

    memories = db.execute(
        select(MerchantMemory.category, MerchantMemory.last_updated).where(
            func.lower(func.trim(MerchantMemory.normalized_merchant)) == key
        )
    )
    for category, updated in memories:
        name = _canonical(config, category)
        if name is None:
            continue
        # A remembered merchant counts as at least one use of its category.
        add(name, 0 if counts.get(name) else 1, updated.date() if updated is not None else None)

    ranked = sorted(counts, key=lambda name: (-counts[name], -(latest.get(name) or date.min).toordinal(), name))
    return [CategoryCount(category=name, count=counts[name]) for name in ranked[:limit]]


def frequent_categories(db: Session, config: AppConfig, limit: int, today: date | None = None) -> list[CategoryCount]:
    since = _year_before(today or date.today())
    rows = db.execute(
        select(Transaction.category, func.count())
        .where(Transaction.transaction_date >= since, *_approved_leaves())
        .group_by(Transaction.category)
    )
    counts: dict[str, int] = {}
    for category, count in rows:
        name = _canonical(config, category)
        if name is not None:
            counts[name] = counts.get(name, 0) + int(count)
    ranked = sorted(counts, key=lambda name: (-counts[name], name))
    return [CategoryCount(category=name, count=counts[name]) for name in ranked[:limit]]


def suggestions(
    db: Session, config: AppConfig, merchant: str, limit: int, today: date | None = None
) -> CategorySuggestionsOut:
    return CategorySuggestionsOut(
        merchant=merchant_categories(db, config, merchant, limit),
        frequent=frequent_categories(db, config, limit, today),
    )
