"""Tests for the multi-view metrics and investment tracking service.

Rows are inserted through ``tests.factories`` (allocations computed independently
of the settlement service) into ``seeded_db``, which carries the example accounts.
Expected figures are derived by hand from the rows below and written out in full.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import AppConfig
from app.models import Account, Transaction
from app.schemas import CategoryAmount, InvestmentSummary
from app.services import metrics
from app.services.periods import close_period, period_key_for, previous_period_key
from tests.conftest import requires_db
from tests.factories import ensure_period, make_claim, make_transaction, q2

D = Decimal
PERIOD = "2026-08"
CHECKING = "acc_checking_hsbc"
OTHER_CHECKING = "acc_checking_barclays"  # the secondary user's current account: configured, idle here
CARD = "acc_cc_amex"
INVEST = "acc_invest_robinhood"
IDLE_OTHER_CHECKING = {"account_id": OTHER_CHECKING, "credits": D("0.00"), "debits": D("0.00"), "net": D("0.00")}


def _is_2dp(value: Decimal) -> bool:
    return isinstance(value, Decimal) and value.as_tuple().exponent == -2


def seed_august(db: Session, config: AppConfig) -> dict[str, Decimal]:
    """The scenario from the task description; returns the hand-derived shares."""
    # Card: shared expense, personal expense and a shared refund.
    make_transaction(db, config, account_id=CARD, transaction_date=date(2026, 8, 3), amount="-100.00",
                     raw_description="WAITROSE 1234 LONDON", category="Groceries",
                     claim_type="shared_proportional", review_status="manual_approved")
    make_transaction(db, config, account_id=CARD, transaction_date=date(2026, 8, 5), amount="-20.00",
                     raw_description="CINEWORLD", category="Entertainment",
                     claim_type="personal", review_status="auto_approved")
    make_transaction(db, config, account_id=CARD, transaction_date=date(2026, 8, 9), amount="30.00",
                     raw_description="WAITROSE REFUND", category="Groceries",
                     claim_type="shared_proportional", review_status="manual_approved")
    # Card payment: both legs are internal transfers.
    make_transaction(db, config, account_id=CHECKING, transaction_date=date(2026, 8, 1), amount="-3384.21",
                     raw_description="HSBC CARD PYMT", category="Transfers:Internal",
                     claim_type="personal", review_status="auto_approved", is_internal_transfer=True)
    make_transaction(db, config, account_id=CARD, transaction_date=date(2026, 8, 2), amount="3384.21",
                     raw_description="PAYMENT RECEIVED - THANK YOU", category="Transfers:Internal",
                     claim_type="personal", review_status="auto_approved", is_internal_transfer=True)
    # Settlement money from the partner and salary on the checking account.
    make_transaction(db, config, account_id=CHECKING, transaction_date=date(2026, 8, 3), amount="1685.73",
                     raw_description="PARTNER TRANSFER CR", category="Transfers:Settlement",
                     claim_type="personal", review_status="auto_approved")
    make_transaction(db, config, account_id=CHECKING, transaction_date=date(2026, 8, 25), amount="4500.00",
                     raw_description="EMPLOYER SALARY", category="Income:Salary",
                     claim_type="personal", review_status="manual_approved")
    # Still pending: counts for liquidity only.
    make_transaction(db, config, account_id=CHECKING, transaction_date=date(2026, 8, 20), amount="-50.00",
                     raw_description="RESTAURANT", category="Dining",
                     claim_type="shared_proportional", review_status="pending_review")
    claim = make_claim(db, config, claim_date=date(2026, 8, 10), amount="50.00", claim_type="shared_proportional")

    shares = {
        "shared_100_primary": q2(D("-100.00") * config.primary_ratio),  # -55.56
        "refund_30_primary": q2(D("30.00") * config.primary_ratio),  # 16.67
        "claim_primary_owes": claim.primary_owes,  # 27.78
    }
    assert shares["shared_100_primary"] == D("-55.56")
    assert shares["refund_30_primary"] == D("16.67")
    assert shares["claim_primary_owes"] == D("27.78")
    return shares


# --------------------------------------------------------------------------- #
# period_metrics
# --------------------------------------------------------------------------- #


@requires_db
def test_macro_view(seeded_db: Session, config: AppConfig) -> None:
    seed_august(seeded_db, config)
    out = metrics.period_metrics(seeded_db, config, PERIOD)

    assert out.period_key == PERIOD
    macro = out.macro
    # Gross debits: 100 + 20. Refund not netted; transfers, settlement, salary and
    # the pending row are left out.
    assert macro.primary_accounts_burn == D("120.00")
    assert macro.partner_claims_burn == D("50.00")
    assert macro.household_burn == D("170.00")
    # by_category is gross like the headline (the refund is reported, not netted) plus
    # the claims, largest first, and adds up to it; income never appears in an expense view.
    assert [(c.category, c.amount) for c in macro.by_category] == [
        ("Groceries", D("100.00")),
        ("Partner claims", D("50.00")),
        ("Entertainment", D("20.00")),
    ]
    assert sum((c.amount for c in macro.by_category), D("0")) == macro.household_burn
    assert macro.refunds == D("30.00")
    assert macro.partner_claims_count == 1
    # Per person: the card is the primary's, so they paid its 120.00 gross; the secondary paid the
    # 50.00 claim. Bears: primary 55.56 + 20.00 - 16.67 + 27.78 (claim) = 86.67; secondary
    # 44.44 - 13.33 + 22.22 = 53.33 (the refund netted, the pending row left out).
    assert [(p.user_id, p.paid, p.bears) for p in macro.by_person] == [
        (config.primary_user_id, D("120.00"), D("86.67")),
        (config.secondary_user_id, D("50.00"), D("53.33")),
    ]
    for value in (macro.primary_accounts_burn, macro.partner_claims_burn, macro.household_burn, macro.refunds):
        assert _is_2dp(value)
    assert all(_is_2dp(c.amount) for c in macro.by_category)


@requires_db
def test_macro_rows_reconcile_with_the_headline(seeded_db: Session, config: AppConfig) -> None:
    """A category that only received a refund carries no burn; refunds are totalled, never deducted."""
    make_transaction(seeded_db, config, account_id=CARD, transaction_date=date(2026, 8, 3), amount="-80.00",
                     raw_description="WAITROSE 1234 LONDON", category="Groceries")
    make_transaction(seeded_db, config, account_id=CARD, transaction_date=date(2026, 8, 9), amount="15.00",
                     raw_description="WAITROSE REFUND", category="Groceries")
    make_transaction(seeded_db, config, account_id=CARD, transaction_date=date(2026, 8, 12), amount="68.00",
                     raw_description="RAIL FARE REFUND", category="Travel", claim_type="personal")
    # Neither income, settlement money nor a pending credit is a refund.
    make_transaction(seeded_db, config, account_id=CHECKING, transaction_date=date(2026, 8, 25), amount="4500.00",
                     raw_description="EMPLOYER SALARY", category="Income:Salary", claim_type="personal")
    make_transaction(seeded_db, config, account_id=CHECKING, transaction_date=date(2026, 8, 3), amount="1685.73",
                     raw_description="PARTNER TRANSFER CR", category="Transfers:Settlement", claim_type="personal")
    make_transaction(seeded_db, config, account_id=CARD, transaction_date=date(2026, 8, 20), amount="9.00",
                     raw_description="CINEWORLD REFUND", category="Entertainment", claim_type="personal",
                     review_status="pending_review")
    make_claim(seeded_db, config, claim_date=date(2026, 8, 10), amount="25.00", claim_type="shared_equal")

    macro = metrics.period_metrics(seeded_db, config, PERIOD).macro

    assert macro.primary_accounts_burn == D("80.00")
    assert macro.partner_claims_burn == D("25.00")
    assert macro.household_burn == D("105.00")
    assert [(c.category, c.amount) for c in macro.by_category] == [
        ("Groceries", D("80.00")),
        ("Partner claims", D("25.00")),
    ]
    assert sum((c.amount for c in macro.by_category), D("0")) == macro.household_burn
    assert macro.refunds == D("15.00") + D("68.00") == D("83.00")
    assert _is_2dp(macro.refunds)


@requires_db
def test_macro_without_claims_or_refunds(seeded_db: Session, config: AppConfig) -> None:
    make_transaction(seeded_db, config, account_id=CARD, transaction_date=date(2026, 8, 3), amount="-40.00",
                     category="Groceries")
    macro = metrics.period_metrics(seeded_db, config, PERIOD).macro
    assert macro.by_category == [CategoryAmount(category="Groceries", amount=D("40.00"))]
    assert macro.household_burn == D("40.00")
    assert macro.refunds == D("0.00")


@requires_db
def test_micro_view(seeded_db: Session, config: AppConfig) -> None:
    shares = seed_august(seeded_db, config)
    micro = metrics.period_metrics(seeded_db, config, PERIOD).micro

    # Σ -allocated_primary over approved, non-transfer, non-income rows: the shared
    # expense's primary share, the personal expense, minus the refund's share. The
    # salary credit is income, not an expense, so it never enters this view.
    expected_from_txns = -shares["shared_100_primary"] + D("20.00") - shares["refund_30_primary"]
    assert expected_from_txns == D("58.89")
    assert micro.from_transactions == expected_from_txns
    assert micro.from_partner_claims == shares["claim_primary_owes"] == D("27.78")
    assert micro.true_net_expense == D("58.89") + D("27.78") == D("86.67")

    groceries = -shares["shared_100_primary"] - shares["refund_30_primary"]  # 55.56 - 16.67
    assert [(c.category, c.amount) for c in micro.by_category] == [
        ("Groceries", groceries),
        ("Partner claims", D("27.78")),
        ("Entertainment", D("20.00")),
    ]
    assert groceries == D("38.89")
    assert all(_is_2dp(c.amount) for c in micro.by_category)


@requires_db
def test_liquidity_view_counts_every_status_and_transfers(seeded_db: Session, config: AppConfig) -> None:
    seed_august(seeded_db, config)
    liquidity = metrics.period_metrics(seeded_db, config, PERIOD).liquidity

    # Checking accounts only: salary + settlement in; card payment + pending row out.
    # The secondary user's current account is configured but has no rows: listed with zeros.
    assert liquidity.credits == D("4500.00") + D("1685.73") == D("6185.73")
    assert liquidity.debits == D("3384.21") + D("50.00") == D("3434.21")
    assert liquidity.net_cash_flow == D("6185.73") - D("3434.21") == D("2751.52")
    assert liquidity.by_account == [
        {"account_id": CHECKING, "credits": D("6185.73"), "debits": D("3434.21"), "net": D("2751.52")},
        IDLE_OTHER_CHECKING,
    ]
    assert config.checking_account_ids() == [CHECKING, OTHER_CHECKING]
    assert all(_is_2dp(v) for v in (liquidity.credits, liquidity.debits, liquidity.net_cash_flow))


@requires_db
def test_liquidity_ignores_card_and_investment_accounts(seeded_db: Session, config: AppConfig) -> None:
    make_transaction(seeded_db, config, account_id=CARD, transaction_date=date(2026, 8, 3), amount="-40.00",
                     category="Groceries")
    make_transaction(seeded_db, config, account_id=INVEST, transaction_date=date(2026, 8, 4), amount="500.00",
                     category="Transfers:Investment", claim_type="personal", is_internal_transfer=True)
    liquidity = metrics.period_metrics(seeded_db, config, PERIOD).liquidity
    assert (liquidity.credits, liquidity.debits, liquidity.net_cash_flow) == (D("0.00"), D("0.00"), D("0.00"))
    assert liquidity.by_account == [
        {"account_id": CHECKING, "credits": D("0.00"), "debits": D("0.00"), "net": D("0.00")},
        IDLE_OTHER_CHECKING,
    ]


@requires_db
def test_rows_from_other_periods_are_not_counted(seeded_db: Session, config: AppConfig) -> None:
    seed_august(seeded_db, config)
    make_transaction(seeded_db, config, account_id=CARD, transaction_date=date(2026, 7, 31), amount="-999.00",
                     category="Travel", claim_type="personal")
    make_transaction(seeded_db, config, account_id=CHECKING, transaction_date=date(2026, 9, 1), amount="-1.00",
                     category="Fees:Bank", claim_type="personal")
    make_claim(seeded_db, config, claim_date=date(2026, 9, 1), amount="10.00")

    out = metrics.period_metrics(seeded_db, config, PERIOD)
    assert out.macro.primary_accounts_burn == D("120.00")
    assert out.macro.partner_claims_burn == D("50.00")
    assert out.liquidity.debits == D("3434.21")


@requires_db
def test_settled_claims_still_count(seeded_db: Session, config: AppConfig) -> None:
    make_claim(seeded_db, config, claim_date=date(2026, 8, 10), amount="10.00", claim_type="shared_equal",
               is_settled=True)
    make_claim(seeded_db, config, claim_date=date(2026, 8, 11), amount="20.00", claim_type="secondary_personal")
    out = metrics.period_metrics(seeded_db, config, PERIOD)
    assert out.macro.partner_claims_burn == D("30.00")
    assert out.macro.household_burn == D("30.00")
    assert out.macro.by_category == [CategoryAmount(category="Partner claims", amount=D("30.00"))]
    assert out.micro.from_partner_claims == D("5.00")
    assert out.micro.true_net_expense == D("5.00")
    assert out.micro.by_category == [CategoryAmount(category="Partner claims", amount=D("5.00"))]


@requires_db
def test_empty_and_missing_periods_return_zeros(seeded_db: Session, config: AppConfig) -> None:
    ensure_period(seeded_db, PERIOD)
    for key in (PERIOD, "2031-01"):
        out = metrics.period_metrics(seeded_db, config, key)
        assert out.period_key == key
        assert out.macro.household_burn == D("0.00")
        assert out.macro.primary_accounts_burn == D("0.00")
        assert out.macro.partner_claims_burn == D("0.00")
        assert out.macro.refunds == D("0.00")
        assert out.macro.by_category == []
        assert out.micro.true_net_expense == D("0.00")
        assert out.micro.from_transactions == D("0.00")
        assert out.micro.from_partner_claims == D("0.00")
        assert out.micro.by_category == []
        assert out.liquidity.credits == D("0.00")
        assert out.liquidity.debits == D("0.00")
        assert out.liquidity.net_cash_flow == D("0.00")
        assert out.liquidity.by_account == [
            {"account_id": CHECKING, "credits": D("0.00"), "debits": D("0.00"), "net": D("0.00")},
            IDLE_OTHER_CHECKING,
        ]


@requires_db
def test_closed_period_is_still_readable(seeded_db: Session, config: AppConfig) -> None:
    seed_august(seeded_db, config)
    close_period(seeded_db, PERIOD)
    out = metrics.period_metrics(seeded_db, config, PERIOD)
    assert out.macro.household_burn == D("170.00")


@requires_db
def test_malformed_period_key_is_rejected(seeded_db: Session, config: AppConfig) -> None:
    for bad in ("2026-13", "202608", "", "Aug 2026"):
        with pytest.raises(ValueError):
            metrics.period_metrics(seeded_db, config, bad)
    with pytest.raises(ValueError):
        metrics.trends(seeded_db, config, periods=2, ending="2026-00")


@requires_db
def test_unflushed_rows_are_counted(seeded_db: Session, config: AppConfig) -> None:
    """The service flushes first, so rows added by the caller are included."""
    ensure_period(seeded_db, PERIOD)
    seeded_db.add(
        Transaction(
            period_key=PERIOD,
            account_id=CARD,
            transaction_date=date(2026, 8, 6),
            raw_description="CINEWORLD",
            cleaned_merchant="Cineworld",
            amount=D("-20.99"),
            category="Entertainment",
            claim_type="personal",
            allocated_primary_amount=D("-20.99"),
            allocated_secondary_amount=D("0.00"),
            review_status="manual_approved",
        )
    )
    out = metrics.period_metrics(seeded_db, config, PERIOD)
    assert out.macro.primary_accounts_burn == D("20.99")
    assert out.micro.from_transactions == D("20.99")


# --------------------------------------------------------------------------- #
# trends
# --------------------------------------------------------------------------- #


@requires_db
def test_trends_are_oldest_first_with_zeros_for_empty_periods(seeded_db: Session, config: AppConfig) -> None:
    seed_august(seeded_db, config)
    # June has a little activity; July does not exist in ledger_periods at all.
    make_transaction(seeded_db, config, account_id=CARD, transaction_date=date(2026, 6, 15), amount="-10.00",
                     category="Dining", claim_type="personal")
    make_transaction(seeded_db, config, account_id=CHECKING, transaction_date=date(2026, 6, 16), amount="100.00",
                     category="Income:Other", claim_type="personal")
    # A refund: gross spend stays 10.00, net of refunds is 6.00.
    make_transaction(seeded_db, config, account_id=CARD, transaction_date=date(2026, 6, 20), amount="4.00",
                     category="Dining", claim_type="personal")

    points = metrics.trends(seeded_db, config, periods=3)
    assert [p.period_key for p in points] == ["2026-06", "2026-07", "2026-08"]

    june, july, august = points
    assert june.household_burn == D("10.00")
    assert june.household_net == D("6.00")
    assert july.household_net == D("0.00")
    assert (july.household_burn, july.true_net_expense, july.net_cash_flow) == (D("0.00"), D("0.00"), D("0.00"))
    assert (august.household_burn, august.true_net_expense, august.net_cash_flow) == (
        D("170.00"),
        D("86.67"),
        D("2751.52"),
    )
    for p in points:
        assert all(_is_2dp(v) for v in (p.household_burn, p.true_net_expense, p.net_cash_flow))


@requires_db
def test_trends_ending_defaults_to_latest_ledger_period(seeded_db: Session, config: AppConfig) -> None:
    ensure_period(seeded_db, "2026-03")
    ensure_period(seeded_db, "2025-11")  # created later but chronologically earlier
    points = metrics.trends(seeded_db, config, periods=2)
    assert [p.period_key for p in points] == ["2026-02", "2026-03"]


@requires_db
def test_trends_without_any_period_end_today(seeded_db: Session, config: AppConfig) -> None:
    today = period_key_for(datetime.now(UTC).date())
    points = metrics.trends(seeded_db, config, periods=2)
    assert [p.period_key for p in points] == [previous_period_key(today), today]


@requires_db
def test_trends_explicit_ending_crosses_year_boundary(seeded_db: Session, config: AppConfig) -> None:
    points = metrics.trends(seeded_db, config, periods=3, ending="2026-01")
    assert [p.period_key for p in points] == ["2025-11", "2025-12", "2026-01"]
    assert metrics.trends(seeded_db, config, periods=1, ending="2026-08")[0].period_key == "2026-08"
    assert metrics.trends(seeded_db, config, periods=0) == []


# --------------------------------------------------------------------------- #
# investment_summary
# --------------------------------------------------------------------------- #


def _mirror(db: Session, config: AppConfig, day: date, amount: str) -> None:
    make_transaction(db, config, account_id=INVEST, transaction_date=day, amount=amount,
                     raw_description="ROBINHOOD", category="Transfers:Investment",
                     claim_type="personal", review_status="auto_approved", is_internal_transfer=True,
                     classification_source="transfer")


def _view_row(db: Session, account_id: str) -> tuple[Decimal, ...]:
    row = db.execute(
        text(
            "SELECT total_deposits, total_withdrawals, net_invested_capital, realized_gain "
            "FROM investment_position WHERE account_id = :id"
        ),
        {"id": account_id},
    ).one()
    return tuple(D(str(v)) for v in row)


def _account_tuple(summary: InvestmentSummary, account_id: str) -> tuple[Decimal, ...]:
    acc = next(a for a in summary.accounts if a.account_id == account_id)
    return (acc.total_deposits, acc.total_withdrawals, acc.net_invested_capital, acc.realized_gain)


@requires_db
def test_investment_summary_matches_sql_view(seeded_db: Session, config: AppConfig) -> None:
    _mirror(seeded_db, config, date(2026, 6, 1), "500.00")
    _mirror(seeded_db, config, date(2026, 7, 1), "500.00")
    _mirror(seeded_db, config, date(2026, 8, 1), "-300.00")
    # A non-transfer row on the investment account (e.g. a fee) never counts.
    make_transaction(seeded_db, config, account_id=INVEST, transaction_date=date(2026, 8, 2), amount="-5.00",
                     raw_description="ACCOUNT FEE", category="Fees:Bank", claim_type="personal")

    summary = metrics.investment_summary(seeded_db, config)
    assert [a.account_id for a in summary.accounts] == [INVEST]
    expected = (D("1000.00"), D("300.00"), D("700.00"), D("0.00"))
    assert _account_tuple(summary, INVEST) == expected
    assert _view_row(seeded_db, INVEST) == expected
    assert (summary.total_deposits, summary.total_withdrawals) == (D("1000.00"), D("300.00"))
    assert (summary.net_invested_capital, summary.realized_gain) == (D("700.00"), D("0.00"))

    # Withdrawing more than was ever deposited realises the difference as a gain.
    _mirror(seeded_db, config, date(2026, 9, 1), "-900.00")
    summary = metrics.investment_summary(seeded_db, config)
    expected = (D("1000.00"), D("1200.00"), D("-200.00"), D("200.00"))
    assert _account_tuple(summary, INVEST) == expected
    assert _view_row(seeded_db, INVEST) == expected
    assert summary.realized_gain == D("200.00")
    assert summary.net_invested_capital == D("-200.00")
    assert all(_is_2dp(v) for v in expected)


@requires_db
def test_investment_summary_without_rows_is_zero(db: Session, config: AppConfig) -> None:
    """Accounts known only to the configuration (not yet in the database) are listed."""
    summary = metrics.investment_summary(db, config)
    assert [a.account_id for a in summary.accounts] == [INVEST]
    assert _account_tuple(summary, INVEST) == (D("0.00"), D("0.00"), D("0.00"), D("0.00"))
    assert summary.total_deposits == summary.total_withdrawals == D("0.00")
    assert summary.net_invested_capital == summary.realized_gain == D("0.00")


@requires_db
def test_investment_summary_includes_database_only_accounts_and_sums_per_account(
    seeded_db: Session, config: AppConfig
) -> None:
    seeded_db.add(
        Account(id="acc_invest_other", institution="Other", account_type="investment_cash",
                owner_user_id=config.primary_user_id, identifier_last4="OTHER")
    )
    seeded_db.flush()
    _mirror(seeded_db, config, date(2026, 6, 1), "1000.00")  # robinhood: 1000 in
    # The factory looks the account up in the configuration, so insert directly.
    for day, amount, fp in ((date(2026, 6, 2), "100.00", "other-in"), (date(2026, 7, 2), "-150.00", "other-out")):
        seeded_db.add(
            Transaction(
                period_key=ensure_period(seeded_db, period_key_for(day)).period_key,
                account_id="acc_invest_other",
                transaction_date=day,
                raw_description="OTHER BROKER",
                cleaned_merchant="Other Broker",
                amount=D(amount),
                category="Transfers:Investment",
                claim_type="personal",
                allocated_primary_amount=D(amount),
                allocated_secondary_amount=D("0.00"),
                review_status="auto_approved",
                is_internal_transfer=True,
                fingerprint=fp,
            )
        )

    summary = metrics.investment_summary(seeded_db, config)
    assert [a.account_id for a in summary.accounts] == [INVEST, "acc_invest_other"]
    assert _account_tuple(summary, INVEST) == (D("1000.00"), D("0.00"), D("1000.00"), D("0.00"))
    assert _account_tuple(summary, "acc_invest_other") == (D("100.00"), D("150.00"), D("-50.00"), D("50.00"))
    assert _view_row(seeded_db, "acc_invest_other") == (D("100.00"), D("150.00"), D("-50.00"), D("50.00"))
    # Totals are sums of the per-account figures: the other account's gain is not
    # hidden behind Robinhood's deposits.
    assert summary.total_deposits == D("1100.00")
    assert summary.total_withdrawals == D("150.00")
    assert summary.net_invested_capital == D("950.00")
    assert summary.realized_gain == D("50.00")


@requires_db
def test_year_adds_up_its_months_and_stops_at_the_newest(seeded_db: Session, config: AppConfig) -> None:
    seed_august(seeded_db, config)
    make_transaction(seeded_db, config, account_id=CARD, transaction_date=date(2026, 6, 15), amount="-10.00",
                     category="Dining", claim_type="personal")
    seeded_db.flush()

    year = metrics.year_metrics(seeded_db, config, 2026)
    june = metrics.period_metrics(seeded_db, config, "2026-06")
    august = metrics.period_metrics(seeded_db, config, "2026-08")

    # January to August: the newest month on record, not December.
    assert [p.period_key for p in year.months][0] == "2026-01"
    assert year.months[-1].period_key == "2026-08"
    assert year.totals.period_key == "2026"
    assert year.totals.macro.household_burn == june.macro.household_burn + august.macro.household_burn
    assert year.totals.micro.true_net_expense == june.micro.true_net_expense + august.micro.true_net_expense
    assert year.totals.liquidity.net_cash_flow == june.liquidity.net_cash_flow + august.liquidity.net_cash_flow
    dining = {c.category: c.amount for c in year.totals.macro.by_category}["Dining"]
    by_month = sum(
        (c.amount for m in (june, august) for c in m.macro.by_category if c.category == "Dining"), D("0.00")
    )
    assert dining == by_month
    assert [c.amount for c in year.totals.macro.by_category] == sorted(
        (c.amount for c in year.totals.macro.by_category), reverse=True
    )
    for person in year.totals.macro.by_person:
        months_paid = [p.paid for m in (june, august) for p in m.macro.by_person if p.user_id == person.user_id]
        assert person.paid == sum(months_paid, D("0.00"))
    # No 2025 month on record, so no year before to compare with.
    assert year.previous is None


@requires_db
def test_year_compares_with_the_year_before(seeded_db: Session, config: AppConfig) -> None:
    make_transaction(seeded_db, config, account_id=CARD, transaction_date=date(2025, 1, 3), amount="-30.00",
                     category="Dining", claim_type="personal")
    # After February, so outside the January-to-February comparison.
    make_transaction(seeded_db, config, account_id=CARD, transaction_date=date(2025, 11, 3), amount="-99.00",
                     category="Dining", claim_type="personal")
    make_transaction(seeded_db, config, account_id=CARD, transaction_date=date(2026, 2, 3), amount="-20.00",
                     category="Dining", claim_type="personal")
    seeded_db.flush()

    year = metrics.year_metrics(seeded_db, config, 2026)
    assert year.previous is not None
    assert (year.previous.period_key, year.previous.household_burn) == ("2025", D("30.00"))
    assert year.totals.macro.household_burn == D("20.00")
    # A past year runs to December.
    assert len(metrics.year_metrics(seeded_db, config, 2025).months) == 12


@requires_db
def test_year_endpoint(client, primary_headers, seeded_db: Session, config: AppConfig) -> None:
    seed_august(seeded_db, config)
    seeded_db.commit()
    resp = client.get("/api/metrics/year/2026", headers=primary_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["year"] == 2026 and body["totals"]["period_key"] == "2026"
    assert body["months"][-1]["period_key"] == "2026-08"
    assert client.get("/api/metrics/year/1999", headers=primary_headers).status_code == 422
