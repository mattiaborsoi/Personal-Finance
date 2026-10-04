"""Subscriptions and price rises: cadence, similar amounts, changes, new and stopped (no AI)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.services import subscriptions
from app.services.subscriptions import Charge, cadence_of, detect
from tests.conftest import requires_db
from tests.factories import make_transaction

D = Decimal


SUBS = "Subscriptions:Entertainment"


def charges(merchant: str, days: list[date], amounts: list[str], category: str = SUBS):
    pairs = zip(days, amounts, strict=True)
    return [Charge(day=d, amount=D(a), category=category, merchant=merchant) for d, a in pairs]


def spend(db, config, day: str, amount: str, raw: str, merchant: str, category: str = SUBS, **extra):
    return make_transaction(
        db, config, transaction_date=date.fromisoformat(day), amount=amount, raw_description=raw,
        cleaned_merchant=merchant, category=category, **extra,
    )  # fmt: skip


def test_cadence_monthly_yearly_and_none() -> None:
    monthly = [date(2026, 5, 3), date(2026, 6, 3), date(2026, 7, 2), date(2026, 8, 5)]
    assert cadence_of(monthly) == "monthly"
    assert cadence_of([date(2025, 3, 1), date(2026, 3, 2)]) == "yearly"
    assert cadence_of([date(2026, 5, 3), date(2026, 6, 3)]) is None  # two charges are not a monthly pattern yet
    weekly = [date(2026, 5, 1), date(2026, 5, 8), date(2026, 5, 15), date(2026, 5, 22)]
    assert cadence_of(weekly) is None
    assert cadence_of([date(2026, 5, 1)]) is None


def test_detect_flags_a_price_rise_in_the_month_it_happened() -> None:
    days = [date(2026, 6, 10), date(2026, 7, 10), date(2026, 8, 10), date(2026, 9, 10)]
    found = detect(charges("Netflix", days, ["10.99", "10.99", "10.99", "12.99"]), as_of=date(2026, 9, 20))
    assert found is not None
    assert (found.cadence, found.status, found.charges) == ("monthly", "active", 4)
    assert (found.amount, found.monthly_cost) == (D("12.99"), D("12.99"))
    assert found.change is not None
    assert (found.change.from_amount, found.change.to_amount, found.change.month) == (D("10.99"), D("12.99"), "2026-09")
    assert found.next_expected == date(2026, 10, 10)


def test_pennies_of_drift_are_not_a_price_change() -> None:
    days = [date(2026, 6, 1), date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)]
    as_of = date(2026, 9, 20)
    # 22p on a phone bill, 4p of exchange rate on software: under £1, so not flagged.
    assert detect(charges("Phone Co", days, ["32.22", "32.22", "32.22", "32.00"]), as_of=as_of).change is None
    assert detect(charges("Soft Co", days, ["13.24", "13.24", "13.24", "13.28"]), as_of=as_of).change is None
    # £1 or more but under 1% of a large bill: not flagged either.
    big = detect(charges("Lender", days, ["1650.00", "1650.00", "1650.00", "1655.00"]), as_of=as_of)
    assert big.change is None
    rise = detect(charges("Lender", days, ["1650.00", "1650.00", "1650.00", "1690.00"]), as_of=as_of)
    assert rise.change is not None and rise.change.to_amount == D("1690.00")


def test_bills_and_subscriptions_are_told_apart_by_category() -> None:
    days = [date(2026, 6, 1), date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)]
    as_of = date(2026, 9, 20)
    amounts = ["50.00"] * 4
    assert detect(charges("Water Co", days, amounts, "Bills:Water"), as_of=as_of).kind == "bill"
    assert detect(charges("Lender", days, amounts, "Housing:Mortgage"), as_of=as_of).kind == "bill"
    assert detect(charges("Gym", days, amounts, "Health:Gym"), as_of=as_of).kind == "subscription"
    assert detect(charges("Streamer", days, amounts), as_of=as_of).kind == "subscription"


def test_detect_new_stopped_and_yearly() -> None:
    days = [date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)]
    new = detect(charges("Gym", days, ["40.00"] * 3), as_of=date(2026, 9, 15))
    assert new is not None and new.status == "new" and new.change is None

    stopped = detect(charges("Gym", days, ["40.00"] * 3), as_of=date(2026, 11, 20))
    assert stopped is not None and stopped.status == "stopped"

    cloud = charges("Cloud", [date(2025, 2, 14), date(2026, 2, 15)], ["99.00", "99.00"])
    yearly = detect(cloud, as_of=date(2026, 9, 1))
    assert yearly is not None
    assert (yearly.cadence, yearly.monthly_cost, yearly.next_expected) == ("yearly", D("8.25"), date(2027, 2, 15))


def test_detect_rejects_varying_amounts() -> None:
    days = [date(2026, 6, 10), date(2026, 7, 11), date(2026, 8, 9)]
    assert detect(charges("Supermarket", days, ["12.00", "80.00", "45.00"]), as_of=date(2026, 8, 20)) is None


@requires_db
def test_find_subscriptions_reads_the_ledger(seeded_db, config) -> None:
    for day, amount in [("2026-05-07", "-10.99"), ("2026-06-07", "-10.99"), ("2026-07-07", "-12.99")]:
        spend(seeded_db, config, day, amount, "NETFLIX.COM", "Netflix", review_status="auto_approved")
    # A transfer is not a subscription (and it is the newest line, so it sets as_of).
    spend(seeded_db, config, "2026-07-09", "-25.00", "AMEX PAYMENT", "Amex", "Transfers:Internal",
          is_internal_transfer=True)  # fmt: skip
    for day in ("2026-05-01", "2026-06-01", "2026-07-01"):
        spend(seeded_db, config, day, "-70.00", "WAITROSE", "Waitrose", "Groceries")
    for day in ("2026-05-15", "2026-05-22", "2026-05-29", "2026-06-05"):
        spend(seeded_db, config, day, "-30.00", "TESCO", "Tesco", "Groceries")
    out = subscriptions.find_subscriptions(seeded_db)
    assert out.as_of == date(2026, 7, 9)
    assert [s.merchant for s in out.items] == ["Waitrose", "Netflix"]  # by monthly cost; weekly Tesco is not one
    netflix = out.items[1]
    assert netflix.change is not None and netflix.change.to_amount == D("12.99")
    assert out.total_monthly == D("82.99")


@requires_db
def test_subscriptions_endpoint(client, primary_headers, secondary_headers, seeded_db, config) -> None:
    for day in ("2026-05-07", "2026-06-07", "2026-07-07"):
        spend(seeded_db, config, day, "-5.99", "SPOTIFY", "Spotify")
    resp = client.get("/api/subscriptions", headers=primary_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total_monthly"] == "5.99" and body["as_of"] == "2026-07-07"
    assert body["items"][0]["merchant"] == "Spotify" and body["items"][0]["change"] is None
    assert client.get("/api/subscriptions", headers=secondary_headers).status_code == 403
