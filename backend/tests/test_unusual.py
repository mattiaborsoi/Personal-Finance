"""Outliers: a line filed unlike its merchant usually is on the same card."""

from __future__ import annotations

from datetime import date, timedelta

from app.services import unusual
from tests.conftest import requires_db
from tests.factories import make_transaction


def pret(db, config, n: int, category="Dining", claim_type="personal", account="acc_cc_amex", **extra):
    out = []
    for i in range(n):
        out.append(
            make_transaction(
                db, config, account_id=account, transaction_date=date(2026, 7, 1) + timedelta(days=i),
                amount="-5.00", raw_description="PRET A MANGER", cleaned_merchant="Pret", category=category,
                claim_type=claim_type, **extra,
            )  # fmt: skip
        )
    return out


@requires_db
def test_annotate_flags_the_odd_one_out_and_names_the_usual_filing(seeded_db, config) -> None:
    usual = pret(seeded_db, config, 14)
    odd = pret(seeded_db, config, 1, category="Groceries", claim_type="shared_equal", review_status="auto_approved")[0]
    pending = pret(seeded_db, config, 1, category="Groceries", review_status="pending_review")[0]
    other_card = pret(seeded_db, config, 1, category="Groceries", account="acc_cc_amex_supp")[0]
    flags = unusual.annotate(seeded_db, config, [*usual, odd, pending, other_card])
    assert set(flags) == {odd.id, pending.id}
    assert flags[odd.id] == unusual.Unusual(usual_category="Dining", usual_claim_type="personal", times=0, total=14)
    assert flags[pending.id].total == 15  # the approved odd line now counts in the history too
    # Filed the usual way: never flagged, however the share is computed.
    assert usual[0].id not in flags


@requires_db
def test_thresholds_history_size_and_share(seeded_db, config) -> None:
    few = pret(seeded_db, config, 3)
    odd = pret(seeded_db, config, 1, category="Groceries")[0]
    assert unusual.annotate(seeded_db, config, [odd]) == {}  # only 3 others: too little history
    pret(seeded_db, config, 1)
    assert odd.id in unusual.annotate(seeded_db, config, [odd])  # 4 others, 0 of 4 filed this way
    # Two of ten filed this way is exactly 20%: still unusual; three of ten is not.
    pret(seeded_db, config, 5)
    pret(seeded_db, config, 2, category="Groceries")
    assert odd.id in unusual.annotate(seeded_db, config, [odd])  # 2 of 10 others
    pret(seeded_db, config, 1, category="Groceries")
    assert unusual.annotate(seeded_db, config, [odd]) == {}  # 3 of 11
    assert few[0].id not in unusual.annotate(seeded_db, config, few)


@requires_db
def test_splits_and_transfers_are_never_flagged(seeded_db, config) -> None:
    pret(seeded_db, config, 6)
    transfer = pret(seeded_db, config, 1, category="Transfers:Internal", is_internal_transfer=True)[0]
    parent = pret(seeded_db, config, 1, category="Groceries", is_split=True)[0]
    assert unusual.annotate(seeded_db, config, [transfer, parent]) == {}


@requires_db
def test_sql_filter_and_period_counts_agree_with_annotate(seeded_db, config) -> None:
    from sqlalchemy import select

    from app.models import Transaction

    usual = pret(seeded_db, config, 8)
    odd = pret(seeded_db, config, 1, category="Groceries", review_status="auto_approved")[0]
    pending_odd = pret(seeded_db, config, 1, claim_type="shared_equal", review_status="pending_review")[0]
    pret(seeded_db, config, 1, category="Transfers:Internal", is_internal_transfer=True)
    rows = seeded_db.scalars(unusual.with_unusual_filter(select(Transaction))).all()
    assert {r.id for r in rows} == {odd.id, pending_odd.id}
    assert set(unusual.annotate(seeded_db, config, [*usual, odd, pending_odd])) == {odd.id, pending_odd.id}
    assert unusual.counts_by_period(seeded_db) == {"2026-07": 2}


@requires_db
def test_api_marks_unusual_lines_filters_them_and_counts_them_per_month(client, primary_headers, seeded_db, config):
    pret(seeded_db, config, 5)
    odd = pret(seeded_db, config, 1, category="Groceries")[0]
    items = client.get("/api/transactions", headers=primary_headers, params={"period": "2026-07"}).json()["items"]
    by_id = {t["id"]: t for t in items}
    assert by_id[str(odd.id)]["unusual"] == {
        "usual_category": "Dining", "usual_claim_type": "personal", "times": 0, "total": 5,
    }  # fmt: skip
    assert sum(t["unusual"] is not None for t in items) == 1
    only = client.get("/api/transactions", headers=primary_headers, params={"unusual": "true"}).json()
    assert only["total"] == 1 and only["items"][0]["id"] == str(odd.id)
    one = client.get(f"/api/transactions/{odd.id}", headers=primary_headers).json()
    assert one["unusual"]["usual_category"] == "Dining"
    [period] = [p for p in client.get("/api/periods", headers=primary_headers).json() if p["period_key"] == "2026-07"]
    assert period["unusual_count"] == 1
