"""Tests for Agent 3 - the Auditor.

DB tests use ``seeded_db`` with rows inserted through ``tests.factories``. The
statistical step is exercised with the recurring-bill fixture (Northwind Energy at
£68.20 for three months, then £87.27) and the narrative step with the offline
``FakeLLMClient`` / ``NullLLMClient``.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.config import AppConfig, AppSection, AuditorSection
from app.models import AuditReport
from app.services import auditor
from app.services.llm import FakeLLMClient, NullLLMClient
from tests.conftest import requires_db
from tests.factories import ensure_period, make_transaction

D = Decimal
PERIOD = "2026-08"
JULY = "2026-07"
ENERGY_RAW = "NORTHWIND ENERGY DD REF 1234"
ENERGY = "Northwind Energy"
WATER_RAW = "CLEARWATER UTILITIES DD"
WATER = "Clearwater Utilities"


def _bill(
    db,
    config,
    *,
    month: int,
    amount: str,
    merchant: str = ENERGY,
    raw: str = ENERGY_RAW,
    category: str = "Bills:Energy",
    review_status: str = "auto_approved",
):
    """Insert one bill on the 3rd of *month* 2026 on the HSBC current account."""
    return make_transaction(
        db,
        config,
        account_id="acc_checking_hsbc",
        transaction_date=date(2026, month, 3),
        amount=amount,
        raw_description=raw,
        cleaned_merchant=merchant,
        category=category,
        review_status=review_status,
        classification_source="rule",
    )


def _water_bill(db, config, *, month: int, amount: str = "-60.00"):
    return _bill(db, config, month=month, amount=amount, merchant=WATER, raw=WATER_RAW, category="Bills:Water")


def _energy_history(db, config):
    """Fixture 3: £68.20 in May, June and July."""
    for month in (5, 6, 7):
        _bill(db, config, month=month, amount="-68.20")


def _first_statements(db, config):
    """A fresh install whose statements start in May, audited in July (look-back 3).

    Water is flat at £60; energy is £200, £218 then £213. April has no data at all, so
    the baseline must average June and May only: water £60 (not £40, "+50%") and
    energy £209 (not £139.33, "+53%").
    """
    for month, energy in ((5, "-200.00"), (6, "-218.00"), (7, "-213.00")):
        _bill(db, config, month=month, amount=energy)
        _water_bill(db, config, month=month)


def _with_lookback(config: AppConfig, lookback: int) -> AppConfig:
    return config.model_copy(update={"auditor": AuditorSection(lookback_periods=lookback)})


def _with_currency(config: AppConfig, code: str, symbol: str) -> AppConfig:
    return config.model_copy(update={"app": AppSection(base_currency=code, currency_symbol=symbol)})


# --------------------------------------------------------------------------- #
# Pure helpers
# --------------------------------------------------------------------------- #


def test_prior_period_keys_cross_year_boundary(config):
    assert auditor.prior_period_keys(config, "2026-02") == ["2026-01", "2025-12", "2025-11"]
    assert auditor.prior_period_keys(_with_lookback(config, 1), "2026-01") == ["2025-12"]


def test_prior_period_keys_rejects_bad_key(config):
    with pytest.raises(ValueError):
        auditor.prior_period_keys(config, "2026-13")


def test_system_prompt_states_the_currency(config):
    prompt = auditor.system_prompt(config)
    assert prompt.startswith(auditor.SYSTEM_PROMPT)
    assert "All amounts are in GBP; write them with the £ symbol" in prompt
    assert "All amounts are in EUR; write them with the € symbol" in auditor.system_prompt(
        _with_currency(config, "EUR", "€")
    )
    # The base prompt explains the baseline so the model does not invent a comparison.
    assert "baseline_periods" in auditor.SYSTEM_PROMPT


def test_foreign_currency_mentions(config):
    assert auditor.foreign_currency_mentions(config, "August spend was £1,234.56 (GBP), up 14%.") == []
    assert auditor.foreign_currency_mentions(config, "August spend was $212.00.") == ["$"]
    assert auditor.foreign_currency_mentions(config, "Spend was 212 usd, roughly 190 EUR or ¥30,000.") == [
        "¥",
        "USD",
        "EUR",
    ]
    # ISO codes only count as whole words.
    assert auditor.foreign_currency_mentions(config, "Travel across Europe rose on a Eurostar fare.") == []
    euro = _with_currency(config, "EUR", "€")
    assert auditor.foreign_currency_mentions(euro, "Spend was €50.00 (EUR).") == []
    assert auditor.foreign_currency_mentions(euro, "Spend was £50.00.") == ["£"]
    # A symbol that is part of the configured one is not foreign.
    dollars = _with_currency(config, "USD", "US$")
    assert auditor.foreign_currency_mentions(dollars, "Spend was US$50.00, or 50 USD.") == []


def test_deterministic_summary_wording(config):
    comparison = [
        auditor.CategoryComparisonOut(
            category="Groceries", current=D("1000.00"), baseline_average=D("900.00"), baseline_periods=3
        ),
        auditor.CategoryComparisonOut(
            category="Bills:Energy", current=D("234.56"), baseline_average=D("183.00"), baseline_periods=3
        ),
    ]
    anomalies = [
        auditor.AnomalyOut(
            merchant=ENERGY,
            issue="x",
            current_amount=D("87.27"),
            baseline_amount=D("68.20"),
            deviation=0.2796,
        )
    ]
    sentence = auditor.deterministic_summary(config, PERIOD, comparison, anomalies)
    assert sentence == (
        "August 2026 spend was £1,234.56, up 14.0% on the 3-month average; "
        "1 recurring bill deviated: Northwind Energy £87.27 vs £68.20 (+28.0%)."
    )


def test_deterministic_summary_without_history_or_anomalies(config):
    comparison = [auditor.CategoryComparisonOut(category="Dining", current=D("50.00"), baseline_average=D("0.00"))]
    sentence = auditor.deterministic_summary(config, PERIOD, comparison, [])
    assert sentence.startswith("August 2026 spend was £50.00, with no spend in the previous 3 months")
    assert sentence.endswith("no recurring bills deviated from their 3-month median.")
    assert auditor.deterministic_summary(config, PERIOD, [], []) == "August 2026 has no approved spend to audit."


def test_deterministic_summary_names_the_months_with_data(config):
    """Fewer prior months with data than the look-back: say how many, not "3-month average"."""
    two = [
        auditor.CategoryComparisonOut(
            category="Bills:Energy", current=D("213.00"), baseline_average=D("209.00"), baseline_periods=2
        ),
        auditor.CategoryComparisonOut(
            category="Bills:Water", current=D("60.00"), baseline_average=D("60.00"), baseline_periods=2
        ),
    ]
    assert auditor.deterministic_summary(config, JULY, two, []) == (
        "July 2026 spend was £273.00, up 1.5% on the average of the previous 2 months with data; "
        "no recurring bills deviated from their 3-month median."
    )
    one = [
        auditor.CategoryComparisonOut(
            category="Bills:Water", current=D("60.00"), baseline_average=D("60.00"), baseline_periods=1
        )
    ]
    assert auditor.deterministic_summary(config, "2026-06", one, []).startswith(
        "June 2026 spend was £60.00, in line with the only previous month with data;"
    )
    # A look-back of 1 with its single month present is still "the 1-month average".
    assert auditor.deterministic_summary(_with_lookback(config, 1), "2026-06", one, []).startswith(
        "June 2026 spend was £60.00, in line with the 1-month average;"
    )


def test_baseline_periods_is_zero_for_reports_stored_before_the_field_existed():
    old_row = auditor.CategoryComparisonOut.model_validate(
        {"category": "Groceries", "current": "10.00", "baseline_average": "9.00", "change_pct": 11.1}
    )
    assert old_row.baseline_periods == 0
    assert auditor.baseline_periods([old_row]) == 0
    assert auditor.baseline_periods([]) == 0


# --------------------------------------------------------------------------- #
# statistical_anomalies
# --------------------------------------------------------------------------- #


@requires_db
def test_fixture_3_flags_energy_supplier(seeded_db, config):
    _energy_history(seeded_db, config)
    august = _bill(seeded_db, config, month=8, amount="-87.27")

    anomalies = auditor.statistical_anomalies(seeded_db, config, PERIOD)

    assert len(anomalies) == 1
    a = anomalies[0]
    assert a.transaction_id == august.id
    assert a.merchant == ENERGY
    assert a.current_amount == D("87.27")
    assert a.baseline_amount == D("68.20")
    assert a.deviation == pytest.approx(0.2796, abs=0.0005)
    assert a.deviation > 0.27
    assert a.issue == "Price deviation: £87.27 vs 3-month median of £68.20 (+28.0%)"


@requires_db
def test_small_deviation_is_not_flagged(seeded_db, config):
    _energy_history(seeded_db, config)
    _bill(seeded_db, config, month=8, amount="-75.00")  # +10% < 15% threshold

    assert auditor.statistical_anomalies(seeded_db, config, PERIOD) == []


@requires_db
def test_merchant_seen_only_once_before_is_not_recurring(seeded_db, config):
    _bill(seeded_db, config, month=7, amount="-68.20")
    _bill(seeded_db, config, month=8, amount="-150.00")

    assert auditor.statistical_anomalies(seeded_db, config, PERIOD) == []


@requires_db
def test_two_of_three_prior_periods_is_recurring(seeded_db, config):
    _bill(seeded_db, config, month=5, amount="-68.20")
    _bill(seeded_db, config, month=7, amount="-68.20")
    _bill(seeded_db, config, month=8, amount="-87.27")

    anomalies = auditor.statistical_anomalies(seeded_db, config, PERIOD)

    assert [a.merchant for a in anomalies] == [ENERGY]
    assert anomalies[0].baseline_amount == D("68.20")


@requires_db
def test_lookback_window_excludes_older_periods(seeded_db, config):
    # Only February and March have history: outside the 3-month window for August.
    _bill(seeded_db, config, month=2, amount="-68.20")
    _bill(seeded_db, config, month=3, amount="-68.20")
    _bill(seeded_db, config, month=8, amount="-150.00")

    assert auditor.statistical_anomalies(seeded_db, config, PERIOD) == []


@requires_db
def test_lookback_of_one_requires_the_single_prior_period(seeded_db, config):
    _bill(seeded_db, config, month=7, amount="-68.20")
    _bill(seeded_db, config, month=8, amount="-87.27")

    anomalies = auditor.statistical_anomalies(seeded_db, _with_lookback(config, 1), PERIOD)

    assert len(anomalies) == 1
    assert anomalies[0].issue == "Price deviation: £87.27 vs 1-month median of £68.20 (+28.0%)"


@requires_db
def test_median_of_even_number_of_prior_totals(seeded_db, config):
    # Prior totals 60.00 and 76.40 -> median 68.20.
    _bill(seeded_db, config, month=6, amount="-60.00")
    _bill(seeded_db, config, month=7, amount="-76.40")
    _bill(seeded_db, config, month=8, amount="-87.27")

    anomalies = auditor.statistical_anomalies(seeded_db, config, PERIOD)

    assert anomalies[0].baseline_amount == D("68.20")


@requires_db
def test_current_period_charges_are_summed_and_largest_is_referenced(seeded_db, config):
    _energy_history(seeded_db, config)
    small = _bill(seeded_db, config, month=8, amount="-40.00")
    large = make_transaction(
        seeded_db,
        config,
        account_id="acc_checking_hsbc",
        transaction_date=date(2026, 8, 20),
        amount="-47.27",
        raw_description=ENERGY_RAW,
        cleaned_merchant=ENERGY,
        category="Bills:Energy",
        review_status="manual_approved",
    )

    anomalies = auditor.statistical_anomalies(seeded_db, config, PERIOD)

    assert len(anomalies) == 1
    assert anomalies[0].current_amount == D("87.27")
    assert anomalies[0].transaction_id == large.id != small.id


@requires_db
def test_prior_period_charges_are_summed(seeded_db, config):
    for month in (5, 6, 7):
        _bill(seeded_db, config, month=month, amount="-30.00")
        make_transaction(
            seeded_db,
            config,
            account_id="acc_checking_hsbc",
            transaction_date=date(2026, month, 18),
            amount="-38.20",
            raw_description=ENERGY_RAW,
            cleaned_merchant=ENERGY,
            category="Bills:Energy",
        )
    _bill(seeded_db, config, month=8, amount="-87.27")

    anomalies = auditor.statistical_anomalies(seeded_db, config, PERIOD)

    assert anomalies[0].baseline_amount == D("68.20")
    assert anomalies[0].current_amount == D("87.27")


@requires_db
def test_merchant_grouping_is_case_insensitive(seeded_db, config):
    for month in (5, 6, 7):
        _bill(seeded_db, config, month=month, amount="-68.20", merchant="northwind energy")
    _bill(seeded_db, config, month=8, amount="-87.27", merchant="NORTHWIND ENERGY ")

    anomalies = auditor.statistical_anomalies(seeded_db, config, PERIOD)

    assert len(anomalies) == 1
    assert anomalies[0].merchant == "NORTHWIND ENERGY "
    assert anomalies[0].current_amount == D("87.27")


@requires_db
def test_pending_review_transfers_and_credits_are_ignored(seeded_db, config):
    _energy_history(seeded_db, config)
    # Current-period charge still awaiting review: not spend yet.
    _bill(seeded_db, config, month=8, amount="-200.00", review_status="pending_review")
    # A refund is money in, never spend.
    _bill(seeded_db, config, month=8, amount="68.20")
    # A recurring internal transfer that jumps: excluded by the flag...
    for month in (5, 6, 7, 8):
        make_transaction(
            seeded_db,
            config,
            account_id="acc_checking_hsbc",
            transaction_date=date(2026, month, 1),
            amount="-500.00" if month < 8 else "-900.00",
            raw_description="ROBINHOOD",
            cleaned_merchant="Robinhood",
            category="Transfers:Investment",
            claim_type="personal",
            is_internal_transfer=True,
        )
    # ...and a recurring settlement-category row that jumps: excluded by the category prefix.
    for month in (5, 6, 7, 8):
        make_transaction(
            seeded_db,
            config,
            account_id="acc_checking_hsbc",
            transaction_date=date(2026, month, 2),
            amount="-100.00" if month < 8 else "-300.00",
            raw_description="HSBC CARD PYMT",
            cleaned_merchant="Card payment",
            category="Transfers:Internal",
            claim_type="personal",
        )

    assert auditor.statistical_anomalies(seeded_db, config, PERIOD) == []


@requires_db
def test_anomalies_sorted_by_absolute_deviation(seeded_db, config):
    _energy_history(seeded_db, config)
    _bill(seeded_db, config, month=8, amount="-87.27")  # +28.0%
    for month in (5, 6, 7):
        _bill(seeded_db, config, month=month, amount="-30.00", merchant="Fibreline", raw="FIBRELINE BROADBAND")
    _bill(seeded_db, config, month=8, amount="-15.00", merchant="Fibreline", raw="FIBRELINE BROADBAND")  # -50.0%

    anomalies = auditor.statistical_anomalies(seeded_db, config, PERIOD)

    assert [a.merchant for a in anomalies] == ["Fibreline", ENERGY]
    assert anomalies[0].deviation == pytest.approx(-0.5)
    assert "(-50.0%)" in anomalies[0].issue


@requires_db
def test_no_transactions_gives_no_anomalies(seeded_db, config):
    assert auditor.statistical_anomalies(seeded_db, config, PERIOD) == []


@requires_db
def test_flat_merchant_in_the_first_months_is_not_flagged(seeded_db, config):
    """Statements from May only: a £60 bill in May and June is not a deviation in July."""
    _first_statements(seeded_db, config)

    assert auditor.statistical_anomalies(seeded_db, config, JULY) == []


# --------------------------------------------------------------------------- #
# category_comparison
# --------------------------------------------------------------------------- #


def _groceries(db, config, month: int, amount: str, day: int = 10):
    return make_transaction(
        db,
        config,
        transaction_date=date(2026, month, day),
        amount=amount,
        raw_description="WAITROSE 1234 LONDON",
        cleaned_merchant="Waitrose",
        category="Groceries",
    )


@requires_db
def test_category_comparison_numbers(seeded_db, config):
    # Groceries: 100 / 200 / 300 -> average 200; August 250 -> +25%.
    _groceries(seeded_db, config, 5, "-100.00")
    _groceries(seeded_db, config, 6, "-200.00")
    _groceries(seeded_db, config, 7, "-300.00")
    _groceries(seeded_db, config, 8, "-150.00")
    _groceries(seeded_db, config, 8, "-100.00", day=20)
    # Bills:Energy: only two prior months (68.20 x2 -> average over 3 = 45.47), August 87.27.
    _bill(seeded_db, config, month=6, amount="-68.20")
    _bill(seeded_db, config, month=7, amount="-68.20")
    _bill(seeded_db, config, month=8, amount="-87.27")
    # Dining: no history.
    make_transaction(
        seeded_db,
        config,
        transaction_date=date(2026, 8, 12),
        amount="-50.00",
        raw_description="CAFE",
        category="Dining",
    )
    # Travel: history only, nothing in August.
    make_transaction(
        seeded_db,
        config,
        transaction_date=date(2026, 7, 12),
        amount="-90.00",
        raw_description="TRAIN",
        category="Travel",
    )
    # Ignored: pending review, credits, internal transfers, Transfers:* categories.
    make_transaction(
        seeded_db,
        config,
        transaction_date=date(2026, 8, 21),
        amount="-999.00",
        raw_description="PENDING SHOP",
        category="Shopping:Home",
        review_status="pending_review",
    )
    make_transaction(
        seeded_db,
        config,
        transaction_date=date(2026, 8, 22),
        amount="25.00",
        raw_description="REFUND",
        category="Groceries",
    )
    make_transaction(
        seeded_db,
        config,
        transaction_date=date(2026, 8, 23),
        amount="-400.00",
        raw_description="HSBC CARD PYMT",
        category="Transfers:Internal",
        claim_type="personal",
    )
    make_transaction(
        seeded_db,
        config,
        account_id="acc_checking_hsbc",
        transaction_date=date(2026, 8, 24),
        amount="-500.00",
        raw_description="ROBINHOOD",
        category="Transfers:Investment",
        claim_type="personal",
        is_internal_transfer=True,
    )

    rows = auditor.category_comparison(seeded_db, config, PERIOD)
    by_cat = {r.category: r for r in rows}

    assert [r.category for r in rows] == ["Groceries", "Bills:Energy", "Dining", "Travel"]
    # Groceries carry spend in all three prior months, so every category averages over 3.
    assert [r.baseline_periods for r in rows] == [3, 3, 3, 3]
    assert auditor.baseline_periods(rows) == 3
    groceries = by_cat["Groceries"]
    assert groceries.current == D("250.00")  # 150 + 100; the 25.00 refund is not spend
    assert groceries.baseline_average == D("200.00")
    assert groceries.change_pct == pytest.approx(25.0)
    energy = by_cat["Bills:Energy"]
    assert energy.current == D("87.27")
    assert energy.baseline_average == D("45.47")  # 136.40 / 3, rounded half up
    assert energy.change_pct == pytest.approx(float((D("87.27") - D("45.47")) / D("45.47") * 100))
    dining = by_cat["Dining"]
    assert (dining.current, dining.baseline_average, dining.change_pct) == (D("50.00"), D("0.00"), None)
    travel = by_cat["Travel"]
    assert (travel.current, travel.baseline_average) == (D("0.00"), D("30.00"))
    assert travel.change_pct == pytest.approx(-100.0)
    assert "Shopping:Home" not in by_cat
    assert not any(c.startswith("Transfers:") for c in by_cat)


@requires_db
def test_category_comparison_without_history(seeded_db, config):
    _groceries(seeded_db, config, 8, "-120.00")

    rows = auditor.category_comparison(seeded_db, config, PERIOD)

    assert len(rows) == 1
    assert rows[0].category == "Groceries"
    assert rows[0].current == D("120.00")
    assert rows[0].baseline_average == D("0.00")
    assert rows[0].change_pct is None
    assert rows[0].baseline_periods == 0


@requires_db
def test_category_comparison_averages_over_prior_periods_with_data(seeded_db, config):
    _first_statements(seeded_db, config)

    rows = auditor.category_comparison(seeded_db, config, JULY)
    by_cat = {r.category: r for r in rows}

    # April is inside the look-back window but has no statement: it is not a month of zero spend.
    assert [r.baseline_periods for r in rows] == [2, 2]
    water = by_cat["Bills:Water"]
    assert (water.current, water.baseline_average) == (D("60.00"), D("60.00"))  # not 120 / 3 = 40 (+50%)
    assert water.change_pct == pytest.approx(0.0)
    energy = by_cat["Bills:Energy"]
    assert (energy.current, energy.baseline_average) == (D("213.00"), D("209.00"))  # not 418 / 3 = 139.33 (+53%)
    assert energy.change_pct == pytest.approx(float(D("4.00") / D("209.00") * 100))


@requires_db
def test_category_missing_from_a_month_with_data_counts_as_zero(seeded_db, config):
    # Water in May and June, energy in June only: June and May carry data, so energy
    # averages 100 / 2 rather than 100 / 1.
    _water_bill(seeded_db, config, month=5)
    _water_bill(seeded_db, config, month=6)
    _bill(seeded_db, config, month=6, amount="-100.00")
    _water_bill(seeded_db, config, month=7)

    by_cat = {r.category: r for r in auditor.category_comparison(seeded_db, config, JULY)}

    assert by_cat["Bills:Energy"].baseline_average == D("50.00")
    assert by_cat["Bills:Energy"].current == D("0.00")
    assert by_cat["Bills:Water"].baseline_average == D("60.00")
    assert by_cat["Bills:Water"].baseline_periods == 2


@requires_db
def test_category_comparison_empty_period(seeded_db, config):
    assert auditor.category_comparison(seeded_db, config, PERIOD) == []


# --------------------------------------------------------------------------- #
# run_audit / latest_report
# --------------------------------------------------------------------------- #


def _fixture_3_with_groceries(db, config):
    _energy_history(db, config)
    august = _bill(db, config, month=8, amount="-87.27")
    for month in (5, 6, 7):
        _groceries(db, config, month, "-100.00")
    _groceries(db, config, 8, "-112.73")
    return august


@requires_db
def test_run_audit_uses_llm_sentence_and_sends_aggregates_only(seeded_db, config):
    august = _fixture_3_with_groceries(seeded_db, config)
    llm = FakeLLMClient(responses=[{"summary_sentence": "Energy jumped; groceries steady."}])

    report = auditor.run_audit(seeded_db, config, llm, PERIOD)

    assert report.period_key == PERIOD
    assert report.summary_sentence == "Energy jumped; groceries steady."
    assert report.created_at is not None
    assert [a.merchant for a in report.anomalies] == [ENERGY]
    assert report.anomalies[0].transaction_id == august.id
    assert [c.category for c in report.category_comparison] == ["Groceries", "Bills:Energy"]

    assert len(llm.calls) == 1
    system, user = llm.calls[0]["system"], llm.calls[0]["user"]
    assert system.lower().startswith("you are a personal finance auditor")
    assert "summary_sentence" in system
    payload = json.loads(user)
    assert payload["period_key"] == PERIOD
    assert payload["lookback_periods"] == 3
    assert payload["baseline_periods"] == 3
    assert payload["total_current_spend"] == "200.00"
    assert payload["total_baseline_average"] == "168.20"
    assert {c["category"]: c["current"] for c in payload["categories"]} == {
        "Groceries": "112.73",
        "Bills:Energy": "87.27",
    }
    assert payload["anomalies"] == [
        {"merchant": ENERGY, "current": "87.27", "baseline": "68.20", "deviation": pytest.approx(0.2796, abs=0.0005)}
    ]
    # Never individual line items: no raw descriptions, dates or transaction ids.
    assert ENERGY_RAW not in user
    assert "WAITROSE" not in user
    assert "Waitrose" not in user
    assert str(august.id) not in user
    assert "2026-08-03" not in user


@requires_db
def test_llm_prompt_and_payload_state_the_currency(seeded_db, config):
    _fixture_3_with_groceries(seeded_db, config)
    llm = FakeLLMClient(responses=[{"summary_sentence": "Energy jumped."}])

    auditor.run_audit(seeded_db, config, llm, PERIOD)

    system, payload = llm.calls[0]["system"], json.loads(llm.calls[0]["user"])
    assert system == auditor.system_prompt(config)
    assert "All amounts are in GBP; write them with the £ symbol" in system
    assert payload["currency"] == {"code": "GBP", "symbol": "£"}

    euro = _with_currency(config, "EUR", "€")
    llm = FakeLLMClient(responses=[{"summary_sentence": "Energy jumped."}])
    auditor.run_audit(seeded_db, euro, llm, PERIOD)
    assert "All amounts are in EUR; write them with the € symbol" in llm.calls[0]["system"]
    assert json.loads(llm.calls[0]["user"])["currency"] == {"code": "EUR", "symbol": "€"}


@requires_db
def test_run_audit_rejects_llm_sentence_quoting_another_currency(seeded_db, config, caplog):
    _fixture_3_with_groceries(seeded_db, config)
    fallback = "August 2026 spend was £200.00, up 18.9% on the 3-month average"

    for foreign, quoted in (
        ("August spend was $200.00, up 18.9% on the 3-month average.", "$"),
        ("August spend was 200 USD; Northwind Energy rose to 87.27 USD.", "USD"),
        ("August spend was €200.00 (about 170 GBP).", "€"),
    ):
        caplog.clear()
        llm = FakeLLMClient(responses=[{"summary_sentence": foreign}])
        with caplog.at_level(logging.WARNING, logger="app.services.auditor"):
            report = auditor.run_audit(seeded_db, config, llm, PERIOD)
        assert len(llm.calls) == 1
        assert report.summary_sentence.startswith(fallback)
        assert f"the LLM quoted {quoted} on a GBP ledger" in caplog.text

    # The configured currency, as symbol or code, is fine.
    accepted = "August spend was £200.00 (GBP), up 18.9%; Northwind Energy rose to £87.27."
    report = auditor.run_audit(seeded_db, config, FakeLLMClient(responses=[{"summary_sentence": accepted}]), PERIOD)
    assert report.summary_sentence == accepted

    # On a euro ledger the pound is the foreign one.
    euro = _with_currency(config, "EUR", "€")
    report = auditor.run_audit(seeded_db, euro, FakeLLMClient(responses=[{"summary_sentence": accepted}]), PERIOD)
    assert report.summary_sentence.startswith("August 2026 spend was €200.00, up 18.9%")
    report = auditor.run_audit(
        seeded_db, euro, FakeLLMClient(responses=[{"summary_sentence": "August spend was €200.00."}]), PERIOD
    )
    assert report.summary_sentence == "August spend was €200.00."


@requires_db
def test_llm_payload_counts_only_prior_periods_with_data(seeded_db, config):
    _first_statements(seeded_db, config)
    llm = FakeLLMClient(responses=[{"summary_sentence": "Steady."}])

    auditor.run_audit(seeded_db, config, llm, JULY)

    payload = json.loads(llm.calls[0]["user"])
    assert payload["lookback_periods"] == 3
    assert payload["baseline_periods"] == 2
    assert payload["total_current_spend"] == "273.00"
    assert payload["total_baseline_average"] == "269.00"
    assert {c["category"]: c["baseline_average"] for c in payload["categories"]} == {
        "Bills:Energy": "209.00",
        "Bills:Water": "60.00",
    }
    assert payload["anomalies"] == []


@requires_db
def test_llm_payload_says_there_is_no_baseline_without_history(seeded_db, config):
    _groceries(seeded_db, config, 8, "-120.00")
    llm = FakeLLMClient(responses=[{"summary_sentence": "First month."}])

    auditor.run_audit(seeded_db, config, llm, PERIOD)

    payload = json.loads(llm.calls[0]["user"])
    assert payload["baseline_periods"] == 0
    assert payload["total_baseline_average"] == "0.00"
    assert payload["categories"] == [
        {"category": "Groceries", "current": "120.00", "baseline_average": "0.00", "change_pct": None}
    ]


@requires_db
def test_run_audit_without_llm_uses_deterministic_sentence(seeded_db, config):
    _fixture_3_with_groceries(seeded_db, config)

    report = auditor.run_audit(seeded_db, config, NullLLMClient(), PERIOD)

    assert report.summary_sentence == (
        "August 2026 spend was £200.00, up 18.9% on the 3-month average; "
        "1 recurring bill deviated: Northwind Energy £87.27 vs £68.20 (+28.0%)."
    )
    assert len(report.anomalies) == 1


@requires_db
def test_run_audit_in_the_first_months_uses_the_months_with_data(seeded_db, config):
    _first_statements(seeded_db, config)

    report = auditor.run_audit(seeded_db, config, NullLLMClient(), JULY)

    assert report.summary_sentence == (
        "July 2026 spend was £273.00, up 1.5% on the average of the previous 2 months with data; "
        "no recurring bills deviated from their 3-month median."
    )
    assert report.anomalies == []
    assert all(c.baseline_periods == 2 for c in report.category_comparison)

    stored = auditor.latest_report(seeded_db, JULY)
    assert stored is not None
    assert [c.baseline_periods for c in stored.category_comparison] == [2, 2]


@requires_db
def test_reports_stored_before_baseline_periods_still_load(seeded_db, config):
    ensure_period(seeded_db, PERIOD)
    seeded_db.add(
        AuditReport(
            id=uuid.uuid4(),
            period_key=PERIOD,
            summary_sentence="Old report.",
            anomalies=[],
            category_comparison=[
                {"category": "Groceries", "current": "10.00", "baseline_average": "9.00", "change_pct": 11.1}
            ],
            created_at=datetime.now(UTC),
        )
    )
    seeded_db.flush()

    report = auditor.latest_report(seeded_db, PERIOD)

    assert report is not None
    assert report.summary_sentence == "Old report."
    assert report.category_comparison[0].baseline_average == D("9.00")
    assert report.category_comparison[0].baseline_periods == 0


@requires_db
def test_run_audit_falls_back_when_llm_fails(seeded_db, config):
    _fixture_3_with_groceries(seeded_db, config)
    llm = FakeLLMClient(fail=True)

    report = auditor.run_audit(seeded_db, config, llm, PERIOD)

    assert len(llm.calls) == 1
    assert report.summary_sentence.startswith("August 2026 spend was £200.00, up 18.9%")


@requires_db
def test_run_audit_falls_back_when_llm_response_is_off_contract(seeded_db, config):
    _fixture_3_with_groceries(seeded_db, config)

    report = auditor.run_audit(seeded_db, config, FakeLLMClient(responses=[{"summary": "wrong key"}]), PERIOD)
    assert report.summary_sentence.startswith("August 2026 spend was")

    report = auditor.run_audit(seeded_db, config, FakeLLMClient(responses=[{"summary_sentence": "   "}]), PERIOD)
    assert report.summary_sentence.startswith("August 2026 spend was")


@requires_db
def test_run_audit_persists_and_latest_report_returns_newest(seeded_db, config):
    august = _fixture_3_with_groceries(seeded_db, config)
    assert auditor.latest_report(seeded_db, PERIOD) is None

    first_llm = FakeLLMClient(responses=[{"summary_sentence": "First run."}])
    second_llm = FakeLLMClient(responses=[{"summary_sentence": "Second run."}])
    first = auditor.run_audit(seeded_db, config, first_llm, PERIOD)
    second = auditor.run_audit(seeded_db, config, second_llm, PERIOD)

    rows = seeded_db.scalars(select(AuditReport).where(AuditReport.period_key == PERIOD)).all()
    assert len(rows) == 2
    stored = next(r for r in rows if r.summary_sentence == "Second run.")
    # JSONB payloads are plain JSON: ids and money as strings, deviation as a number.
    json.dumps(stored.anomalies)
    json.dumps(stored.category_comparison)
    assert stored.anomalies[0]["transaction_id"] == str(august.id)
    assert stored.anomalies[0]["current_amount"] == "87.27"
    assert stored.anomalies[0]["baseline_amount"] == "68.20"
    assert isinstance(stored.anomalies[0]["deviation"], float)
    assert stored.category_comparison[0] == {
        "category": "Groceries",
        "current": "112.73",
        "baseline_average": "100.00",
        "change_pct": pytest.approx(12.73),
        "baseline_periods": 3,
    }

    latest = auditor.latest_report(seeded_db, PERIOD)
    assert latest is not None
    assert latest.summary_sentence == "Second run."
    assert latest.created_at == second.created_at
    assert latest.created_at > first.created_at
    assert latest.anomalies[0].transaction_id == august.id
    assert latest.anomalies[0].current_amount == D("87.27")
    assert latest.anomalies[0].baseline_amount == D("68.20")
    assert latest.category_comparison[1].current == D("87.27")
    assert auditor.latest_report(seeded_db, "2026-07") is None


@requires_db
def test_run_audit_on_empty_period(seeded_db, config):
    ensure_period(seeded_db, PERIOD)
    llm = FakeLLMClient(responses=[{"summary_sentence": "Nothing to report."}])

    report = auditor.run_audit(seeded_db, config, llm, PERIOD)

    assert report.anomalies == []
    assert report.category_comparison == []
    assert report.summary_sentence == "Nothing to report."
    assert json.loads(llm.calls[0]["user"])["categories"] == []
    assert auditor.latest_report(seeded_db, PERIOD) is not None

    offline = auditor.run_audit(seeded_db, config, NullLLMClient(), PERIOD)
    assert offline.summary_sentence == "August 2026 has no approved spend to audit."


@requires_db
def test_run_audit_creates_missing_period(seeded_db, config):
    report = auditor.run_audit(seeded_db, config, NullLLMClient(), "2025-11")

    assert report.period_key == "2025-11"
    assert report.summary_sentence == "November 2025 has no approved spend to audit."
    assert auditor.latest_report(seeded_db, "2025-11") is not None
