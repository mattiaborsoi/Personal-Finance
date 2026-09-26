"""Multi-view metrics and investment cash-basis tracking (blueprint §5).

Three views of one period
-------------------------
Unless stated otherwise a view considers the period's transactions whose
``review_status`` is ``auto_approved`` or ``manual_approved`` and leaves out
internal transfers (``is_internal_transfer``) and anything categorised
``Transfers:*`` (card payments, settlement money, cash moved to investments).
Partner claims are stored as positive costs and are included whether or not they
have been settled.

* **Macro / Total Household Burn** - what the household spent, before anyone's
  share is worked out.

  - ``primary_accounts_burn`` = Σ |amount| over debits (``amount < 0``) across all
    accounts. Refunds (positive amounts) are deliberately *not* netted here: the
    headline burn is gross spend.
  - ``partner_claims_burn`` = Σ ``partner_claims.amount``.
  - ``household_burn`` = ``primary_accounts_burn + partner_claims_burn``.
  - ``by_category`` nets refunds per category (Σ ``-amount``), so a category with a
    large refund can have a negative figure and an income category such as
    ``Income:Salary`` appears negative. Every category is listed, largest first.

* **Micro / True Net Expense** - what the primary user actually bears.

  - ``from_transactions`` = Σ ``-allocated_primary_amount`` (refunds and income
    credits reduce it).
  - ``from_partner_claims`` = Σ ``partner_claims.primary_owes``.
  - ``true_net_expense`` = the sum of the two.
  - ``by_category`` uses the same allocation per category; partner claims appear
    under the pseudo-category ``"Partner claims"`` whenever the period has any.

* **Liquidity / Cash Flow** - literal cash movement on checking/savings accounts
  (``AppConfig.checking_account_ids()``): every review status and internal transfers
  included. ``credits`` = Σ positive amounts, ``debits`` = Σ |negative amounts|,
  ``net_cash_flow = credits - debits``; ``by_account`` lists every configured
  checking/savings account in configuration order, zeros when idle.

Investment tracking
-------------------
Per ``investment_cash`` account (configured ones, plus any present in the database
with that type), over *all* periods and review statuses, using only
``is_internal_transfer`` rows - the mirror entries the ingestion pipeline writes on
the investment account (positive = deposit, negative = withdrawal):

    net_invested_capital = deposits - withdrawals
    realized_gain        = max(withdrawals - deposits, 0)

which is exactly the ``investment_position`` SQL view in ``schema.sql``. Totals sum
the per-account figures (so one account's gain is never offset by another's
deposits).

All money is ``Decimal`` quantised to two places with ``ROUND_HALF_UP``. Every
function is read-only apart from an initial ``flush()`` so that rows the caller has
added to the session are counted; a period with no rows - or one that does not
exist - yields zeros rather than an error.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.config import TRANSFER_CATEGORY_PREFIX, AppConfig
from app.models import Account, LedgerPeriod, PartnerClaim, Transaction
from app.schemas import (
    CategoryAmount,
    InvestmentAccountSummary,
    InvestmentSummary,
    LiquidityMetrics,
    MacroMetrics,
    MetricsOut,
    MicroMetrics,
    TrendPoint,
)
from app.services.periods import period_bounds, period_key_for, previous_period_key

APPROVED_STATUSES: tuple[str, ...] = ("auto_approved", "manual_approved")
PARTNER_CLAIMS_CATEGORY = "Partner claims"
INVESTMENT_ACCOUNT_TYPE = "investment_cash"
INCOME_CATEGORY_PREFIX = "Income:"

TWO_PLACES = Decimal("0.01")
ZERO = Decimal("0.00")


def period_metrics(db: Session, config: AppConfig, period_key: str) -> MetricsOut:
    """Macro, micro and liquidity views of ``period_key`` (see the module docstring).

    Raises ``ValueError`` for a malformed key; an unknown or empty period returns
    zeros with empty ``by_category`` lists.
    """
    period_bounds(period_key)  # validates the YYYY-MM format
    db.flush()
    categories = _spend_by_category(db, period_key)
    claims = _claim_totals(db, period_key)
    return MetricsOut(
        period_key=period_key,
        macro=_macro(categories, claims),
        micro=_micro(categories, claims),
        liquidity=_liquidity(db, config, period_key),
    )


def trends(db: Session, config: AppConfig, periods: int = 6, ending: str | None = None) -> list[TrendPoint]:
    """Per-period series for the last ``periods`` periods ending at ``ending`` (or latest).

    ``ending`` defaults to the latest ``period_key`` in ``ledger_periods``, or to the
    current UTC month when no period exists yet. The result is oldest first and
    covers consecutive months, with zeros for months that have no data.
    ``periods <= 0`` returns an empty list.
    """
    if periods <= 0:
        return []
    db.flush()
    ending = ending or _latest_period_key(db) or period_key_for(datetime.now(UTC).date())
    keys = [ending] + [previous_period_key(ending, steps) for steps in range(1, periods)]
    keys.reverse()

    points: list[TrendPoint] = []
    for key in keys:
        m = period_metrics(db, config, key)
        points.append(
            TrendPoint(
                period_key=key,
                household_burn=m.macro.household_burn,
                true_net_expense=m.micro.true_net_expense,
                net_cash_flow=m.liquidity.net_cash_flow,
            )
        )
    return points


def investment_summary(db: Session, config: AppConfig) -> InvestmentSummary:
    """Cash-basis position of every investment account (all periods, all statuses).

    Accounts come from the configuration first (in configuration order) followed by
    any ``investment_cash`` account that exists only in the database. An account
    with no mirror rows is listed with zeros.
    """
    db.flush()
    account_ids = _investment_account_ids(db, config)
    totals = _credits_and_debits_by_account(
        db,
        account_ids,
        Transaction.is_internal_transfer.is_(True),
    )

    accounts: list[InvestmentAccountSummary] = []
    for account_id in account_ids:
        deposits, withdrawals = totals.get(account_id, (ZERO, ZERO))
        accounts.append(
            InvestmentAccountSummary(
                account_id=account_id,
                total_deposits=deposits,
                total_withdrawals=withdrawals,
                net_invested_capital=deposits - withdrawals,
                realized_gain=max(withdrawals - deposits, ZERO),
            )
        )
    return InvestmentSummary(
        accounts=accounts,
        total_deposits=quantize(sum((a.total_deposits for a in accounts), ZERO)),
        total_withdrawals=quantize(sum((a.total_withdrawals for a in accounts), ZERO)),
        net_invested_capital=quantize(sum((a.net_invested_capital for a in accounts), ZERO)),
        realized_gain=quantize(sum((a.realized_gain for a in accounts), ZERO)),
    )


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def quantize(value: Decimal | int | str) -> Decimal:
    """Two decimal places, ``ROUND_HALF_UP`` (halves away from zero for both signs)."""
    return _as_decimal(value).quantize(TWO_PLACES, rounding=ROUND_HALF_UP)


def _as_decimal(value: Decimal | int | str | float | None) -> Decimal:
    """Coerce a database aggregate to ``Decimal`` without going through float repr."""
    if value is None:
        return Decimal(0)
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


@dataclass(frozen=True)
class _CategoryTotals:
    """Per-category sums over the approved, non-transfer transactions of a period."""

    category: str
    gross_debits: Decimal
    """Σ |amount| over debits only - refunds are not netted."""
    net_spend: Decimal
    """Σ -amount - refunds and credits net off."""
    primary_net_spend: Decimal
    """Σ -allocated_primary_amount - the primary user's net share."""


@dataclass(frozen=True)
class _ClaimTotals:
    """Sums over the partner claims of a period."""

    count: int
    amount: Decimal
    primary_owes: Decimal


def _approved_non_transfer(period_key: str) -> tuple:
    """Filter clauses shared by the macro and micro views.

    Income categories (``Income:*``) are left out: both views are *expense* views, so
    a salary credit must not shrink "household burn" or "true net expense". Refunds
    keep their own spend category and therefore still net off.
    """
    return (
        Transaction.period_key == period_key,
        Transaction.review_status.in_(APPROVED_STATUSES),
        Transaction.is_internal_transfer.is_not(True),
        # A split parent carries no money of its own; its parts are ordinary rows here.
        Transaction.is_split.is_not(True),
        ~Transaction.category.startswith(TRANSFER_CATEGORY_PREFIX),
        ~Transaction.category.startswith(INCOME_CATEGORY_PREFIX),
    )


def _spend_by_category(db: Session, period_key: str) -> list[_CategoryTotals]:
    debit_abs = case((Transaction.amount < 0, -Transaction.amount), else_=0)
    stmt = (
        select(
            Transaction.category,
            func.coalesce(func.sum(debit_abs), 0),
            func.coalesce(func.sum(-Transaction.amount), 0),
            func.coalesce(func.sum(-Transaction.allocated_primary_amount), 0),
        )
        .where(*_approved_non_transfer(period_key))
        .group_by(Transaction.category)
    )
    return [
        _CategoryTotals(
            category=category,
            gross_debits=quantize(gross),
            net_spend=quantize(net),
            primary_net_spend=quantize(primary),
        )
        for category, gross, net, primary in db.execute(stmt)
    ]


def _claim_totals(db: Session, period_key: str) -> _ClaimTotals:
    stmt = select(
        func.count(),
        func.coalesce(func.sum(PartnerClaim.amount), 0),
        func.coalesce(func.sum(PartnerClaim.primary_owes), 0),
    ).where(PartnerClaim.period_key == period_key)
    count, amount, primary_owes = db.execute(stmt).one()
    return _ClaimTotals(count=int(count or 0), amount=quantize(amount), primary_owes=quantize(primary_owes))


def _macro(categories: list[_CategoryTotals], claims: _ClaimTotals) -> MacroMetrics:
    primary_burn = quantize(sum((c.gross_debits for c in categories), ZERO))
    return MacroMetrics(
        household_burn=primary_burn + claims.amount,
        primary_accounts_burn=primary_burn,
        partner_claims_burn=claims.amount,
        by_category=_sorted_categories(CategoryAmount(category=c.category, amount=c.net_spend) for c in categories),
    )


def _micro(categories: list[_CategoryTotals], claims: _ClaimTotals) -> MicroMetrics:
    from_transactions = quantize(sum((c.primary_net_spend for c in categories), ZERO))
    by_category = [CategoryAmount(category=c.category, amount=c.primary_net_spend) for c in categories]
    if claims.count:
        by_category.append(CategoryAmount(category=PARTNER_CLAIMS_CATEGORY, amount=claims.primary_owes))
    return MicroMetrics(
        true_net_expense=from_transactions + claims.primary_owes,
        from_transactions=from_transactions,
        from_partner_claims=claims.primary_owes,
        by_category=_sorted_categories(by_category),
    )


def _sorted_categories(items: Iterable[CategoryAmount]) -> list[CategoryAmount]:
    """Largest amount first; ties broken by category name for a stable output."""
    return sorted(items, key=lambda item: (-item.amount, item.category))


def _liquidity(db: Session, config: AppConfig, period_key: str) -> LiquidityMetrics:
    account_ids = config.checking_account_ids()
    totals = _credits_and_debits_by_account(db, account_ids, Transaction.period_key == period_key)

    by_account: list[dict] = []
    credits_total = ZERO
    debits_total = ZERO
    for account_id in account_ids:
        credits, debits = totals.get(account_id, (ZERO, ZERO))
        by_account.append({"account_id": account_id, "credits": credits, "debits": debits, "net": credits - debits})
        credits_total += credits
        debits_total += debits
    return LiquidityMetrics(
        credits=credits_total,
        debits=debits_total,
        net_cash_flow=credits_total - debits_total,
        by_account=by_account,
    )


def _credits_and_debits_by_account(
    db: Session, account_ids: list[str], *extra_filters
) -> dict[str, tuple[Decimal, Decimal]]:
    """``{account_id: (Σ positive amounts, Σ |negative amounts|)}`` for ``account_ids``.

    Every review status is included; ``extra_filters`` narrow the rows further.
    Accounts without rows are simply absent from the result. Split parts are left
    out: the parent row is the cash movement, the parts only re-label it.
    """
    if not account_ids:
        return {}
    credit = case((Transaction.amount > 0, Transaction.amount), else_=0)
    debit_abs = case((Transaction.amount < 0, -Transaction.amount), else_=0)
    stmt = (
        select(
            Transaction.account_id,
            func.coalesce(func.sum(credit), 0),
            func.coalesce(func.sum(debit_abs), 0),
        )
        .where(Transaction.account_id.in_(account_ids), Transaction.split_parent_id.is_(None), *extra_filters)
        .group_by(Transaction.account_id)
    )
    return {account_id: (quantize(credits), quantize(debits)) for account_id, credits, debits in db.execute(stmt)}


def _investment_account_ids(db: Session, config: AppConfig) -> list[str]:
    """Configured investment accounts first, then database-only ones (sorted by id)."""
    ids = list(config.investment_account_ids())
    stmt = select(Account.id).where(Account.account_type == INVESTMENT_ACCOUNT_TYPE).order_by(Account.id)
    for account_id in db.scalars(stmt):
        if account_id not in ids:
            ids.append(account_id)
    return ids


def _latest_period_key(db: Session) -> str | None:
    """Most recent ``YYYY-MM`` key in ``ledger_periods`` (keys sort chronologically)."""
    return db.scalar(select(func.max(LedgerPeriod.period_key)))
