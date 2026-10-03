"""The running settlement balance: carry-over, payments both ways, checkpoints.

All data is synthetic. Items are ``secondary_personal`` spends on the primary's card
(or ``primary_personal`` claims paid by the secondary) so each month's net is a round
number that is easy to follow.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import func, select

from app.config import AppConfig
from app.models import LedgerPeriod, PartnerClaim, SettlementEntry, SettlementSnapshot
from app.services import reset as reset_service
from app.services.balance import compute_balance
from app.services.periods import close_period, delete_if_unreferenced, get_or_create_period
from app.services.settlement import compute_settlement
from app.services.settlement_snapshots import snapshot_settlement
from tests.factories import make_claim, make_transaction

D = Decimal
PRIMARY = "user_primary"
SECONDARY = "user_secondary"


def _spend(db, config, when: date, amount: str, **kw):
    """Secondary's personal item paid on the primary's card: net += amount."""
    return make_transaction(
        db, config, account_id="acc_cc_amex", transaction_date=when, amount=f"-{amount}",
        raw_description="SYNTHETIC SHOP", category="Shopping", claim_type="secondary_personal", **kw,
    )


def _settlement_line(db, config, when: date, amount: str, account_id: str = "acc_checking_hsbc", **kw):
    return make_transaction(
        db, config, account_id=account_id, transaction_date=when, amount=amount,
        raw_description="SYNTHETIC SETTLE", category="Transfers:Settlement", claim_type="personal", **kw,
    )


def _entry(db, kind: str, when: date, amount: str, paid_by: str | None = None, net_at: str | None = None):
    key = f"{when.year:04d}-{when.month:02d}"
    get_or_create_period(db, key)
    row = SettlementEntry(
        period_key=key, entry_date=when, kind=kind, amount=D(amount), paid_by=paid_by,
        net_at_checkpoint=D(net_at) if net_at is not None else None,
    )
    db.add(row)
    db.flush()
    return row


def _count(db, model) -> int:
    return int(db.scalar(select(func.count()).select_from(model)) or 0)


# --------------------------------------------------------------------------- #
# The walk
# --------------------------------------------------------------------------- #


def test_balance_carries_across_months_including_a_gap(seeded_db, config: AppConfig) -> None:
    _spend(seeded_db, config, date(2026, 6, 10), "100.00")
    _spend(seeded_db, config, date(2026, 8, 10), "50.00")  # July has no data and no period row
    assert seeded_db.get(LedgerPeriod, "2026-07") is None

    june = compute_balance(seeded_db, "2026-06", config)
    assert (june.carried_in, june.net, june.balance_out) == (D("0.00"), D("100.00"), D("100.00"))
    assert june.from_period == "2026-06"

    july = compute_balance(seeded_db, "2026-07", config)
    assert (july.carried_in, july.net, july.balance_out) == (D("100.00"), D("0.00"), D("100.00"))

    august = compute_balance(seeded_db, "2026-08", config)
    assert (august.carried_in, august.net, august.balance_out) == (D("100.00"), D("50.00"), D("150.00"))
    assert august.from_period == "2026-06"
    assert august.checkpoint is None and august.before_checkpoint is False

    before = compute_balance(seeded_db, "2026-01", config)
    assert (before.carried_in, before.balance_out, before.from_period) == (D("0.00"), D("0.00"), "2026-01")


def test_partial_payment_is_carried(seeded_db, config: AppConfig) -> None:
    _spend(seeded_db, config, date(2026, 6, 10), "300.00")
    _settlement_line(seeded_db, config, date(2026, 6, 28), "100.00")  # partner paid 100 into the primary's account
    june = compute_balance(seeded_db, "2026-06", config)
    assert june.payments_ledger == D("100.00")
    assert june.balance_out == D("200.00")
    july = compute_balance(seeded_db, "2026-07", config)
    assert july.carried_in == D("200.00") and july.balance_out == D("200.00")


def test_checkpoint_at_zero_starts_fresh(seeded_db, config: AppConfig) -> None:
    _spend(seeded_db, config, date(2026, 5, 10), "999.00")
    _spend(seeded_db, config, date(2026, 6, 10), "40.00")
    _entry(seeded_db, "checkpoint", date(2026, 6, 30), "0.00", net_at="40.00")
    _spend(seeded_db, config, date(2026, 7, 10), "25.00")

    june = compute_balance(seeded_db, "2026-06", config)
    assert june.carried_in == D("0.00") and june.balance_out == D("0.00")
    assert june.from_period == "2026-06"
    assert june.checkpoint is not None and june.checkpoint.amount == D("0.00")
    assert june.checkpoint.drift == D("0.00") and june.checkpoint.drifted is False

    july = compute_balance(seeded_db, "2026-07", config)
    assert (july.carried_in, july.balance_out, july.from_period) == (D("0.00"), D("25.00"), "2026-06")

    # Months before the checkpoint are history: flagged, and never carried forward.
    may = compute_balance(seeded_db, "2026-05", config)
    assert may.before_checkpoint is True and may.balance_out == D("999.00")
    assert june.before_checkpoint is False
    # The screens can name the month that made May history, and say July's carried-in
    # figure starts from the balance set in June.
    assert may.later_checkpoint_period == "2026-06"
    assert june.later_checkpoint_period is None and june.anchored_on is None
    assert july.anchored_on is not None
    assert (july.anchored_on.period_key, july.anchored_on.entry_date, july.anchored_on.amount) == (
        "2026-06",
        date(2026, 6, 30),
        D("0.00"),
    )


def test_approval_after_checkpoint_reports_drift(seeded_db, config: AppConfig) -> None:
    _spend(seeded_db, config, date(2026, 6, 10), "40.00")
    _entry(seeded_db, "checkpoint", date(2026, 6, 30), "10.00", net_at="40.00")
    _spend(seeded_db, config, date(2026, 6, 20), "15.00")  # approved after the balance was agreed
    _entry(seeded_db, "adjustment", date(2026, 6, 25), "5.00")  # also ignored: the checkpoint is absolute

    june = compute_balance(seeded_db, "2026-06", config)
    assert june.net == D("55.00")
    assert june.balance_out == D("10.00")
    assert june.checkpoint.drift == D("15.00") and june.checkpoint.drifted is True
    assert compute_balance(seeded_db, "2026-07", config).carried_in == D("10.00")


def test_primary_paid_debit_increases_what_secondary_owes(seeded_db, config: AppConfig) -> None:
    _settlement_line(seeded_db, config, date(2026, 8, 5), "-80.00")  # primary sent the partner 80
    summary = compute_settlement(seeded_db, "2026-08", config)
    assert summary.settlement_payments_received == D("-80.00")
    assert summary.net_owed_by_secondary == D("0.00")
    bal = compute_balance(seeded_db, "2026-08", config)
    assert bal.payments_ledger == D("-80.00") and bal.balance_out == D("80.00")


def test_account_paid_by_secondary_flips_the_sign(seeded_db, config: AppConfig) -> None:
    assert config.payer_for_account("acc_checking_barclays") == SECONDARY
    _spend(seeded_db, config, date(2026, 8, 3), "100.00")
    barclays = "acc_checking_barclays"
    _settlement_line(seeded_db, config, date(2026, 8, 5), "60.00", account_id=barclays)  # primary paid in
    _settlement_line(seeded_db, config, date(2026, 8, 6), "-40.00", account_id=barclays)  # secondary paid out
    bal = compute_balance(seeded_db, "2026-08", config)
    assert bal.payments_ledger == D("-20.00")
    assert bal.balance_out == D("120.00")


def test_manual_payments_each_direction_and_adjustment(seeded_db, config: AppConfig) -> None:
    _spend(seeded_db, config, date(2026, 8, 3), "100.00")
    _entry(seeded_db, "payment", date(2026, 8, 10), "30.00", paid_by=SECONDARY)
    _entry(seeded_db, "payment", date(2026, 8, 11), "10.00", paid_by=PRIMARY)
    _entry(seeded_db, "adjustment", date(2026, 8, 12), "-15.00")
    bal = compute_balance(seeded_db, "2026-08", config)
    assert bal.payments_manual == D("20.00")
    assert bal.adjustments == D("-15.00")
    assert bal.balance_out == D("100.00") - D("20.00") - D("15.00")


def test_negative_balance_means_primary_owes(seeded_db, config: AppConfig) -> None:
    make_claim(seeded_db, config, claim_date=date(2026, 8, 10), amount="40.00", claim_type="primary_personal",
               paid_by=SECONDARY)
    bal = compute_balance(seeded_db, "2026-08", config)
    assert bal.net == D("-40.00") and bal.balance_out == D("-40.00")
    assert compute_balance(seeded_db, "2026-09", config).carried_in == D("-40.00")


def test_snapshot_records_the_running_balance(seeded_db, config: AppConfig) -> None:
    _spend(seeded_db, config, date(2026, 7, 10), "70.00")
    _spend(seeded_db, config, date(2026, 8, 10), "50.00")
    _settlement_line(seeded_db, config, date(2026, 8, 2), "70.00")
    _entry(seeded_db, "payment", date(2026, 8, 9), "5.00", paid_by=SECONDARY)
    _entry(seeded_db, "adjustment", date(2026, 8, 9), "2.00")
    row = snapshot_settlement(seeded_db, "2026-08", config)
    close_period(seeded_db, "2026-08")
    assert row.carried_in == D("70.00")
    assert row.payments == D("75.00")
    assert row.adjustments == D("2.00")
    assert row.balance_out == D("70.00") + D("50.00") - D("75.00") + D("2.00")
    assert row.settlement_payments_received == D("70.00")


def test_entry_keeps_its_period(seeded_db, config: AppConfig) -> None:
    _entry(seeded_db, "adjustment", date(2026, 3, 1), "1.00")
    assert delete_if_unreferenced(seeded_db, "2026-03") is False
    assert seeded_db.get(LedgerPeriod, "2026-03") is not None


def test_reset_scopes(seeded_db, config: AppConfig) -> None:
    _spend(seeded_db, config, date(2026, 6, 10), "10.00")
    _entry(seeded_db, "checkpoint", date(2026, 6, 30), "0.00", net_at="10.00")
    _spend(seeded_db, config, date(2026, 7, 10), "10.00")

    reset_service.reset(seeded_db, "transactions", config)
    assert _count(seeded_db, SettlementEntry) == 1
    assert {p.period_key for p in seeded_db.scalars(select(LedgerPeriod))} == {"2026-06"}

    reset_service.reset(seeded_db, "everything", config)
    assert _count(seeded_db, SettlementEntry) == 0
    assert _count(seeded_db, LedgerPeriod) == 0


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #


def _post(client, headers, **body):
    return client.post("/api/settlement/entries", headers=headers, json=body)


def test_api_settlement_includes_balance_entries_and_ledger_payments(
    client, primary_headers, secondary_headers, seeded_db, config
):
    _spend(seeded_db, config, date(2026, 7, 10), "100.00")
    _spend(seeded_db, config, date(2026, 8, 10), "50.00")
    txn = _settlement_line(seeded_db, config, date(2026, 8, 2), "-20.00")
    seeded_db.commit()

    resp = _post(client, primary_headers, kind="payment", entry_date="2026-08-15", amount="60.00",
                 paid_by=SECONDARY, note="bank transfer")
    assert resp.status_code == 201, resp.text
    entry = resp.json()
    assert entry["period_key"] == "2026-08" and entry["amount"] == "60.00" and entry["paid_by"] == SECONDARY
    assert entry["created_by"] == PRIMARY

    body = client.get("/api/settlement/2026-08", headers=secondary_headers).json()
    assert body["settlement_payments_received"] == "-20.00"
    assert body["balance"] == {
        "carried_in": "100.00",
        "net": "50.00",
        "payments_ledger": "-20.00",
        "payments_manual": "60.00",
        "adjustments": "0.00",
        "balance_out": "110.00",
        "from_period": "2026-07",
        "checkpoint": None,
        "before_checkpoint": False,
        "later_checkpoint_period": None,
        "anchored_on": None,
    }
    assert [e["id"] for e in body["entries"]] == [entry["id"]]
    assert body["ledger_payments"] == [
        {
            "transaction_id": str(txn.id),
            "date": "2026-08-02",
            "amount": "-20.00",
            "account_id": "acc_checking_hsbc",
            "description": txn.cleaned_merchant,
            "effect": "-20.00",
        }
    ]


def test_api_checkpoint_upserts_and_records_net(client, primary_headers, seeded_db, config):
    _spend(seeded_db, config, date(2026, 8, 10), "50.00")
    seeded_db.commit()
    first = _post(client, primary_headers, kind="checkpoint", entry_date="2026-08-31", amount="0")
    assert first.status_code == 201, first.text
    assert first.json()["net_at_checkpoint"] == "50.00"
    second = _post(client, primary_headers, kind="checkpoint", entry_date="2026-08-30", amount="12.50", note="agreed")
    assert second.status_code == 201
    assert second.json()["id"] == first.json()["id"]
    body = client.get("/api/settlement/2026-08", headers=primary_headers).json()
    assert body["balance"]["balance_out"] == "12.50"
    assert body["balance"]["checkpoint"]["note"] == "agreed"
    assert body["balance"]["checkpoint"]["drifted"] is False
    assert _count(seeded_db, SettlementEntry) == 1


def test_api_payment_marks_claims_settled(client, primary_headers, seeded_db, config):
    claim = make_claim(seeded_db, config, claim_date=date(2026, 8, 10), amount="20.00", paid_by=SECONDARY)
    seeded_db.commit()
    assert _post(client, primary_headers, kind="payment", entry_date="2026-08-20", amount="5",
                 paid_by=PRIMARY).status_code == 201
    seeded_db.refresh(claim)
    assert claim.is_settled is True


def test_api_validation(client, primary_headers, seeded_db):
    cases = [
        {"kind": "payment", "entry_date": "2026-08-01", "amount": "10"},  # no paid_by
        {"kind": "payment", "entry_date": "2026-08-01", "amount": "10", "paid_by": "someone"},
        {"kind": "payment", "entry_date": "2026-08-01", "amount": "0", "paid_by": SECONDARY},
        {"kind": "payment", "entry_date": "2026-08-01", "amount": "-5", "paid_by": SECONDARY},
        {"kind": "adjustment", "entry_date": "2026-08-01", "amount": "0"},
        {"kind": "adjustment", "entry_date": "2026-08-01", "amount": "5", "paid_by": SECONDARY},
        {"kind": "adjustment", "entry_date": "2026-08-01", "amount": "1.005"},
        {"kind": "checkpoint", "entry_date": "2026-08-01", "amount": "0", "note": "x" * 501},
        {"kind": "refund", "entry_date": "2026-08-01", "amount": "5"},
        {"kind": "checkpoint", "entry_date": "not a date", "amount": "5"},
    ]
    for body in cases:
        assert client.post("/api/settlement/entries", headers=primary_headers, json=body).status_code == 422, body
    assert _count(seeded_db, SettlementEntry) == 0
    ok = _post(client, primary_headers, kind="checkpoint", entry_date="2026-08-01", amount="-3.20", note="x" * 500)
    assert ok.status_code == 201


def test_api_closed_period_rules(client, primary_headers, seeded_db, config):
    payment = _post(client, primary_headers, kind="payment", entry_date="2026-08-10", amount="10",
                    paid_by=SECONDARY).json()
    close_period(seeded_db, "2026-08")
    seeded_db.commit()

    assert _post(client, primary_headers, kind="payment", entry_date="2026-08-11", amount="10",
                 paid_by=SECONDARY).status_code == 409
    assert _post(client, primary_headers, kind="adjustment", entry_date="2026-08-11", amount="10").status_code == 409
    assert client.delete(f"/api/settlement/entries/{payment['id']}", headers=primary_headers).status_code == 409

    checkpoint = _post(client, primary_headers, kind="checkpoint", entry_date="2026-08-31", amount="0")
    assert checkpoint.status_code == 201
    assert client.delete(f"/api/settlement/entries/{checkpoint.json()['id']}",
                         headers=primary_headers).status_code == 204
    assert _count(seeded_db, SettlementEntry) == 1


def test_api_delete(client, primary_headers, seeded_db):
    entry = _post(client, primary_headers, kind="adjustment", entry_date="2026-02-10", amount="7").json()
    assert seeded_db.get(LedgerPeriod, "2026-02") is not None
    assert client.delete(f"/api/settlement/entries/{entry['id']}", headers=primary_headers).status_code == 204
    # The month was created by the entry alone, so it goes with it.
    assert seeded_db.get(LedgerPeriod, "2026-02") is None
    missing = client.delete(f"/api/settlement/entries/{entry['id']}", headers=primary_headers)
    assert missing.status_code == 404


def test_api_secondary_reads_but_cannot_write(client, primary_headers, secondary_headers, seeded_db):
    entry = _post(client, primary_headers, kind="adjustment", entry_date="2026-08-10", amount="7").json()
    assert client.get("/api/settlement/2026-08", headers=secondary_headers).status_code == 200
    assert _post(client, secondary_headers, kind="payment", entry_date="2026-08-10", amount="7",
                 paid_by=SECONDARY).status_code == 403
    assert client.delete(f"/api/settlement/entries/{entry['id']}", headers=secondary_headers).status_code == 403
    assert _count(seeded_db, SettlementEntry) == 1
    assert _count(seeded_db, PartnerClaim) == 0
    assert _count(seeded_db, SettlementSnapshot) == 0
