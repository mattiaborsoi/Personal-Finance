"""Tests for the dual-ledger allocation and settlement engine.

Pure-logic tests use the example configuration (100,000 / 80,000 incomes). DB tests
use ``seeded_db`` with rows inserted through ``tests.factories`` (whose allocations
are computed independently of the service under test).
"""

from __future__ import annotations

import random
import uuid
from datetime import date
from decimal import Decimal

import pytest

from app.config import CLAIM_TYPES, AppConfig, load_config_from_dict
from app.models import Account, Transaction
from app.services.settlement import allocate, claim_shares, compute_settlement, quantize
from tests.factories import ensure_period, make_claim, make_transaction

D = Decimal
PRIMARY = "user_primary"
SECONDARY = "user_secondary"
PERIOD = "2026-08"


def _config_from(split_strategy: str, rounding_decimals: int = 2) -> AppConfig:
    """Minimal configuration with the example incomes and the given strategy."""
    return load_config_from_dict(
        {
            "users": {
                "primary": {
                    "id": PRIMARY,
                    "display_name": "Primary User",
                    "base_salary_pa": 100000,
                    "additional_income_pa": 0,
                },
                "secondary": {"id": SECONDARY, "display_name": "Secondary User", "base_salary_pa": 80000},
            },
            "settlement": {"split_strategy": split_strategy, "rounding_decimals": rounding_decimals},
        }
    )


# --------------------------------------------------------------------------- #
# quantize
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("value", "decimals", "expected"),
    [
        ("2.345", 2, "2.35"),
        ("-2.345", 2, "-2.35"),
        ("-2.995", 2, "-3.00"),
        ("1.005", 2, "1.01"),
        ("0.004", 2, "0.00"),
        ("-0.005", 2, "-0.01"),
        ("2.5", 0, "3"),
        ("-2.5", 0, "-3"),
        ("1.23456", 4, "1.2346"),
        ("7", 2, "7.00"),
    ],
)
def test_quantize_rounds_half_up_away_from_zero(value: str, decimals: int, expected: str) -> None:
    result = quantize(D(value), decimals)
    assert result == D(expected)
    assert result.as_tuple().exponent == -decimals


def test_quantize_rejects_negative_decimals() -> None:
    with pytest.raises(ValueError):
        quantize(D("1"), -1)


# --------------------------------------------------------------------------- #
# Ratios and allocation
# --------------------------------------------------------------------------- #


def test_blueprint_ratios(config: AppConfig) -> None:
    assert config.settlement.split_strategy == "salary_proportional"
    assert config.primary_ratio == D(100000) / D(180000)
    assert quantize(config.primary_ratio, 6) == D("0.555556")
    assert quantize(config.secondary_ratio, 6) == D("0.444444")
    assert config.primary_ratio + config.secondary_ratio == 1


@pytest.mark.parametrize(
    ("amount", "expected_primary", "expected_secondary"),
    [
        ("0.01", "0.01", "0.00"),
        ("0.02", "0.01", "0.01"),
        ("-0.01", "-0.01", "0.00"),
        ("33.33", "18.52", "14.81"),
        ("-357.99", "-198.88", "-159.11"),
        ("-15.81", "-8.78", "-7.03"),
        ("0.00", "0.00", "0.00"),
    ],
)
def test_allocate_shared_proportional_edge_cases(
    config: AppConfig, amount: str, expected_primary: str, expected_secondary: str
) -> None:
    primary, secondary = allocate(D(amount), "shared_proportional", PRIMARY, config)
    assert (primary, secondary) == (D(expected_primary), D(expected_secondary))
    assert primary + secondary == D(amount)


def test_allocate_sums_to_amount_for_random_amounts(config: AppConfig) -> None:
    rng = random.Random(20260925)
    owners = (PRIMARY, SECONDARY)
    for _ in range(2000):
        pennies = rng.randint(-1_000_000, 1_000_000)
        amount = D(pennies).scaleb(-2)
        claim_type = rng.choice(CLAIM_TYPES)
        owner = rng.choice(owners)
        primary, secondary = allocate(amount, claim_type, owner, config)

        assert primary + secondary == amount
        assert primary.as_tuple().exponent == -2
        assert secondary.as_tuple().exponent == -2
        # Neither share may exceed the amount or flip its sign.
        assert abs(primary) <= abs(amount)
        assert abs(secondary) <= abs(amount)
        assert primary == 0 or (primary > 0) == (amount > 0)
        assert secondary == 0 or (secondary > 0) == (amount > 0)
        if claim_type == "shared_proportional":
            assert abs(primary - amount * config.primary_ratio) <= D("0.005")
        elif claim_type == "shared_equal":
            assert abs(primary - amount / 2) <= D("0.005")


def test_allocate_personal_is_borne_by_account_owner(config: AppConfig) -> None:
    assert allocate(D("-20.99"), "personal", PRIMARY, config) == (D("-20.99"), D("0.00"))
    assert allocate(D("-20.99"), "personal", SECONDARY, config) == (D("0.00"), D("-20.99"))


def test_allocate_one_sided_claim_types(config: AppConfig) -> None:
    assert allocate(D("-12.50"), "secondary_personal", PRIMARY, config) == (D("0.00"), D("-12.50"))
    assert allocate(D("-12.50"), "primary_personal", SECONDARY, config) == (D("-12.50"), D("0.00"))
    # Refunds keep the same routing.
    assert allocate(D("4.00"), "secondary_personal", PRIMARY, config) == (D("0.00"), D("4.00"))


def test_allocate_shared_equal_splits_in_half(config: AppConfig) -> None:
    assert allocate(D("-5.99"), "shared_equal", PRIMARY, config) == (D("-3.00"), D("-2.99"))
    assert allocate(D("-10.00"), "shared_equal", PRIMARY, config) == (D("-5.00"), D("-5.00"))


def test_allocate_rejects_unknown_claim_type_and_owner(config: AppConfig) -> None:
    with pytest.raises(ValueError):
        allocate(D("-1.00"), "split_somehow", PRIMARY, config)
    with pytest.raises(ValueError):
        allocate(D("-1.00"), "personal", "user_nobody", config)


def test_equal_50_50_strategy() -> None:
    cfg = _config_from("equal_50_50")
    assert cfg.primary_ratio == D("0.5")
    assert cfg.secondary_ratio == D("0.5")
    assert allocate(D("-20.01"), "shared_proportional", PRIMARY, cfg) == (D("-10.01"), D("-10.00"))
    assert allocate(D("-20.00"), "shared_proportional", PRIMARY, cfg) == (D("-10.00"), D("-10.00"))
    # Under this strategy proportional and equal splits coincide.
    assert allocate(D("-33.33"), "shared_proportional", PRIMARY, cfg) == allocate(
        D("-33.33"), "shared_equal", PRIMARY, cfg
    )


def test_rounding_decimals_is_honoured() -> None:
    cfg = _config_from("salary_proportional", rounding_decimals=3)
    primary, secondary = allocate(D("-15.810"), "shared_proportional", PRIMARY, cfg)
    assert primary == D("-8.783")
    assert secondary == D("-7.027")
    assert primary + secondary == D("-15.810")


# --------------------------------------------------------------------------- #
# claim_shares
# --------------------------------------------------------------------------- #


def test_claim_shares_shared_proportional(config: AppConfig) -> None:
    assert claim_shares(D("50.00"), "shared_proportional", SECONDARY, config) == (D("27.78"), D("22.22"))
    assert claim_shares(D("50.00"), "shared_proportional", PRIMARY, config) == (D("27.78"), D("22.22"))


def test_claim_shares_shared_equal(config: AppConfig) -> None:
    assert claim_shares(D("10.01"), "shared_equal", PRIMARY, config) == (D("5.01"), D("5.00"))


def test_claim_shares_one_sided(config: AppConfig) -> None:
    assert claim_shares(D("40.00"), "primary_personal", SECONDARY, config) == (D("40.00"), D("0.00"))
    assert claim_shares(D("40.00"), "secondary_personal", PRIMARY, config) == (D("0.00"), D("40.00"))


def test_claim_shares_personal_is_borne_by_payer(config: AppConfig) -> None:
    assert claim_shares(D("7.00"), "personal", SECONDARY, config) == (D("0.00"), D("7.00"))
    assert claim_shares(D("7.00"), "personal", PRIMARY, config) == (D("7.00"), D("0.00"))


def test_claim_shares_are_non_negative_and_sum(config: AppConfig) -> None:
    rng = random.Random(7)
    for _ in range(500):
        amount = D(rng.randint(0, 100_000)).scaleb(-2)
        claim_type = rng.choice(CLAIM_TYPES)
        paid_by = rng.choice((PRIMARY, SECONDARY))
        primary_owes, secondary_owes = claim_shares(amount, claim_type, paid_by, config)
        assert primary_owes >= 0
        assert secondary_owes >= 0
        assert primary_owes + secondary_owes == amount


def test_claim_shares_rejects_negative_amount(config: AppConfig) -> None:
    with pytest.raises(ValueError):
        claim_shares(D("-1.00"), "shared_proportional", SECONDARY, config)


# --------------------------------------------------------------------------- #
# compute_settlement (database)
# --------------------------------------------------------------------------- #


def _assert_identity(summary) -> None:
    """The four sums must reproduce the net exactly and the lines must agree."""
    assert summary.net_owed_by_secondary == (
        summary.secondary_share_of_primary_paid_shared
        - summary.primary_share_of_secondary_paid_shared
        + summary.secondary_personal_on_primary_paid
        - summary.primary_personal_on_secondary_paid
    )
    assert sum((line.effect_on_secondary_owes for line in summary.lines), D(0)) == summary.net_owed_by_secondary
    assert all(line.effect_on_secondary_owes != 0 for line in summary.lines)
    assert [line.date for line in summary.lines] == sorted(line.date for line in summary.lines)


def test_missing_period_returns_zeros(seeded_db, config: AppConfig) -> None:
    summary = compute_settlement(seeded_db, "2031-01", config)
    assert summary.period_key == "2031-01"
    assert summary.primary_user_id == PRIMARY
    assert summary.secondary_user_id == SECONDARY
    assert summary.primary_ratio == config.primary_ratio
    assert summary.secondary_ratio == config.secondary_ratio
    assert summary.net_owed_by_secondary == D("0.00")
    assert summary.secondary_share_of_primary_paid_shared == D("0.00")
    assert summary.primary_share_of_secondary_paid_shared == D("0.00")
    assert summary.secondary_personal_on_primary_paid == D("0.00")
    assert summary.primary_personal_on_secondary_paid == D("0.00")
    assert summary.settlement_payments_received == D("0.00")
    assert summary.pending_review_count == 0
    assert summary.unsettled_claim_count == 0
    assert summary.lines == []


def test_empty_period_returns_zeros(seeded_db, config: AppConfig) -> None:
    ensure_period(seeded_db, PERIOD)
    summary = compute_settlement(seeded_db, PERIOD, config)
    assert summary.net_owed_by_secondary == D("0.00")
    assert summary.lines == []


def test_credit_adjustment_reduces_shared_debt(seeded_db, config: AppConfig) -> None:
    """A -20.00 shared expense plus a +5.00 refund on the primary card: the
    secondary's debt is the share of the net -15.00 cost."""
    make_transaction(seeded_db, config, account_id="acc_cc_amex", amount="-20.00", claim_type="shared_proportional")
    make_transaction(
        seeded_db,
        config,
        account_id="acc_cc_amex",
        amount="5.00",
        claim_type="shared_proportional",
        raw_description="WAITROSE REFUND",
        transaction_date=date(2026, 8, 20),
    )
    summary = compute_settlement(seeded_db, PERIOD, config)

    assert summary.secondary_share_of_primary_paid_shared == D("8.89") - D("2.22")
    assert summary.net_owed_by_secondary == D("6.67")
    _, net_secondary_share = allocate(D("-15.00"), "shared_proportional", PRIMARY, config)
    assert summary.net_owed_by_secondary == -net_secondary_share
    assert [line.effect_on_secondary_owes for line in summary.lines] == [D("8.89"), D("-2.22")]
    assert all(line.paid_by == PRIMARY for line in summary.lines)
    _assert_identity(summary)


def test_personal_on_supplementary_card_is_owed_by_secondary(seeded_db, config: AppConfig) -> None:
    """The secondary user spends on the supplementary card, which the primary user
    pays: a personal item there is entirely the secondary's and they owe it back."""
    txn = make_transaction(
        seeded_db,
        config,
        account_id="acc_cc_amex_supp",
        amount="-30.00",
        claim_type="personal",
        category="Health:Gym",
        raw_description="THIRD SPACE",
    )
    assert (txn.allocated_primary_amount, txn.allocated_secondary_amount) == (D("0.00"), D("-30.00"))

    summary = compute_settlement(seeded_db, PERIOD, config)
    assert summary.secondary_personal_on_primary_paid == D("30.00")
    assert summary.secondary_share_of_primary_paid_shared == D("0.00")
    assert summary.net_owed_by_secondary == D("30.00")
    (line,) = summary.lines
    assert line.source == "transaction"
    assert line.id == txn.id
    assert line.paid_by == PRIMARY
    assert line.amount == D("-30.00")
    assert (line.primary_share, line.secondary_share) == (D("0.00"), D("-30.00"))
    assert line.effect_on_secondary_owes == D("30.00")
    _assert_identity(summary)


def test_personal_on_primary_card_has_no_effect(seeded_db, config: AppConfig) -> None:
    make_transaction(seeded_db, config, account_id="acc_cc_amex", amount="-20.99", claim_type="personal")
    summary = compute_settlement(seeded_db, PERIOD, config)
    assert summary.net_owed_by_secondary == D("0.00")
    assert summary.lines == []


def test_secondary_personal_on_primary_card(seeded_db, config: AppConfig) -> None:
    make_transaction(
        seeded_db,
        config,
        account_id="acc_cc_amex",
        amount="-12.50",
        claim_type="secondary_personal",
        category="Health:Pharmacy",
    )
    summary = compute_settlement(seeded_db, PERIOD, config)
    assert summary.secondary_personal_on_primary_paid == D("12.50")
    assert summary.net_owed_by_secondary == D("12.50")
    assert summary.lines[0].claim_type == "secondary_personal"
    _assert_identity(summary)


def test_primary_personal_claim_paid_by_secondary(seeded_db, config: AppConfig) -> None:
    claim = make_claim(seeded_db, config, amount="40.00", claim_type="primary_personal", paid_by=SECONDARY)
    summary = compute_settlement(seeded_db, PERIOD, config)

    assert summary.primary_personal_on_secondary_paid == D("40.00")
    assert summary.net_owed_by_secondary == D("-40.00")
    assert summary.unsettled_claim_count == 1
    (line,) = summary.lines
    assert line.source == "claim"
    assert line.id == claim.id
    assert line.paid_by == SECONDARY
    # Claims are presented in ledger sign: a cost is negative.
    assert line.amount == D("-40.00")
    assert (line.primary_share, line.secondary_share) == (D("-40.00"), D("0.00"))
    assert line.effect_on_secondary_owes == D("-40.00")
    _assert_identity(summary)


def test_shared_claim_paid_by_secondary_reduces_net(seeded_db, config: AppConfig) -> None:
    make_transaction(seeded_db, config, account_id="acc_cc_amex", amount="-15.81", claim_type="shared_proportional")
    make_claim(seeded_db, config, amount="50.00", claim_type="shared_proportional", paid_by=SECONDARY)
    summary = compute_settlement(seeded_db, PERIOD, config)

    assert summary.secondary_share_of_primary_paid_shared == D("7.03")
    assert summary.primary_share_of_secondary_paid_shared == D("27.78")
    assert summary.net_owed_by_secondary == D("7.03") - D("27.78")
    claim_line = next(line for line in summary.lines if line.source == "claim")
    assert (claim_line.primary_share, claim_line.secondary_share) == (D("-27.78"), D("-22.22"))
    assert claim_line.effect_on_secondary_owes == D("-27.78")
    _assert_identity(summary)


def test_shared_claim_paid_by_primary_increases_net(seeded_db, config: AppConfig) -> None:
    make_claim(seeded_db, config, amount="10.01", claim_type="shared_equal", paid_by=PRIMARY)
    summary = compute_settlement(seeded_db, PERIOD, config)
    assert summary.secondary_share_of_primary_paid_shared == D("5.00")
    assert summary.net_owed_by_secondary == D("5.00")
    _assert_identity(summary)


def test_personal_claim_has_no_effect_but_counts_as_unsettled(seeded_db, config: AppConfig) -> None:
    make_claim(seeded_db, config, amount="7.00", claim_type="personal", paid_by=SECONDARY)
    summary = compute_settlement(seeded_db, PERIOD, config)
    assert summary.net_owed_by_secondary == D("0.00")
    assert summary.lines == []
    assert summary.unsettled_claim_count == 1


def test_account_outside_config_falls_back_to_row_owner(seeded_db, config: AppConfig) -> None:
    """An account only present in the database is settled by its recorded owner."""
    seeded_db.add(
        Account(
            id="acc_checking_secondary",
            institution="Monzo",
            account_type="checking",
            owner_user_id=SECONDARY,
            identifier_last4="0001",
        )
    )
    ensure_period(seeded_db, PERIOD)
    primary_share, secondary_share = allocate(D("-10.00"), "shared_proportional", SECONDARY, config)
    seeded_db.add(
        Transaction(
            period_key=PERIOD,
            account_id="acc_checking_secondary",
            transaction_date=date(2026, 8, 5),
            raw_description="TESCO STORES",
            cleaned_merchant="Tesco",
            amount=D("-10.00"),
            category="Groceries",
            claim_type="shared_proportional",
            allocated_primary_amount=primary_share,
            allocated_secondary_amount=secondary_share,
            review_status="auto_approved",
            fingerprint=uuid.uuid4().hex,
        )
    )
    # Deliberately not flushed: compute_settlement flushes pending rows itself.
    summary = compute_settlement(seeded_db, PERIOD, config)

    assert summary.primary_share_of_secondary_paid_shared == D("5.56")
    assert summary.net_owed_by_secondary == D("-5.56")
    (line,) = summary.lines
    assert line.paid_by == SECONDARY
    _assert_identity(summary)


def test_end_to_end_period_settlement(seeded_db, config: AppConfig) -> None:
    """Blueprint fixtures 1 and 2 plus partner claims, with every exclusion rule
    exercised: pending review, internal transfers, Transfers:* categories, other
    periods, zero-effect items."""
    # --- primary card (paid by primary) ------------------------------------
    make_transaction(  # personal on own card: no effect
        seeded_db, config, account_id="acc_cc_amex", transaction_date=date(2026, 7, 31), amount="-20.99",
        raw_description="CINEWORLD", category="Entertainment", claim_type="personal", period_key=PERIOD,
    )
    make_transaction(  # +7.03
        seeded_db, config, account_id="acc_cc_amex", transaction_date=date(2026, 8, 15), amount="-15.81",
        raw_description="WAITROSE", category="Groceries", claim_type="shared_proportional",
    )
    make_transaction(  # refund: -159.11
        seeded_db, config, account_id="acc_cc_amex", transaction_date=date(2026, 8, 24), amount="357.99",
        raw_description="BRITISH AIRWAYS", category="Travel", claim_type="shared_proportional",
        review_status="auto_approved",
    )
    make_transaction(  # +12.50 (bucket 3)
        seeded_db, config, account_id="acc_cc_amex", transaction_date=date(2026, 8, 18), amount="-12.50",
        raw_description="BOOTS", category="Health:Pharmacy", claim_type="secondary_personal",
    )
    # --- supplementary card (spent by secondary, paid by primary) ----------
    make_transaction(  # +7.29
        seeded_db, config, account_id="acc_cc_amex_supp", transaction_date=date(2026, 7, 28), amount="-16.40",
        raw_description="WAITROSE", category="Groceries", claim_type="shared_proportional", period_key=PERIOD,
    )
    make_transaction(  # +2.99 (shared_equal, -5.99 -> -3.00 / -2.99)
        seeded_db, config, account_id="acc_cc_amex_supp", transaction_date=date(2026, 8, 7), amount="-5.99",
        raw_description="NETFLIX", category="Subscriptions:Entertainment", claim_type="shared_equal",
    )
    make_transaction(  # +30.00 (bucket 3: personal, owner secondary, payer primary)
        seeded_db, config, account_id="acc_cc_amex_supp", transaction_date=date(2026, 8, 9), amount="-30.00",
        raw_description="THIRD SPACE", category="Health:Gym", claim_type="personal",
    )
    # --- checking account (paid by primary) --------------------------------
    make_transaction(  # +38.79
        seeded_db, config, account_id="acc_checking_hsbc", transaction_date=date(2026, 8, 3), amount="-87.27",
        raw_description="NORTHWIND ENERGY", category="Bills:Energy", claim_type="shared_proportional",
        review_status="auto_approved",
    )
    make_transaction(  # internal transfer: excluded
        seeded_db, config, account_id="acc_checking_hsbc", transaction_date=date(2026, 7, 28), amount="-3384.21",
        raw_description="HSBC CARD PYMT", category="Transfers:Internal", claim_type="personal",
        is_internal_transfer=True, review_status="auto_approved", period_key=PERIOD,
    )
    make_transaction(  # settlement money received: excluded from lines, reported separately
        seeded_db, config, account_id="acc_checking_hsbc", transaction_date=date(2026, 8, 3), amount="1685.73",
        raw_description="PARTNER TRANSFER CR", category="Transfers:Settlement", claim_type="personal",
        review_status="auto_approved",
    )
    make_transaction(  # Transfers:* category (even when not flagged internal): excluded
        seeded_db, config, account_id="acc_checking_hsbc", transaction_date=date(2026, 8, 20), amount="-500.00",
        raw_description="ROBINHOOD", category="Transfers:Investment", claim_type="personal",
        review_status="auto_approved",
    )
    make_transaction(  # pending review: excluded, counted
        seeded_db, config, account_id="acc_checking_hsbc", transaction_date=date(2026, 8, 21), amount="-40.00",
        raw_description="DISHOOM", category="Dining", claim_type="shared_proportional",
        review_status="pending_review",
    )
    make_transaction(  # pending internal transfer: neither settled nor counted as pending
        seeded_db, config, account_id="acc_checking_hsbc", transaction_date=date(2026, 8, 22), amount="-100.00",
        raw_description="AMEX PAYMENT", category="Transfers:Internal", claim_type="personal",
        is_internal_transfer=True, review_status="pending_review",
    )
    make_transaction(  # pending settlement credit: not yet counted as received, not pending either
        seeded_db, config, account_id="acc_checking_hsbc", transaction_date=date(2026, 8, 23), amount="10.00",
        raw_description="PARTNER TRANSFER CR", category="Transfers:Settlement", claim_type="personal",
        review_status="pending_review",
    )
    make_transaction(  # another period: excluded
        seeded_db, config, account_id="acc_cc_amex", transaction_date=date(2026, 9, 2), amount="-50.00",
        raw_description="WAITROSE", category="Groceries", claim_type="shared_proportional",
    )
    # --- partner claims ------------------------------------------------------
    make_claim(  # -27.78 (bucket 2)
        seeded_db, config, claim_date=date(2026, 8, 10), amount="50.00", claim_type="shared_proportional",
        paid_by=SECONDARY,
    )
    make_claim(  # -40.00 (bucket 4)
        seeded_db, config, claim_date=date(2026, 8, 11), amount="40.00", claim_type="primary_personal",
        paid_by=SECONDARY,
    )
    make_claim(  # +5.00 (bucket 1; 10.01 -> 5.01 / 5.00)
        seeded_db, config, claim_date=date(2026, 8, 12), amount="10.01", claim_type="shared_equal", paid_by=PRIMARY
    )
    make_claim(  # personal borne by payer: no effect, still unsettled
        seeded_db, config, claim_date=date(2026, 8, 13), amount="7.00", claim_type="personal", paid_by=SECONDARY
    )
    make_claim(  # settled claims still count: -11.11 (bucket 2)
        seeded_db, config, claim_date=date(2026, 8, 14), amount="20.00", claim_type="shared_proportional",
        paid_by=SECONDARY, is_settled=True,
    )
    make_claim(  # another period: excluded
        seeded_db, config, claim_date=date(2026, 7, 14), amount="99.00", claim_type="shared_proportional",
        paid_by=SECONDARY,
    )

    summary = compute_settlement(seeded_db, PERIOD, config)

    assert summary.period_key == PERIOD
    assert summary.secondary_share_of_primary_paid_shared == (
        D("7.03") - D("159.11") + D("7.29") + D("2.99") + D("38.79") + D("5.00")
    )
    assert summary.secondary_share_of_primary_paid_shared == D("-98.01")
    assert summary.primary_share_of_secondary_paid_shared == D("27.78") + D("11.11")
    assert summary.secondary_personal_on_primary_paid == D("12.50") + D("30.00")
    assert summary.primary_personal_on_secondary_paid == D("40.00")
    assert summary.net_owed_by_secondary == D("-98.01") - D("38.89") + D("42.50") - D("40.00")
    assert summary.net_owed_by_secondary == D("-134.40")
    assert summary.settlement_payments_received == D("1685.73")
    assert summary.pending_review_count == 1
    assert summary.unsettled_claim_count == 4
    _assert_identity(summary)

    assert len(summary.lines) == 11
    assert sum(1 for line in summary.lines if line.source == "transaction") == 7
    assert sum(1 for line in summary.lines if line.source == "claim") == 4
    merchants = {line.merchant for line in summary.lines}
    assert "Cineworld" not in merchants
    assert "Hsbc Card Pymt" not in merchants
    assert "Partner Transfer Cr" not in merchants
    assert "Robinhood" not in merchants
    assert "Dishoom" not in merchants
    assert summary.lines[0].date == date(2026, 7, 28)
    assert summary.lines[-1].date == date(2026, 8, 24)
    assert {line.paid_by for line in summary.lines if line.source == "transaction"} == {PRIMARY}


def test_other_period_is_independent(seeded_db, config: AppConfig) -> None:
    make_transaction(seeded_db, config, account_id="acc_cc_amex", amount="-15.81", claim_type="shared_proportional")
    make_claim(seeded_db, config, claim_date=date(2026, 7, 10), amount="50.00", paid_by=SECONDARY)

    august = compute_settlement(seeded_db, PERIOD, config)
    july = compute_settlement(seeded_db, "2026-07", config)
    assert august.net_owed_by_secondary == D("7.03")
    assert july.net_owed_by_secondary == D("-27.78")
    assert july.unsettled_claim_count == 1
    assert august.unsettled_claim_count == 0
