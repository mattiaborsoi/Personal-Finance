"""DELETE /api/statements/{id}: an upload goes with everything it brought into the ledger.

Its lines, their split parts and mirror legs, and their transfer-buffer rows are
deleted; a counterpart matched to one of them waits in the buffer again; open
periods left empty go too; the same file can be uploaded again. Uploads recorded before lines carried
their upload id fall back to the filename when that is unambiguous.
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest
from sqlalchemy import func, select

from app.models import StatementUpload, Transaction, TransferBuffer
from app.services import transfers
from app.services.statement_uploads import LEGACY_AMBIGUOUS
from tests.conftest import requires_db
from tests.factories import make_transaction
from tests.fixtures import generate
from tests.test_api import find, keyword_llm, list_txns, upload

pytestmark = pytest.mark.usefixtures("client")


@pytest.fixture
def fx(tmp_path):
    return generate.build_all(tmp_path / "fixtures")


@pytest.fixture
def llm_stub(fake_llm):
    fake_llm.handler = keyword_llm
    return fake_llm


def _uploads(client, headers) -> list[dict]:
    resp = client.get("/api/statements", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _count(db, model, *where) -> int:
    return int(db.scalar(select(func.count()).select_from(model).where(*where)) or 0)


def _periods(client, headers) -> set[str]:
    return {p["period_key"] for p in client.get("/api/periods", headers=headers).json()}


def _legacy_upload(db, filename: str, count: int, sha: str) -> StatementUpload:
    """A ``statement_uploads`` row as written before lines carried their upload id."""
    row = StatementUpload(
        account_id="acc_checking_hsbc",
        period_key="2026-03",
        period_from="2026-03",
        period_to="2026-03",
        filename=filename,
        sha256=sha * 64,
        parser="csv",
        transaction_count=count,
    )
    db.add(row)
    db.flush()
    return row


@requires_db
def test_deleting_an_upload_removes_its_lines_parts_mirrors_and_buffer_rows(
    client, primary_headers, llm_stub, fx, seeded_db
):
    card = upload(client, primary_headers, fx["amex_pdf"])
    assert card.status_code == 200, card.text
    checking = upload(client, primary_headers, fx["hsbc_table_pdf"])
    assert checking.status_code == 200, checking.text
    card_id, checking_id = uuid.UUID(card.json()["upload_id"]), uuid.UUID(checking.json()["upload_id"])

    rows = list_txns(client, primary_headers)
    energy = find(rows, "NORTHWIND")
    parts = [
        {"amount": "-50.00", "category": "Bills:Energy", "claim_type": "shared_proportional"},
        {"amount": "-37.27", "category": "Bills:Energy", "claim_type": "personal"},
    ]
    resp = client.put(f"/api/transactions/{energy['id']}/split", headers=primary_headers, json={"parts": parts})
    assert resp.status_code == 200, resp.text

    # Every line, the investment mirror leg and the split parts carry the upload that brought them in.
    mirror = find([t for t in rows if t["account_id"] == "acc_invest_robinhood"], "ROBINHOOD")
    assert _count(seeded_db, Transaction, Transaction.upload_id == checking_id) == 6 + 1 + 2
    assert _count(seeded_db, Transaction, Transaction.upload_id == card_id) == 8
    assert seeded_db.get(Transaction, uuid.UUID(mirror["id"])).upload_id == checking_id
    assert {p.upload_id for p in seeded_db.get(Transaction, uuid.UUID(energy["id"])).parts} == {checking_id}
    # The card payment on the checking account is matched to the card's "payment received".
    received = find(rows, "PAYMENT RECEIVED")
    assert received["linked_transfer_id"] == find(rows, "HSBC CARD PYMT")["id"]
    assert [u["deletable"] for u in _uploads(client, primary_headers)] == [True, True]

    assert client.delete(f"/api/statements/{checking_id}", headers=primary_headers).status_code == 204

    assert _count(seeded_db, Transaction, Transaction.upload_id == checking_id) == 0
    assert _count(seeded_db, Transaction) == 8  # the card's lines, nothing else
    assert {t["account_id"] for t in list_txns(client, primary_headers)} == {"acc_cc_amex", "acc_cc_amex_supp"}
    # The counterpart is unlinked and waits in the buffer again; the other buffer rows are gone.
    after = find(list_txns(client, primary_headers), "PAYMENT RECEIVED")
    assert after["linked_transfer_id"] is None and after["is_internal_transfer"] is True
    unmatched = client.get("/api/transfers/unmatched", headers=primary_headers).json()
    assert [e["transaction_id"] for e in unmatched] == [received["id"]]
    assert unmatched[0]["match_status"] == "unmatched" and unmatched[0]["resolved_at"] is None
    assert _count(seeded_db, TransferBuffer) == 1
    # The upload is gone, the card's months stay, and a second delete finds nothing.
    assert [u["id"] for u in _uploads(client, primary_headers)] == [str(card_id)]
    assert _periods(client, primary_headers) == {"2026-07", "2026-08"}
    assert client.delete(f"/api/statements/{checking_id}", headers=primary_headers).status_code == 404

    # The same file goes in again and matches the card payment once more.
    again = upload(client, primary_headers, fx["hsbc_table_pdf"])
    assert again.status_code == 200, again.text
    assert again.json()["inserted"] == 6 and again.json()["transfers_matched"] >= 1
    rows = list_txns(client, primary_headers)
    assert find(rows, "PAYMENT RECEIVED")["linked_transfer_id"] == find(rows, "HSBC CARD PYMT")["id"]
    assert len([t for t in rows if t["account_id"] == "acc_invest_robinhood"]) == 1
    assert client.get("/api/transfers/unmatched", headers=primary_headers).json() == []


@requires_db
def test_deleting_an_upload_is_refused_while_a_period_is_closed(client, primary_headers, llm_stub, fx):
    resp = upload(client, primary_headers, fx["energy_history_csv"], account_id="acc_checking_hsbc")
    assert resp.status_code == 200, resp.text
    upload_id = resp.json()["upload_id"]
    assert resp.json()["inserted"] == 4
    closed = client.post("/api/periods/2026-06/close", headers=primary_headers, params={"force": "true"})
    assert closed.status_code == 200, closed.text

    refused = client.delete(f"/api/statements/{upload_id}", headers=primary_headers)
    assert refused.status_code == 409
    assert refused.json()["detail"] == "period 2026-06 is closed; reopen it first"
    assert len(list_txns(client, primary_headers)) == 4  # nothing was touched
    assert [u["id"] for u in _uploads(client, primary_headers)] == [upload_id]

    assert client.post("/api/periods/2026-06/reopen", headers=primary_headers).status_code == 200
    assert client.delete(f"/api/statements/{upload_id}", headers=primary_headers).status_code == 204
    assert list_txns(client, primary_headers) == []
    assert _uploads(client, primary_headers) == []
    # The months it brought in go with it, except 2026-06: closing it wrote an audit report and a snapshot.
    assert _periods(client, primary_headers) == {"2026-06"}


@requires_db
def test_unknown_upload_and_roles(client, primary_headers, secondary_headers, llm_stub, fx):
    missing = client.delete(f"/api/statements/{uuid.uuid4()}", headers=primary_headers)
    assert missing.status_code == 404 and missing.json()["detail"] == "upload not found"
    assert client.delete("/api/statements/not-a-uuid", headers=primary_headers).status_code == 422

    resp = upload(client, primary_headers, fx["energy_history_csv"], account_id="acc_checking_hsbc")
    upload_id = resp.json()["upload_id"]
    assert client.delete(f"/api/statements/{upload_id}", headers=secondary_headers).status_code == 403
    assert client.get("/api/statements", headers=secondary_headers).status_code == 403
    assert len(list_txns(client, primary_headers)) == 4


@requires_db
def test_legacy_upload_falls_back_to_its_filename(client, primary_headers, seeded_db, config):
    """Lines ingested before ``upload_id`` existed are found by ``source_file`` when the name is unambiguous."""
    first = make_transaction(
        seeded_db, config, account_id="acc_checking_hsbc", transaction_date=date(2026, 3, 3),
        amount="-40.00", raw_description="CORNER SHOP", source_file="old_statement.csv",
    )
    card_payment = make_transaction(
        seeded_db, config, account_id="acc_checking_hsbc", transaction_date=date(2026, 3, 4),
        amount="-100.00", raw_description="AMEX PAYMENT", category="Transfers:CreditCardPayment",
        claim_type="personal", source_file="old_statement.csv",
    )
    received = make_transaction(
        seeded_db, config, account_id="acc_cc_amex", transaction_date=date(2026, 3, 5),
        amount="100.00", raw_description="PAYMENT RECEIVED - THANK YOU", category="Transfers:CreditCardPayment",
        claim_type="personal", source_file="amex_march.pdf",
    )
    transfers.link(seeded_db, transfers.register_transfer(seeded_db, card_payment),
                   transfers.register_transfer(seeded_db, received))
    legacy = _legacy_upload(seeded_db, "old_statement.csv", 2, "a")
    seeded_db.commit()
    assert first.upload_id is None and card_payment.upload_id is None

    assert [(u["id"], u["deletable"]) for u in _uploads(client, primary_headers)] == [(str(legacy.id), True)]
    assert client.delete(f"/api/statements/{legacy.id}", headers=primary_headers).status_code == 204

    remaining = list_txns(client, primary_headers)
    assert [t["id"] for t in remaining] == [str(received.id)]
    assert remaining[0]["linked_transfer_id"] is None
    entry = seeded_db.scalars(select(TransferBuffer).where(TransferBuffer.transaction_id == received.id)).one()
    assert entry.match_status == "unmatched" and entry.resolved_at is None
    assert _count(seeded_db, TransferBuffer) == 1
    assert _uploads(client, primary_headers) == []


@requires_db
def test_legacy_upload_sharing_its_filename_is_refused(client, primary_headers, llm_stub, seeded_db, config, tmp_path):
    """Two uploads recorded before lines were linked, both named ``export.csv``: whose lines are whose?"""
    for day in (3, 4):
        make_transaction(
            seeded_db, config, account_id="acc_checking_hsbc", transaction_date=date(2026, 3, day),
            amount="-12.00", raw_description=f"MARKET STALL {day}", source_file="export.csv",
        )
    older = _legacy_upload(seeded_db, "export.csv", 1, "b")
    newer = _legacy_upload(seeded_db, "export.csv", 1, "c")
    nothing = _legacy_upload(seeded_db, "export.csv", 0, "d")  # every line was a duplicate
    seeded_db.commit()
    # A file uploaded today under the same generic name carries its own id and stays deletable.
    export = tmp_path / "export.csv"
    export.write_text(
        "Date,Description,Paid Out,Paid In,Balance\n03/08/2026,CORNER SHOP,12.50,,987.50\n",
        encoding="utf-8",
    )
    resp = upload(client, primary_headers, export, account_id="acc_checking_hsbc")
    assert resp.status_code == 200, resp.text
    linked = resp.json()["upload_id"]

    flags = {u["id"]: u["deletable"] for u in _uploads(client, primary_headers)}
    assert flags == {str(older.id): False, str(newer.id): False, str(nothing.id): True, linked: True}

    for legacy in (older, newer):
        refused = client.delete(f"/api/statements/{legacy.id}", headers=primary_headers)
        assert refused.status_code == 409
        assert refused.json()["detail"] == LEGACY_AMBIGUOUS
        assert refused.json()["detail"] == (
            "this upload was recorded before lines were linked to uploads; "
            "delete its transactions from the Transactions page"
        )
    assert _count(seeded_db, Transaction, Transaction.source_file == "export.csv") == 3

    # The upload that inserted nothing and today's upload delete cleanly, leaving the old lines alone.
    assert client.delete(f"/api/statements/{nothing.id}", headers=primary_headers).status_code == 204
    assert client.delete(f"/api/statements/{linked}", headers=primary_headers).status_code == 204
    assert _count(seeded_db, Transaction, Transaction.source_file == "export.csv") == 2
    assert {u["id"] for u in _uploads(client, primary_headers)} == {str(older.id), str(newer.id)}
