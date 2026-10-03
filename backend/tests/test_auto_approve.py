"""Approving lines from known merchants (app.services.auto_approve)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.models import Transaction
from app.services import auto_approve, ingestion
from app.services.auto_approve import Past, decide
from app.services.parsers.base import ParsedStatement, ParsedTransaction, StatementMetadata
from app.services.periods import close_period
from tests.conftest import requires_db
from tests.factories import make_transaction

D = Decimal
GYM = "Iron Works Gym"


def line(amount: str, **extra) -> SimpleNamespace:
    base = {"id": None, "amount": D(amount), "is_internal_transfer": False, "is_split": False, "split_parent_id": None}
    return SimpleNamespace(**{**base, **extra})


def past(amount: str, category: str = "Groceries", claim_type: str = "shared_proportional", id=None) -> Past:
    return Past(id=id, amount=D(amount), category=category, claim_type=claim_type)


def gym_history() -> list[Past]:
    rows = [past(a, "Health:Gym", "personal") for a in ("-10.45", "-25.00", "-40.00", "-40.00", "-40.00")]
    rows += [past(a, "Dining", "personal") for a in ("-6.45", "-12.80")]
    rows += [past(a, "Personal:Care", "personal") for a in ("-19.60", "-76.20")]
    return rows


# --------------------------------------------------------------------------- #
# decide: pure rules
# --------------------------------------------------------------------------- #


def test_consistent_history_approves_within_range():
    d = decide(line("-20.00"), [past("-15.00"), past("-30.00")])
    assert d.approve and d.reason == "approved"
    assert (d.category, d.claim_type) == ("Groceries", "shared_proportional")
    # The edges of [0.5 x min, 1.5 x max] are inside.
    assert decide(line("-7.50"), [past("-15.00"), past("-30.00")]).approve
    assert decide(line("-45.00"), [past("-15.00"), past("-30.00")]).approve


def test_new_merchant_and_few_approvals():
    assert decide(line("-5.00"), []).reason == "new_merchant"
    assert decide(line("-5.00"), [past("-5.00")]).reason == "few_approvals"


def test_the_line_itself_never_counts():
    assert decide(line("-5.00", id=7), [past("-5.00", id=7), past("-5.00", id=8)]).reason == "few_approvals"


def test_unusual_amount():
    history = [past("-15.00"), past("-30.00")]
    assert decide(line("-7.49"), history).reason == "unusual_amount"
    assert decide(line("-45.01"), history).reason == "unusual_amount"


def test_refund_has_the_other_sign():
    d = decide(line("12.00"), [past("-12.00"), past("-20.00"), past("-8.00")])
    assert not d.approve and d.reason == "other_sign"


def test_gym_exact_repeat_is_approved_as_gym():
    d = decide(line("-40.00"), gym_history())
    assert d.approve and (d.category, d.claim_type) == ("Health:Gym", "personal")
    # Within a penny counts as the same amount.
    assert decide(line("-40.01"), gym_history()).category == "Health:Gym"


def test_gym_amount_in_overlapping_ranges_stays_mixed():
    assert decide(line("-11.00"), gym_history()).reason == "mixed_history"
    # Seen only once: not enough to be sure, even in one category.
    assert decide(line("-10.45"), gym_history()).reason == "mixed_history"


def test_mixed_repeat_filed_two_ways_stays_mixed():
    history = [past("-9.00", "Dining"), past("-9.00", "Coffee"), past("-30.00", "Groceries")]
    assert decide(line("-9.00"), history).reason == "mixed_history"


def test_transfer_split_and_closed_period_are_never_touched():
    history = [past("-5.00"), past("-5.00")]
    assert decide(line("-5.00", is_internal_transfer=True), history).reason == "transfer"
    assert decide(line("-5.00", is_split=True), history).reason == "split"
    assert decide(line("-5.00", split_parent_id=1), history).reason == "split"
    assert decide(line("-5.00"), history, closed=True).reason == "closed_period"


# --------------------------------------------------------------------------- #
# Database: history, apply, API
# --------------------------------------------------------------------------- #


def _approved(db, config, merchant: str, amount: str, d: date, **extra) -> Transaction:
    return make_transaction(
        db,
        config,
        cleaned_merchant=merchant,
        raw_description=merchant.upper(),
        amount=amount,
        transaction_date=d,
        **extra,
    )


def _pending(db, config, merchant: str, amount: str, d: date, **extra) -> Transaction:
    extra.setdefault("category", "Uncategorized")
    extra.setdefault("claim_type", "personal")
    return make_transaction(
        db,
        config,
        cleaned_merchant=merchant,
        raw_description=merchant.upper(),
        amount=amount,
        transaction_date=d,
        review_status="pending_review",
        classification_source="llm",
        **extra,
    )


@pytest.fixture
def ledger(seeded_db, config):
    """Two known merchants, the gym, and pending lines in August and September 2026."""
    db = seeded_db
    for day in (3, 10, 17):
        _approved(db, config, "Ocado", f"-{60 + day}.00", date(2026, 7, day))
    for amount, cat in (
        ("-40.00", "Health:Gym"),
        ("-40.00", "Health:Gym"),
        ("-12.00", "Health:Gym"),
        ("-8.50", "Dining"),
        ("-45.00", "Personal:Care"),
    ):
        _approved(db, config, GYM, amount, date(2026, 7, 5), category=cat, claim_type="personal")
    # Neither a split parent, a transfer nor an Uncategorized line is history.
    _approved(db, config, "Fresh Corner", "-9.00", date(2026, 7, 2), is_split=True)
    _approved(db, config, "Fresh Corner", "-9.00", date(2026, 7, 3), is_internal_transfer=True)
    _approved(db, config, "Fresh Corner", "-9.00", date(2026, 7, 4), category="Uncategorized")
    lines = {
        "ocado_aug": _pending(db, config, " ocado ", "-70.00", date(2026, 8, 4), subcategory="Guess"),
        "ocado_sep": _pending(db, config, "Ocado", "-64.00", date(2026, 9, 4)),
        "ocado_big": _pending(db, config, "Ocado", "-300.00", date(2026, 8, 6)),
        "ocado_refund": _pending(db, config, "Ocado", "20.00", date(2026, 8, 7)),
        "gym_fee": _pending(db, config, GYM, "-40.00", date(2026, 8, 5)),
        "gym_other": _pending(db, config, GYM, "-11.00", date(2026, 8, 9)),
        "corner": _pending(db, config, "Fresh Corner", "-9.00", date(2026, 8, 9)),
        "new": _pending(db, config, "Brand New Bakery", "-4.00", date(2026, 8, 10)),
    }
    db.commit()
    return lines


@requires_db
def test_dry_run_changes_nothing(client, primary_headers, ledger, seeded_db):
    resp = client.post(
        "/api/transactions/auto-approve", headers=primary_headers, json={"period": "2026-08", "dry_run": True}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["considered"] == 7 and body["approved"] == 2
    assert body["skipped"] == {"unusual_amount": 1, "other_sign": 1, "mixed_history": 1, "new_merchant": 2}
    by_id = {i["id"]: i for i in body["items"]}
    gym = by_id[str(ledger["gym_fee"].id)]
    assert (gym["category"], gym["claim_type"], gym["cleaned_merchant"]) == ("Health:Gym", "personal", GYM)
    assert D(by_id[str(ledger["ocado_aug"].id)]["amount"]) == D("-70.00")
    seeded_db.expire_all()
    assert all(t.review_status == "pending_review" for t in ledger.values())


@requires_db
def test_run_by_period_approves_and_recomputes(client, primary_headers, ledger, seeded_db, config):
    resp = client.post("/api/transactions/auto-approve", headers=primary_headers, json={"period": "2026-08"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["approved"] == 2
    seeded_db.expire_all()
    ocado = seeded_db.get(Transaction, ledger["ocado_aug"].id)
    assert ocado.review_status == "auto_approved"
    assert ocado.classification_source == "memory" and ocado.classification_confidence == D("0.950")
    assert (ocado.category, ocado.claim_type, ocado.subcategory) == ("Groceries", "shared_proportional", None)
    # Allocations follow the new claim type (split by income).
    assert ocado.allocated_primary_amount + ocado.allocated_secondary_amount == D("-70.00")
    assert ocado.allocated_secondary_amount != 0
    assert seeded_db.get(Transaction, ledger["gym_fee"].id).category == "Health:Gym"
    # September was out of scope; the gym's odd amount still waits.
    assert seeded_db.get(Transaction, ledger["ocado_sep"].id).review_status == "pending_review"
    assert seeded_db.get(Transaction, ledger["gym_other"].id).review_status == "pending_review"


@requires_db
def test_run_for_all_months(client, primary_headers, ledger, seeded_db):
    resp = client.post("/api/transactions/auto-approve", headers=primary_headers, json={"period": None})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["considered"] == 8 and body["approved"] == 3
    seeded_db.expire_all()
    assert seeded_db.get(Transaction, ledger["ocado_sep"].id).review_status == "auto_approved"


@requires_db
def test_closed_period_is_skipped(client, primary_headers, ledger, seeded_db):
    close_period(seeded_db, "2026-08")
    seeded_db.commit()
    body = client.post("/api/transactions/auto-approve", headers=primary_headers, json={}).json()
    assert body["approved"] == 1 and body["skipped"]["closed_period"] == 7


@requires_db
def test_split_parts_count_as_history_and_bad_period_is_refused(client, primary_headers, seeded_db, config):
    parent = _approved(seeded_db, config, "Market Hall", "-30.00", date(2026, 7, 1), is_split=True)
    for i, amount in enumerate(("-12.00", "-18.00")):
        _approved(
            seeded_db,
            config,
            "Market Hall",
            amount,
            date(2026, 7, 1),
            split_parent_id=parent.id,
            split_index=i,
            category="Dining",
            claim_type="shared_equal",
        )
    target = _pending(seeded_db, config, "Market Hall", "-15.00", date(2026, 8, 1))
    seeded_db.commit()
    assert (
        client.post("/api/transactions/auto-approve", headers=primary_headers, json={"period": "2026-13"}).status_code
        == 422
    )
    body = client.post("/api/transactions/auto-approve", headers=primary_headers, json={"period": "2026-08"}).json()
    assert body["items"] == [
        {
            "id": str(target.id),
            "cleaned_merchant": "Market Hall",
            "amount": "-15.00",
            "category": "Dining",
            "claim_type": "shared_equal",
        }
    ]


@requires_db
def test_secondary_cannot_auto_approve(client, secondary_headers):
    assert client.post("/api/transactions/auto-approve", headers=secondary_headers, json={}).status_code == 403


# --------------------------------------------------------------------------- #
# Ingestion
# --------------------------------------------------------------------------- #


def _fake_parse(lines):
    def parse(path, config, llm=None, filename=None, account=None):
        meta = StatementMetadata(
            institution="HSBC", account_last4="4471", closing_date=None, account_type_hint="checking"
        )
        return ParsedStatement(metadata=meta, transactions=list(lines), parser_name="fake")

    return parse


def _unsure_llm(system: str, user: str) -> dict:
    """Names the merchant but is never sure enough to approve on its own."""
    target = "\n".join(row for row in user.splitlines() if "->" not in row).upper()
    merchant = "Iron Works Gym" if "IRONWORKS" in target else "Brand New Bakery"
    return {
        "merchant": merchant,
        "category": "Dining",
        "claim_type": "personal",
        "confidence": 0.3,
        "reasoning": "stub",
    }


@requires_db
def test_second_upload_approves_a_known_merchant(seeded_db, config, embedder, fake_llm, tmp_path, monkeypatch):
    fake_llm.handler = _unsure_llm
    first = [
        ParsedTransaction(
            date=date(2026, 7, d), raw_text=f"IRONWORKS LOCKER {d}", amount=D("-40.00"), card_last4="4471"
        )
        for d in (1, 15)
    ]
    monkeypatch.setattr(ingestion, "parse_statement", _fake_parse(first))
    (tmp_path / "jul.csv").write_text("july", encoding="utf-8")
    result = ingestion.ingest_statement(seeded_db, config, embedder, fake_llm, tmp_path / "jul.csv", "jul.csv")
    assert result.pending_review == 2 and result.auto_approved_known == 0
    for txn in seeded_db.query(Transaction).all():
        txn.category, txn.claim_type, txn.review_status = "Health:Gym", "personal", "manual_approved"
    seeded_db.flush()

    second = [
        ParsedTransaction(date=date(2026, 8, 1), raw_text="IRONWORKS LOCKER 99", amount=D("-40.00"), card_last4="4471"),
        ParsedTransaction(date=date(2026, 8, 2), raw_text="BAKERY ON THE CORNER", amount=D("-4.00"), card_last4="4471"),
    ]
    monkeypatch.setattr(ingestion, "parse_statement", _fake_parse(second))
    (tmp_path / "aug.csv").write_text("august", encoding="utf-8")
    result = ingestion.ingest_statement(seeded_db, config, embedder, fake_llm, Path(tmp_path / "aug.csv"), "aug.csv")
    assert result.auto_approved_known == 1
    assert result.pending_review == 1 and result.auto_approved == 1
    gym = seeded_db.query(Transaction).filter(Transaction.raw_description == "IRONWORKS LOCKER 99").one()
    assert (gym.review_status, gym.category, gym.classification_source) == ("auto_approved", "Health:Gym", "memory")
    bakery = seeded_db.query(Transaction).filter(Transaction.raw_description == "BAKERY ON THE CORNER").one()
    assert bakery.review_status == "pending_review"


def test_reasons_are_listed():
    assert set(auto_approve.REASONS) >= {"approved", "new_merchant", "new_on_this_card", "closed_period"}


@requires_db
def test_history_is_per_card(client, primary_headers, seeded_db, config):
    """Pret on Alex's own card is Alex's dining; on the shared card it is split by income."""
    db = seeded_db
    own, shared, other = "acc_cc_amex", "acc_checking_hsbc", "acc_cc_virgin"
    for day in (2, 9, 16):
        _approved(
            db, config, "Pret", "-6.50", date(2026, 7, day), account_id=own,
            category="Dining", claim_type="personal",
        )
        _approved(
            db, config, "Pret", "-7.20", date(2026, 7, day), account_id=shared,
            category="Dining", claim_type="shared_proportional",
        )
    on_own = _pending(db, config, "Pret", "-6.80", date(2026, 8, 3), account_id=own)
    on_shared = _pending(db, config, "Pret", "-6.90", date(2026, 8, 4), account_id=shared)
    on_other = _pending(db, config, "Pret", "-6.95", date(2026, 8, 5), account_id=other)
    db.commit()

    resp = client.post("/api/transactions/auto-approve", headers=primary_headers, json={"period": "2026-08"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["skipped"].get("new_on_this_card") == 1
    db.expire_all()
    assert db.get(Transaction, on_own.id).claim_type == "personal"
    assert db.get(Transaction, on_shared.id).claim_type == "shared_proportional"
    # Known only from other cards: how it was shared there is no guide here.
    assert db.get(Transaction, on_other.id).review_status == "pending_review"
