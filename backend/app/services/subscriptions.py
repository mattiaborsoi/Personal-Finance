"""Subscriptions and price rises, found without any AI.

A *subscription* is a merchant charged at a regular cadence for a similar amount:
roughly monthly (the median gap between charges is 26 to 35 days, and most gaps
fall between 20 and 45) or roughly yearly (a median gap of 350 to 380 days). Every
charge must sit within half and one and a half times the median amount, so a
supermarket visited every few weeks for a different basket is not one. Monthly
needs at least three charges (two gaps), yearly at least two.

The lines looked at are money-out lines of any review status that are neither
internal transfers nor filed under ``Transfers:``, leaving out split parents (their
parts carry the money); merchants are grouped as ``upper(trim(cleaned_merchant))``.

For each subscription the newest charge is compared with the one before it: a
different amount is reported as a *price change* in the month of the newest charge
("Netflix went from £10.99 to £12.99 in September"). A subscription whose first
charge is within the last :data:`NEW_DAYS` days is *new*; one whose next expected
charge is more than half a cadence overdue is *stopped*. "Now" is the newest
transaction date in the ledger (``as_of``), not today's date, because statements
are uploaded after the fact.

``monthly_cost`` is the latest amount for a monthly subscription and a twelfth of
it for a yearly one; ``total_monthly`` adds up the ones that have not stopped.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from statistics import median

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import TRANSFER_CATEGORY_PREFIX
from app.models import Transaction
from app.schemas import SubscriptionChange, SubscriptionOut, SubscriptionsOut

MONTHLY_MEDIAN_DAYS = (26, 35)
MONTHLY_GAP_DAYS = (20, 45)
YEARLY_MEDIAN_DAYS = (350, 380)
MIN_MONTHLY_CHARGES = 3
MIN_YEARLY_CHARGES = 2
AMOUNT_LOW = Decimal("0.5")
AMOUNT_HIGH = Decimal("1.5")
NEW_DAYS = 90
GAP_SHARE = 2 / 3  # the share of gaps that must sit inside MONTHLY_GAP_DAYS

TWO_PLACES = Decimal("0.01")


@dataclass(frozen=True, slots=True)
class Charge:
    day: date
    amount: Decimal  # positive magnitude
    category: str
    merchant: str


def _q2(value: Decimal) -> Decimal:
    return value.quantize(TWO_PLACES, rounding=ROUND_HALF_UP)


def _add_months(day: date, months: int) -> date:
    month = day.month - 1 + months
    year = day.year + month // 12
    month = month % 12 + 1
    last = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(day.day, last))


def cadence_of(days: list[date]) -> str | None:
    """``"monthly"``, ``"yearly"`` or ``None`` for the sorted charge dates ``days``."""
    gaps = [(b - a).days for a, b in zip(days, days[1:], strict=False)]
    if not gaps:
        return None
    mid = median(gaps)
    if len(days) >= MIN_MONTHLY_CHARGES and MONTHLY_MEDIAN_DAYS[0] <= mid <= MONTHLY_MEDIAN_DAYS[1]:
        inside = sum(MONTHLY_GAP_DAYS[0] <= g <= MONTHLY_GAP_DAYS[1] for g in gaps)
        if inside / len(gaps) >= GAP_SHARE:
            return "monthly"
    if len(days) >= MIN_YEARLY_CHARGES and YEARLY_MEDIAN_DAYS[0] <= mid <= YEARLY_MEDIAN_DAYS[1]:
        return "yearly"
    return None


def amounts_similar(amounts: list[Decimal]) -> bool:
    mid = Decimal(str(median(amounts)))
    if mid <= 0:
        return False
    return all(mid * AMOUNT_LOW <= a <= mid * AMOUNT_HIGH for a in amounts)


def detect(charges: list[Charge], as_of: date) -> SubscriptionOut | None:
    """One merchant's charges (any order) -> its subscription, or ``None``."""
    charges = sorted(charges, key=lambda c: (c.day, c.amount))
    cadence = cadence_of([c.day for c in charges])
    if cadence is None or not amounts_similar([c.amount for c in charges]):
        return None
    last, previous = charges[-1], charges[-2]
    months = 1 if cadence == "monthly" else 12
    next_expected = _add_months(last.day, months)
    overdue_after = next_expected + timedelta(days=(15 if cadence == "monthly" else 183))
    if overdue_after < as_of:
        status = "stopped"
    elif (as_of - charges[0].day).days <= NEW_DAYS:
        status = "new"
    else:
        status = "active"
    change = None
    if last.amount != previous.amount:
        change = SubscriptionChange(
            from_amount=previous.amount, to_amount=last.amount, month=last.day.strftime("%Y-%m")
        )
    monthly_cost = _q2(last.amount / months)
    return SubscriptionOut(
        merchant=last.merchant,
        category=last.category,
        cadence=cadence,
        amount=last.amount,
        monthly_cost=monthly_cost,
        charges=len(charges),
        first_date=charges[0].day,
        last_date=last.day,
        next_expected=next_expected,
        status=status,
        change=change,
    )


def _charges(db: Session) -> tuple[dict[str, list[Charge]], date | None]:
    rows = db.execute(
        select(
            Transaction.transaction_date,
            Transaction.amount,
            Transaction.category,
            Transaction.cleaned_merchant,
        ).where(
            Transaction.amount < 0,
            Transaction.is_split.is_(False),
            Transaction.is_internal_transfer.isnot(True),
            Transaction.category.not_like(f"{TRANSFER_CATEGORY_PREFIX}%"),
        )
    ).all()
    by_merchant: dict[str, list[Charge]] = defaultdict(list)
    for day, amount, category, merchant in rows:
        key = (merchant or "").strip().upper()
        if not key:
            continue
        charge = Charge(day=day, amount=_q2(-Decimal(amount)), category=category, merchant=merchant.strip())
        by_merchant[key].append(charge)
    as_of = db.scalar(select(func.max(Transaction.transaction_date)))
    return by_merchant, as_of


def find_subscriptions(db: Session) -> SubscriptionsOut:
    by_merchant, as_of = _charges(db)
    if as_of is None:
        return SubscriptionsOut(items=[], total_monthly=Decimal("0.00"), as_of=None)
    items: list[SubscriptionOut] = []
    for charges in by_merchant.values():
        found = detect(charges, as_of)
        if found is not None:
            items.append(found)
    items.sort(key=lambda s: (s.status == "stopped", -s.monthly_cost, s.merchant.lower()))
    total = sum((s.monthly_cost for s in items if s.status != "stopped"), Decimal("0.00"))
    return SubscriptionsOut(items=items, total_monthly=_q2(total), as_of=as_of)
