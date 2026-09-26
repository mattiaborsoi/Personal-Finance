"""Split transactions: service invariants, aggregation rules and the REST endpoints.

A £10 receipt split into £6 groceries shared by income and £4 of a personal item
must show up as two rows everywhere money is aggregated (settlement, macro/micro
metrics, the auditor) while the parent row keeps being the one cash movement in the
liquidity view and the one entry in the transactions list.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models import Transaction
from app.schemas import SplitPartIn
from app.services import auditor, metrics, settlement, splits
from app.services.periods import close_period
from tests.conftest import requires_db
from tests.factories import make_transaction, q2

D = Decimal
PERIOD = "2026-08"
CARD = "acc_cc_amex"
CHECKING = "acc_checking_hsbc"


def _parts(*specs: tuple[str, str, str]) -> list[SplitPartIn]:
    return [
        SplitPartIn(amount=D(amount), category=category, claim_type=claim_type)
        for amount, category, claim_type in specs
    ]


def _shared_and_personal() -> list[SplitPartIn]:
    """£6 groceries shared by income plus £4 of a personal item."""
    return _parts(("-6.00", "Groceries", "shared_proportional"), ("-4.00", "Shopping:Home", "personal"))


def _two_personal() -> list[SplitPartIn]:
    return _parts(("-6.00", "Dining", "personal"), ("-4.00", "Coffee", "personal"))


def _waitrose(db, config, **kw) -> Transaction:
    return make_transaction(
        db,
        config,
        account_id=kw.pop("account_id", CARD),
        transaction_date=date(2026, 8, 12),
        amount="-10.00",
        raw_description="WAITROSE 4521 LEEDS",
        cleaned_merchant="Waitrose",
        category="Groceries",
        claim_type="shared_proportional",
        review_status=kw.pop("review_status", "pending_review"),
        **kw,
    )


# --------------------------------------------------------------------------- #
# Service invariants
# --------------------------------------------------------------------------- #


@requires_db
class TestValidation:
    def test_two_parts_that_sum_are_accepted_and_quantised(self, seeded_db, config):
        txn = _waitrose(seeded_db, config)
        parts = splits.validate_parts(
            txn, _parts(("-6.004", "Groceries", "shared_proportional"), ("-3.996", "Shopping:Home", "personal")), config
        )
        assert [p.amount for p in parts] == [D("-6.00"), D("-4.00")]

    @pytest.mark.parametrize(
        ("specs", "message"),
        [
            ([("-10.00", "Groceries", "personal")], "between 2 and 20 parts"),
            ([("-6.00", "Groceries", "personal"), ("0.00", "Shopping:Home", "personal")], "zero amount"),
            ([("-6.00", "Groceries", "personal"), ("4.00", "Shopping:Home", "personal")], "same sign"),
            ([("-6.00", "Groceries", "personal"), ("-3.00", "Shopping:Home", "personal")], "parts sum to -9.00"),
            ([("-11.00", "Groceries", "personal"), ("-1.00", "Dining", "personal")], "larger than the transaction"),
        ],
    )
    def test_invalid_parts_are_refused(self, seeded_db, config, specs, message):
        txn = _waitrose(seeded_db, config)
        with pytest.raises(splits.SplitError, match=message):
            splits.validate_parts(txn, _parts(*specs), config)

    def test_blank_category_is_refused(self, seeded_db, config):
        txn = _waitrose(seeded_db, config)
        with pytest.raises(splits.SplitError, match="needs a category"):
            splits.validate_parts(
                txn,
                [
                    SplitPartIn(amount=D("-6"), category="   ", claim_type="personal"),
                    SplitPartIn(amount=D("-4"), category="Shopping:Home", claim_type="personal"),
                ],
                config,
            )

    def test_category_outside_the_taxonomy_is_refused(self, seeded_db, config):
        txn = _waitrose(seeded_db, config)
        with pytest.raises(splits.SplitError, match="part 2 category 'Household' is not in the configured taxonomy"):
            splits.validate_parts(
                txn, _parts(("-6.00", "Groceries", "shared_proportional"), ("-4.00", "Household", "personal")), config
            )

    def test_category_is_matched_ignoring_case_and_stored_canonically(self, seeded_db, config):
        txn = _waitrose(seeded_db, config)
        parts = splits.validate_parts(
            txn, _parts(("-6.00", " groceries ", "shared_proportional"), ("-4.00", "UNCATEGORIZED", "personal")), config
        )
        assert [p.category for p in parts] == ["Groceries", "Uncategorized"]

    def test_transfers_and_parts_cannot_be_split(self, seeded_db, config):
        transfer = _waitrose(seeded_db, config, is_internal_transfer=True, review_status="auto_approved")
        with pytest.raises(splits.SplitRefused, match="internal transfers"):
            splits.split_transaction(seeded_db, transfer, _two_personal(), config)
        parent = make_transaction(seeded_db, config, amount="-10.00", raw_description="TESCO")
        splits.split_transaction(seeded_db, parent, _two_personal(), config)
        with pytest.raises(splits.SplitRefused, match="already part of a split"):
            halves = _parts(("-3.00", "Dining", "personal"), ("-3.00", "Coffee", "personal"))
            splits.split_transaction(seeded_db, parent.parts[0], halves, config)


@requires_db
class TestSplitService:
    def test_split_creates_parts_with_allocations_and_approves(self, seeded_db, config):
        txn = _waitrose(seeded_db, config)
        splits.split_transaction(seeded_db, txn, _shared_and_personal(), config)
        assert txn.is_split is True
        assert txn.review_status == "manual_approved"
        assert txn.amount == D("-10.00")  # the parent keeps the cash movement
        assert [p.split_index for p in txn.parts] == [0, 1]
        shared, personal = txn.parts
        assert shared.split_parent_id == txn.id
        assert (shared.period_key, shared.account_id, shared.transaction_date) == (
            txn.period_key,
            txn.account_id,
            txn.transaction_date,
        )
        assert shared.cleaned_merchant == "Waitrose" and shared.raw_description == txn.raw_description
        assert shared.review_status == "manual_approved" and shared.fingerprint is None
        expected_primary = q2(D("-6.00") * config.primary_ratio)
        assert (shared.allocated_primary_amount, shared.allocated_secondary_amount) == (
            expected_primary,
            D("-6.00") - expected_primary,
        )
        # The card is the primary user's, so a personal part is theirs alone.
        assert (personal.allocated_primary_amount, personal.allocated_secondary_amount) == (D("-4.00"), D("0.00"))
        assert personal.is_claimable is False

    def test_resplit_replaces_parts_and_unsplit_removes_them(self, seeded_db, config):
        txn = _waitrose(seeded_db, config)
        splits.split_transaction(seeded_db, txn, _two_personal(), config)
        old_ids = {p.id for p in txn.parts}
        thirds = _parts(
            ("-2.00", "Dining", "personal"), ("-3.00", "Coffee", "personal"), ("-5.00", "Entertainment", "personal")
        )
        splits.split_transaction(seeded_db, txn, thirds, config)
        assert len(txn.parts) == 3
        remaining = set(seeded_db.scalars(select(Transaction.id).where(Transaction.split_parent_id == txn.id)))
        assert remaining.isdisjoint(old_ids)

        splits.unsplit_transaction(seeded_db, txn)
        assert txn.is_split is False and txn.parts == []
        assert seeded_db.scalars(select(Transaction).where(Transaction.split_parent_id == txn.id)).all() == []
        assert txn.review_status == "manual_approved"

    def test_deleting_the_parent_removes_its_parts(self, seeded_db, config):
        txn = _waitrose(seeded_db, config)
        splits.split_transaction(seeded_db, txn, _two_personal(), config)
        part_ids = [p.id for p in txn.parts]
        seeded_db.delete(txn)
        seeded_db.flush()
        assert seeded_db.scalars(select(Transaction).where(Transaction.id.in_(part_ids))).all() == []


# --------------------------------------------------------------------------- #
# Aggregations
# --------------------------------------------------------------------------- #


@requires_db
class TestAggregations:
    def test_settlement_counts_the_parts_not_the_parent(self, seeded_db, config):
        txn = _waitrose(seeded_db, config)
        splits.split_transaction(seeded_db, txn, _shared_and_personal(), config)
        summary = settlement.compute_settlement(seeded_db, PERIOD, config)
        secondary_share = D("6.00") - q2(D("6.00") * config.primary_ratio)
        assert summary.net_owed_by_secondary == secondary_share
        assert summary.secondary_share_of_primary_paid_shared == secondary_share
        # Only the shared part has an effect; the personal part and the parent are absent.
        assert [(line.amount, line.claim_type) for line in summary.lines] == [(D("-6.00"), "shared_proportional")]
        assert summary.lines[0].id == txn.parts[0].id
        assert summary.pending_review_count == 0

    def test_macro_micro_use_parts_and_liquidity_uses_the_parent(self, seeded_db, config):
        txn = _waitrose(seeded_db, config, account_id=CHECKING)
        splits.split_transaction(seeded_db, txn, _shared_and_personal(), config)
        out = metrics.period_metrics(seeded_db, config, PERIOD)
        assert out.macro.primary_accounts_burn == D("10.00")
        macro = {(c.category, c.amount) for c in out.macro.by_category}
        assert macro == {("Groceries", D("6.00")), ("Shopping:Home", D("4.00"))}
        primary_groceries = -q2(D("-6.00") * config.primary_ratio)
        assert {(c.category, c.amount) for c in out.micro.by_category} == {
            ("Groceries", primary_groceries),
            ("Shopping:Home", D("4.00")),
        }
        assert out.micro.true_net_expense == primary_groceries + D("4.00")
        # One cash movement of £10, not £20.
        assert out.liquidity.debits == D("10.00")
        assert out.liquidity.net_cash_flow == D("-10.00")

    def test_auditor_sees_each_part_once(self, seeded_db, config):
        txn = _waitrose(seeded_db, config, review_status="manual_approved")
        splits.split_transaction(seeded_db, txn, _shared_and_personal(), config)
        rows = {r.category: r.current for r in auditor.category_comparison(seeded_db, config, PERIOD)}
        assert rows == {"Groceries": D("6.00"), "Shopping:Home": D("4.00")}


# --------------------------------------------------------------------------- #
# REST endpoints
# --------------------------------------------------------------------------- #

SPLIT_BODY = {
    "parts": [
        {"amount": "-6.00", "category": "Groceries", "claim_type": "shared_proportional"},
        {"amount": "-4.00", "category": "Shopping:Home", "subcategory": "Cleaning", "claim_type": "personal"},
    ]
}


def _put_split(client, headers, txn_id, body=SPLIT_BODY):
    return client.put(f"/api/transactions/{txn_id}/split", json=body, headers=headers)


def _patch(client, headers, txn_id, body):
    return client.patch(f"/api/transactions/{txn_id}", json=body, headers=headers)


@requires_db
class TestSplitApi:
    def test_split_unsplit_and_listing(self, client, primary_headers, seeded_db, config):
        txn = _waitrose(seeded_db, config)
        seeded_db.commit()

        resp = _put_split(client, primary_headers, txn.id)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["is_split"] is True and body["review_status"] == "manual_approved"
        assert body["amount"] == "-10.00"
        assert [(p["amount"], p["category"], p["claim_type"], p["split_index"]) for p in body["parts"]] == [
            ("-6.00", "Groceries", "shared_proportional", 0),
            ("-4.00", "Shopping:Home", "personal", 1),
        ]
        assert body["parts"][1]["subcategory"] == "Cleaning"
        part_ids = [p["id"] for p in body["parts"]]

        # The list shows the parent once, with its parts embedded, and never the parts.
        listed = client.get("/api/transactions", params={"period": PERIOD}, headers=primary_headers).json()
        assert listed["total"] == 1
        assert listed["items"][0]["id"] == str(txn.id)
        assert [p["id"] for p in listed["items"][0]["parts"]] == part_ids
        # A category filter reaches into the parts.
        by_part_params = {"period": PERIOD, "category": "Shopping:Home"}
        by_part = client.get("/api/transactions", params=by_part_params, headers=primary_headers).json()
        assert [i["id"] for i in by_part["items"]] == [str(txn.id)]
        # The queue is empty: a split is an approval.
        pending_params = {"period": PERIOD, "status": "pending_review"}
        pending = client.get("/api/transactions", params=pending_params, headers=primary_headers).json()
        assert pending["total"] == 0
        # A part can still be fetched directly.
        part = client.get(f"/api/transactions/{part_ids[0]}", headers=primary_headers).json()
        assert part["split_parent_id"] == str(txn.id) and part["parts"] == []

        periods = {p["period_key"]: p for p in client.get("/api/periods", headers=primary_headers).json()}
        assert periods[PERIOD]["transaction_count"] == 1
        assert periods[PERIOD]["pending_review_count"] == 0

        resp = client.delete(f"/api/transactions/{txn.id}/split", headers=primary_headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["is_split"] is False and resp.json()["parts"] == []
        assert client.get(f"/api/transactions/{part_ids[0]}", headers=primary_headers).status_code == 404

    def test_validation_and_refusals(self, client, primary_headers, seeded_db, config):
        txn = _waitrose(seeded_db, config)
        transfer = make_transaction(
            seeded_db, config, amount="-50.00", raw_description="CARD PAYMENT", is_internal_transfer=True
        )
        seeded_db.commit()

        short = {"parts": [{"amount": "-6.00", "category": "Groceries", "claim_type": "personal"}]}
        assert _put_split(client, primary_headers, txn.id, short).status_code == 422
        wrong_sum = {
            "parts": [
                {"amount": "-6.00", "category": "Groceries", "claim_type": "personal"},
                {"amount": "-3.50", "category": "Shopping:Home", "claim_type": "personal"},
            ]
        }
        resp = _put_split(client, primary_headers, txn.id, wrong_sum)
        assert resp.status_code == 422 and "sum to -9.50" in resp.json()["detail"]
        bad_claim = {
            "parts": [
                {"amount": "-6.00", "category": "Groceries", "claim_type": "personal"},
                {"amount": "-4.00", "category": "Shopping:Home", "claim_type": "split_three_ways"},
            ]
        }
        assert _put_split(client, primary_headers, txn.id, bad_claim).status_code == 422
        made_up = {
            "parts": [
                {"amount": "-6.00", "category": "Groceries", "claim_type": "personal"},
                {"amount": "-4.00", "category": "Nonsense:Made Up", "claim_type": "personal"},
            ]
        }
        resp = _put_split(client, primary_headers, txn.id, made_up)
        assert resp.status_code == 422
        assert resp.json()["detail"] == "part 2 category 'Nonsense:Made Up' is not in the configured taxonomy"
        assert client.get(f"/api/transactions/{txn.id}", headers=primary_headers).json()["is_split"] is False

        assert _put_split(client, primary_headers, transfer.id).status_code == 409

        resp = _put_split(client, primary_headers, txn.id)
        assert resp.status_code == 200
        part_id = resp.json()["parts"][0]["id"]
        # A part cannot be split, deleted or turned into a transfer; the parent's
        # classification lives in its parts.
        assert _put_split(client, primary_headers, part_id).status_code == 409
        assert client.delete(f"/api/transactions/{part_id}", headers=primary_headers).status_code == 409
        assert _patch(client, primary_headers, part_id, {"is_internal_transfer": True}).status_code == 409
        assert _patch(client, primary_headers, txn.id, {"category": "Dining"}).status_code == 409
        assert _patch(client, primary_headers, txn.id, {"is_internal_transfer": True}).status_code == 409

        # A closed period refuses both splitting and unsplitting.
        close_period(seeded_db, PERIOD)
        seeded_db.commit()
        assert _put_split(client, primary_headers, txn.id).status_code == 409
        assert client.delete(f"/api/transactions/{txn.id}/split", headers=primary_headers).status_code == 409

    def test_parts_are_editable_and_the_parent_merchant_propagates(self, client, primary_headers, seeded_db, config):
        txn = _waitrose(seeded_db, config)
        seeded_db.commit()
        created = _put_split(client, primary_headers, txn.id).json()
        personal_id = created["parts"][1]["id"]

        resp = _patch(client, primary_headers, personal_id, {"category": "Dining", "claim_type": "shared_equal"})
        assert resp.status_code == 200, resp.text
        part = resp.json()
        assert part["category"] == "Dining" and part["claim_type"] == "shared_equal"
        assert (part["allocated_primary_amount"], part["allocated_secondary_amount"]) == ("-2.00", "-2.00")

        resp = _patch(client, primary_headers, txn.id, {"cleaned_merchant": "Waitrose Leeds"})
        assert resp.status_code == 200, resp.text
        assert {p["id"] for p in resp.json()["parts"]} == {p["id"] for p in created["parts"]}
        part = client.get(f"/api/transactions/{personal_id}", headers=primary_headers).json()
        assert part["cleaned_merchant"] == "Waitrose Leeds"

        # The settlement now shows both parts (a 50/50 part has an effect too).
        summary = client.get(f"/api/settlement/{PERIOD}", headers=primary_headers).json()
        assert sorted(line["amount"] for line in summary["lines"]) == ["-4.00", "-6.00"]
        assert all(line["merchant"] == "Waitrose Leeds" for line in summary["lines"])

    def test_splitting_does_not_touch_merchant_memory(self, client, primary_headers, seeded_db, config):
        txn = _waitrose(seeded_db, config)
        seeded_db.commit()
        assert _put_split(client, primary_headers, txn.id).status_code == 200
        assert client.get("/api/memory", headers=primary_headers).json() == []
        # Approving the (already approved) parent afterwards learns nothing either.
        approve = client.post(f"/api/transactions/{txn.id}/approve", json={"remember": True}, headers=primary_headers)
        assert approve.status_code == 200
        assert client.get("/api/memory", headers=primary_headers).json() == []

    def test_deleting_the_parent_over_the_api_removes_the_parts(self, client, primary_headers, seeded_db, config):
        txn = _waitrose(seeded_db, config)
        seeded_db.commit()
        created = _put_split(client, primary_headers, txn.id).json()
        assert client.delete(f"/api/transactions/{txn.id}", headers=primary_headers).status_code == 204
        for part in created["parts"]:
            assert client.get(f"/api/transactions/{part['id']}", headers=primary_headers).status_code == 404
