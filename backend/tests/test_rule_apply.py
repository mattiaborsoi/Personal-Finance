"""Settings -> Rules, "Apply to waiting lines": POST /api/settings/rules/apply."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.models import Transaction, TransferBuffer
from app.services.periods import close_period
from tests.conftest import requires_db
from tests.factories import make_transaction

URL = "/api/settings/rules/apply"
TFL_RULE = {
    "pattern": r"(?i)TFL\s*TRAVEL",
    "category": "Transport:Public",
    "claim_type": "personal",
    "amount_min": "0.00",
    "amount_max": "15.00",
}


def _save_rules(client, headers, config, *extra: dict) -> None:
    current = [
        r.model_dump(mode="json", exclude_none=True) for r in config.deterministic_rules
    ]
    resp = client.put("/api/settings/rules", headers=headers, json={"rules": [*current, *extra]})
    assert resp.status_code == 200, resp.text


def _guessed(db, config, raw: str, amount: str, d: date = date(2026, 8, 12), **extra) -> Transaction:
    """A line the AI guessed as a 50/50 eat-out, still waiting for review."""
    fields = {
        "account_id": "acc_cc_amex",
        "raw_description": raw,
        "cleaned_merchant": "TFL",
        "category": "Dining",
        "claim_type": "shared_equal",
        "review_status": "pending_review",
        "classification_source": "llm",
        "suggested_category": "Dining",
        "suggested_claim_type": "shared_equal",
        **extra,
    }
    return make_transaction(db, config, transaction_date=d, amount=amount, **fields)


@requires_db
def test_rule_files_and_approves_a_waiting_line(client, primary_headers, seeded_db, config):
    _save_rules(client, primary_headers, config, TFL_RULE)
    txn = _guessed(seeded_db, config, "TFL TRAVEL CH 12AUG", "-2.80")

    body = client.post(URL, headers=primary_headers, json={}).json()

    assert (body["matched"], body["changed"], body["approved"], body["unchanged"]) == (1, 1, 1, 0)
    item = body["items"][0]
    assert item["before"] == {"category": "Dining", "claim_type": "shared_equal"}
    assert item["after"] == {"category": "Transport:Public", "claim_type": "personal"}
    assert item["rule_index"] == len(config.deterministic_rules) and item["changed"] is True
    seeded_db.refresh(txn)
    assert (txn.category, txn.claim_type, txn.review_status) == ("Transport:Public", "personal", "auto_approved")
    assert txn.classification_source == "rule" and txn.classification_confidence == Decimal("1.000")
    # The amex is the primary's card: a personal line is all theirs.
    assert (txn.allocated_primary_amount, txn.allocated_secondary_amount) == (Decimal("-2.80"), Decimal("0.00"))
    # A rule overriding the model is a suggestion not accepted, as for "approve known merchants".
    assert txn.suggestion_accepted is False


@requires_db
def test_amount_range_is_respected(client, primary_headers, seeded_db, config):
    _save_rules(client, primary_headers, config, TFL_RULE)
    inside = _guessed(seeded_db, config, "TFL TRAVEL CH 01AUG", "-15.00")
    outside = _guessed(seeded_db, config, "TFL TRAVEL CH 02AUG", "-15.01")

    body = client.post(URL, headers=primary_headers, json={}).json()

    assert body["matched"] == 1 and body["items"][0]["id"] == str(inside.id)
    seeded_db.refresh(outside)
    assert (outside.category, outside.review_status) == ("Dining", "pending_review")


@requires_db
def test_approved_lines_are_never_touched(client, primary_headers, seeded_db, config):
    _save_rules(client, primary_headers, config, TFL_RULE)
    approved = _guessed(seeded_db, config, "TFL TRAVEL CH 03AUG", "-3.10", review_status="manual_approved")

    body = client.post(URL, headers=primary_headers, json={}).json()

    assert body["matched"] == 0
    seeded_db.refresh(approved)
    assert (approved.category, approved.claim_type) == ("Dining", "shared_equal")


@requires_db
def test_closed_period_is_skipped_and_period_scopes(client, primary_headers, seeded_db, config):
    _save_rules(client, primary_headers, config, TFL_RULE)
    july = _guessed(seeded_db, config, "TFL TRAVEL CH 05JUL", "-2.80", d=date(2026, 7, 5))
    august = _guessed(seeded_db, config, "TFL TRAVEL CH 05AUG", "-2.80", d=date(2026, 8, 5))
    september = _guessed(seeded_db, config, "TFL TRAVEL CH 05SEP", "-2.80", d=date(2026, 9, 5))
    close_period(seeded_db, "2026-07")
    seeded_db.commit()

    scoped = client.post(URL, headers=primary_headers, json={"period": "2026-09"}).json()
    assert [i["id"] for i in scoped["items"]] == [str(september.id)]

    everything = client.post(URL, headers=primary_headers, json={"period": None}).json()
    assert [i["id"] for i in everything["items"]] == [str(august.id)]
    seeded_db.refresh(july)
    assert july.review_status == "pending_review" and july.category == "Dining"
    assert client.post(URL, headers=primary_headers, json={"period": "2026-13"}).status_code == 422


@requires_db
def test_transfer_rule_flags_and_writes_the_mirror(client, primary_headers, seeded_db, config):
    _save_rules(client, primary_headers, config)  # the example's Robinhood rule names a transfer target
    txn = _guessed(
        seeded_db, config, "ROBINHOOD SECURITIES", "-250.00", account_id="acc_checking_hsbc", cleaned_merchant="Rh"
    )

    body = client.post(URL, headers=primary_headers, json={}).json()

    assert body["changed"] == 1
    seeded_db.refresh(txn)
    assert txn.is_internal_transfer and txn.review_status == "auto_approved"
    assert (txn.category, txn.claim_type, txn.cleaned_merchant) == ("Transfers:Investment", "personal", "Robinhood")
    assert seeded_db.scalars(select(TransferBuffer).where(TransferBuffer.transaction_id == txn.id)).first()
    mirror = seeded_db.get(Transaction, txn.linked_transfer_id)
    assert mirror is not None and mirror.account_id == "acc_invest_robinhood" and mirror.amount == Decimal("250.00")


@requires_db
def test_dry_run_writes_nothing(client, primary_headers, seeded_db, config):
    _save_rules(client, primary_headers, config, TFL_RULE)
    txn = _guessed(seeded_db, config, "TFL TRAVEL CH 12AUG", "-2.80")

    body = client.post(URL, headers=primary_headers, json={"dry_run": True}).json()

    assert (body["matched"], body["changed"], body["approved"]) == (1, 1, 1)
    seeded_db.refresh(txn)
    assert (txn.category, txn.review_status, txn.classification_source) == ("Dining", "pending_review", "llm")
    assert txn.suggestion_accepted is None


@requires_db
def test_line_already_filed_the_rule_way_is_unchanged_but_approved(client, primary_headers, seeded_db, config):
    _save_rules(client, primary_headers, config, TFL_RULE)
    same = _guessed(
        seeded_db, config, "TFL TRAVEL CH 12AUG", "-2.80", category="Transport:Public", claim_type="personal"
    )
    other = _guessed(seeded_db, config, "TFL TRAVEL CH 13AUG", "-2.80")

    body = client.post(URL, headers=primary_headers, json={"dry_run": True}).json()
    assert (body["matched"], body["changed"], body["unchanged"], body["approved"]) == (2, 1, 1, 2)
    assert [i["id"] for i in body["items"]] == [str(other.id), str(same.id)]  # changes first

    client.post(URL, headers=primary_headers, json={})
    seeded_db.refresh(same)
    assert same.review_status == "auto_approved" and same.category == "Transport:Public"


@requires_db
def test_secondary_is_refused(client, secondary_headers):
    assert client.post(URL, headers=secondary_headers, json={}).status_code == 403
