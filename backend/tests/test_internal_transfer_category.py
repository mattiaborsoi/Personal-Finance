"""Filing a line under Transfers:Internal ticks its transfer flag (edit, approval, ingestion)."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models import TransferBuffer
from tests.conftest import requires_db
from tests.factories import make_transaction
from tests.fixtures import generate
from tests.test_api import list_txns, upload

pytestmark = pytest.mark.usefixtures("client")

INTERNAL = "Transfers:Internal"


def _pending(db, config, **kw):
    kw.setdefault("account_id", "acc_checking_hsbc")
    kw.setdefault("amount", "-2000.00")
    kw.setdefault("raw_description", "ONLINE MOVE TO SAVINGS")
    kw.setdefault("review_status", "pending_review")
    kw.setdefault("classification_source", "llm")
    txn = make_transaction(db, config, **kw)
    db.commit()
    return txn


def _buffered(db, txn) -> bool:
    return db.scalar(select(TransferBuffer).where(TransferBuffer.transaction_id == txn.id)) is not None


@requires_db
def test_choosing_the_category_ticks_the_transfer_flag(client, primary_headers, seeded_db, config):
    txn = _pending(seeded_db, config, category="Uncategorized", claim_type="shared_equal")
    resp = client.patch(f"/api/transactions/{txn.id}", headers=primary_headers, json={"category": INTERNAL})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["category"] == INTERNAL
    assert body["is_internal_transfer"] is True
    assert body["claim_type"] == "personal"
    assert body["review_status"] == "pending_review"
    seeded_db.expire_all()
    assert _buffered(seeded_db, txn)


@requires_db
def test_an_explicit_no_in_the_same_request_wins(client, primary_headers, seeded_db, config):
    txn = _pending(seeded_db, config, category="Uncategorized")
    resp = client.patch(
        f"/api/transactions/{txn.id}",
        headers=primary_headers,
        json={"category": INTERNAL, "is_internal_transfer": False},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_internal_transfer"] is False


@requires_db
def test_approving_a_line_the_ai_filed_there_ticks_it(client, primary_headers, seeded_db, config):
    txn = _pending(seeded_db, config, category=INTERNAL, claim_type="shared_equal")
    resp = client.post(f"/api/transactions/{txn.id}/approve", headers=primary_headers, json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["review_status"] == "manual_approved"
    assert body["is_internal_transfer"] is True
    assert body["claim_type"] == "personal"


@requires_db
def test_batch_approval_ticks_it_too_and_leaves_other_lines_alone(client, primary_headers, seeded_db, config):
    internal = _pending(seeded_db, config, category=INTERNAL)
    groceries = _pending(seeded_db, config, category="Groceries", raw_description="WAITROSE 1234", amount="-15.81")
    resp = client.post(
        "/api/transactions/approve-batch", headers=primary_headers, json={"ids": [str(internal.id), str(groceries.id)]}
    )
    assert resp.status_code == 200, resp.text
    by_id = {row["id"]: row for row in resp.json()["items"]}
    assert by_id[str(internal.id)]["is_internal_transfer"] is True
    assert by_id[str(groceries.id)]["is_internal_transfer"] is False


@requires_db
def test_an_edit_that_does_not_touch_the_category_never_re_ticks(client, primary_headers, seeded_db, config):
    """Someone who unticked the flag on purpose keeps it off while editing a note."""
    txn = _pending(seeded_db, config, category=INTERNAL)
    resp = client.patch(f"/api/transactions/{txn.id}", headers=primary_headers, json={"note": "Moved to savings"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_internal_transfer"] is False


@requires_db
def test_ingestion_flags_a_line_the_classifier_files_as_an_internal_transfer(
    client, primary_headers, fake_llm, tmp_path
):
    def handler(system: str, user: str) -> dict:
        if "summary_sentence" in system:
            return {"summary_sentence": "Stub."}
        return {"merchant": "Somewhere", "category": INTERNAL, "claim_type": "shared_equal", "confidence": 0.6}

    fake_llm.handler = handler
    path = generate.checking_csv(tmp_path / "statement.csv")
    resp = upload(client, primary_headers, path, account_id="acc_checking_hsbc")
    assert resp.status_code == 200, resp.text
    llm_lines = [t for t in list_txns(client, primary_headers) if t["classification_source"] == "llm"]
    assert llm_lines, "expected at least one line classified by the stub"
    for t in llm_lines:
        assert t["category"] == INTERNAL
        assert t["is_internal_transfer"] is True
        assert t["claim_type"] == "personal"



@requires_db
def test_ticking_the_transfer_box_files_it_as_an_internal_transfer(client, primary_headers, seeded_db, config):
    txn = _pending(seeded_db, config, category="Fees:Interest", claim_type="personal")
    url = f"/api/transactions/{txn.id}"
    body = client.patch(url, headers=primary_headers, json={"is_internal_transfer": True}).json()
    assert body["is_internal_transfer"] is True and body["category"] == INTERNAL

    # Unticking takes it back out, so approving doesn't tick it again.
    body = client.patch(url, headers=primary_headers, json={"is_internal_transfer": False}).json()
    assert body["is_internal_transfer"] is False and body["category"] == "Uncategorized"
    approved = client.post(f"{url}/approve", headers=primary_headers, json={}).json()
    assert approved["is_internal_transfer"] is False


@requires_db
def test_a_category_named_in_the_same_request_wins(client, primary_headers, seeded_db, config):
    txn = _pending(seeded_db, config, category="Uncategorized")
    body = client.patch(
        f"/api/transactions/{txn.id}",
        headers=primary_headers,
        json={"is_internal_transfer": True, "category": "Transfers:Investment"},
    ).json()
    assert body["is_internal_transfer"] is True and body["category"] == "Transfers:Investment"
