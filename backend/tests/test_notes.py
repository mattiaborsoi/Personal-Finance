"""Per-transaction notes: the user's own words on what a payment was.

The raw bank description is never edited (the duplicate fingerprint is built from
it); a note sits beside it, is searchable, and never changes the review status,
the classification or the allocations.
"""

from __future__ import annotations

from datetime import date

from app.services.periods import close_period
from tests.conftest import requires_db
from tests.factories import make_transaction

PERIOD = "2026-08"


def _line(db, config, **kw):
    return make_transaction(
        db,
        config,
        account_id="acc_cc_amex",
        transaction_date=date(2026, 8, 14),
        amount="-42.00",
        raw_description="PAYPAL *XJ8812 4029357733",
        cleaned_merchant="PayPal",
        category="Shopping:Home",
        claim_type="shared_proportional",
        review_status=kw.pop("review_status", "pending_review"),
        **kw,
    )


def _patch(client, headers, txn_id, body):
    return client.patch(f"/api/transactions/{txn_id}", json=body, headers=headers)


def _classification(body: dict) -> tuple:
    return (
        body["review_status"],
        body["category"],
        body["subcategory"],
        body["claim_type"],
        body["allocated_primary_amount"],
        body["allocated_secondary_amount"],
        body["raw_description"],
        body["cleaned_merchant"],
    )


@requires_db
class TestNotes:
    def test_set_trim_and_clear_without_touching_the_rest(self, client, primary_headers, seeded_db, config):
        txn = _line(seeded_db, config)
        seeded_db.commit()
        before = client.get(f"/api/transactions/{txn.id}", headers=primary_headers).json()
        assert before["note"] is None

        resp = _patch(client, primary_headers, txn.id, {"note": "  Replacement kettle from Argos  "})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["note"] == "Replacement kettle from Argos"
        assert _classification(body) == _classification(before)
        assert body["review_status"] == "pending_review"

        # A classification edit without the note leaves the note alone.
        resp = _patch(client, primary_headers, txn.id, {"subcategory": "Kitchen"})
        assert resp.json()["note"] == "Replacement kettle from Argos"

        assert _patch(client, primary_headers, txn.id, {"note": "   "}).json()["note"] is None
        _patch(client, primary_headers, txn.id, {"note": "Back again"})
        assert _patch(client, primary_headers, txn.id, {"note": None}).json()["note"] is None

    def test_note_on_an_approved_line_keeps_it_approved(self, client, primary_headers, seeded_db, config):
        txn = _line(seeded_db, config, review_status="manual_approved")
        seeded_db.commit()
        resp = _patch(client, primary_headers, txn.id, {"note": "Birthday present for Sam"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["review_status"] == "manual_approved"
        assert resp.json()["note"] == "Birthday present for Sam"

    def test_too_long_is_refused(self, client, primary_headers, seeded_db, config):
        txn = _line(seeded_db, config)
        seeded_db.commit()
        resp = _patch(client, primary_headers, txn.id, {"note": "x" * 501})
        assert resp.status_code == 422
        assert resp.json()["detail"] == "note must be at most 500 characters (got 501)"
        # Exactly 500 is fine, and surrounding spaces do not count.
        resp = _patch(client, primary_headers, txn.id, {"note": "  " + "x" * 500 + "  "})
        assert resp.status_code == 200 and len(resp.json()["note"]) == 500

    def test_search_matches_the_note(self, client, primary_headers, seeded_db, config):
        txn = _line(seeded_db, config)
        other = make_transaction(
            seeded_db,
            config,
            transaction_date=date(2026, 8, 15),
            amount="-3.20",
            raw_description="PRET A MANGER 112",
            cleaned_merchant="Pret",
            category="Coffee",
        )
        seeded_db.commit()
        _patch(client, primary_headers, txn.id, {"note": "Kettle for the flat"})

        found = client.get("/api/transactions", params={"q": "kettle"}, headers=primary_headers).json()
        assert [i["id"] for i in found["items"]] == [str(txn.id)]
        assert found["items"][0]["note"] == "Kettle for the flat"
        # The ordinary description search still works.
        found = client.get("/api/transactions", params={"q": "pret"}, headers=primary_headers).json()
        assert [i["id"] for i in found["items"]] == [str(other.id)]

    def test_approve_with_a_note_in_the_corrections(self, client, primary_headers, seeded_db, config):
        txn = _line(seeded_db, config)
        seeded_db.commit()
        resp = client.post(
            f"/api/transactions/{txn.id}/approve",
            json={"category": "Shopping:Gifts", "note": "Wedding gift, Tom and Priya"},
            headers=primary_headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["review_status"] == "manual_approved"
        assert body["category"] == "Shopping:Gifts"
        assert body["note"] == "Wedding gift, Tom and Priya"

        resp = client.post(f"/api/transactions/{txn.id}/approve", json={"note": "y" * 600}, headers=primary_headers)
        assert resp.status_code == 422

    def test_split_parts_carry_their_own_note(self, client, primary_headers, seeded_db, config):
        txn = _line(seeded_db, config)
        seeded_db.commit()
        split = {
            "parts": [
                {"amount": "-30.00", "category": "Shopping:Home", "claim_type": "shared_proportional"},
                {"amount": "-12.00", "category": "Shopping:Gifts", "claim_type": "personal"},
            ]
        }
        created = client.put(f"/api/transactions/{txn.id}/split", json=split, headers=primary_headers).json()
        part_id = created["parts"][1]["id"]

        assert _patch(client, primary_headers, txn.id, {"note": "Argos order 5512"}).status_code == 200
        resp = _patch(client, primary_headers, part_id, {"note": "Card for Mum"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["note"] == "Card for Mum"
        assert resp.json()["category"] == "Shopping:Gifts"

        parent = client.get(f"/api/transactions/{txn.id}", headers=primary_headers).json()
        assert parent["note"] == "Argos order 5512"
        assert [p["note"] for p in parent["parts"]] == [None, "Card for Mum"]
        # Searching for a part's note finds the parent it is embedded in.
        found = client.get("/api/transactions", params={"q": "for mum"}, headers=primary_headers).json()
        assert [i["id"] for i in found["items"]] == [str(txn.id)]

    def test_closed_period_refuses_a_note(self, client, primary_headers, seeded_db, config):
        txn = _line(seeded_db, config, review_status="manual_approved")
        close_period(seeded_db, PERIOD)
        seeded_db.commit()
        resp = _patch(client, primary_headers, txn.id, {"note": "Too late"})
        assert resp.status_code == 409
        assert "closed" in resp.json()["detail"]
