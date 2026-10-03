"""Regression tests for the findings of the pipeline correctness review."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from app.models import PartnerClaim, StatementUpload, Transaction, TransferBuffer
from app.services import ingestion
from app.services.parsers.base import ParsedStatement, ParsedTransaction, StatementMetadata
from tests.conftest import requires_db
from tests.factories import make_transaction
from tests.fixtures import generate
from tests.test_api import find, keyword_llm, list_txns, upload

pytestmark = pytest.mark.usefixtures("client")


@pytest.fixture
def fx(tmp_path) -> dict[str, Path]:
    return generate.build_all(tmp_path / "fx")


@pytest.fixture
def llm_stub(fake_llm):
    fake_llm.handler = keyword_llm
    return fake_llm


def _write(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path


@requires_db
def test_card_export_with_explicit_account_keeps_card_sign_convention(client, primary_headers, llm_stub, tmp_path):
    """A bare 'Amount' column on a card export prints charges as positive numbers."""
    csv = _write(
        tmp_path / "activity.csv",
        "Date,Description,Amount\n15/08/2026,WAITROSE,15.81\n24/08/2026,BRITISH AIRWAYS,-357.99\n",
    )
    resp = upload(client, primary_headers, csv, account_id="acc_cc_amex")
    assert resp.status_code == 200, resp.text
    rows = list_txns(client, primary_headers)
    assert Decimal(find(rows, "WAITROSE")["amount"]) == Decimal("-15.81")
    assert Decimal(find(rows, "BRITISH AIRWAYS")["amount"]) == Decimal("357.99")

    # The same export for a current account is read at face value, with a warning.
    csv2 = _write(tmp_path / "export.csv", "Date,Description,Amount\n03/08/2026,COFFEE HOUSE,-3.20\n")
    resp = upload(client, primary_headers, csv2, account_id="acc_checking_hsbc")
    assert resp.status_code == 200, resp.text
    assert Decimal(find(list_txns(client, primary_headers), "COFFEE")["amount"]) == Decimal("-3.20")


@requires_db
def test_ambiguous_export_without_account_warns_about_sign_convention(client, primary_headers, llm_stub, tmp_path):
    csv = _write(tmp_path / "export.csv", "Date,Description,Amount\n03/08/2026,COFFEE HOUSE,-3.20\n")
    resp = upload(client, primary_headers, csv)
    assert resp.status_code == 422  # no account can be inferred; the UI asks


@requires_db
def test_identical_same_day_investment_transfers_each_get_a_mirror(client, primary_headers, llm_stub, tmp_path):
    csv = _write(
        tmp_path / "hsbc_4471_aug.csv",
        "Date,Description,Paid Out,Paid In,Balance\n"
        "05/08/2026,ROBINHOOD,500.00,,1000.00\n05/08/2026,ROBINHOOD,500.00,,500.00\n",
    )
    resp = upload(client, primary_headers, csv, account_id="acc_checking_hsbc")
    assert resp.status_code == 200, resp.text
    assert resp.json()["inserted"] == 2
    rows = list_txns(client, primary_headers)
    mirrors = [t for t in rows if t["account_id"] == "acc_invest_robinhood"]
    assert len(mirrors) == 2 and all(m["linked_transfer_id"] for m in mirrors)
    inv = client.get("/api/metrics/investment", headers=primary_headers).json()
    assert Decimal(inv["net_invested_capital"]) == Decimal("1000.00")
    assert client.get("/api/transfers/unmatched", headers=primary_headers).json() == []


@requires_db
def test_removing_the_checking_leg_removes_its_mirror(client, primary_headers, llm_stub, fx, seeded_db):
    assert upload(client, primary_headers, fx["hsbc_table_pdf"]).status_code == 200
    rows = list_txns(client, primary_headers)
    robinhood = find([t for t in rows if t["account_id"] == "acc_checking_hsbc"], "ROBINHOOD")

    # Un-flagging as a transfer deletes the mirror rather than orphaning it.
    resp = client.patch(
        f"/api/transactions/{robinhood['id']}", headers=primary_headers, json={"is_internal_transfer": False}
    )
    assert resp.status_code == 200 and resp.json()["is_internal_transfer"] is False
    assert [t for t in list_txns(client, primary_headers) if t["account_id"] == "acc_invest_robinhood"] == []
    # Only the card payment (whose statement was not uploaded) is still waiting; no mirror leftovers.
    unmatched = client.get("/api/transfers/unmatched", headers=primary_headers).json()
    assert [e["account_id"] for e in unmatched] == ["acc_checking_hsbc"]
    assert all(e["transaction_id"] != robinhood["id"] for e in unmatched)
    assert Decimal(client.get("/api/metrics/investment", headers=primary_headers).json()["net_invested_capital"]) == 0

    # Re-flagging looks the rule up again and writes the mirror back; deleting the checking
    # leg then takes the mirror with it and leaves nothing of either in the buffer.
    client.patch(f"/api/transactions/{robinhood['id']}", headers=primary_headers, json={"is_internal_transfer": True})
    mirrors = [t for t in list_txns(client, primary_headers) if t["account_id"] == "acc_invest_robinhood"]
    assert len(mirrors) == 1 and mirrors[0]["linked_transfer_id"] == robinhood["id"]
    assert client.delete(f"/api/transactions/{robinhood['id']}", headers=primary_headers).status_code == 204
    assert [t for t in list_txns(client, primary_headers) if t["account_id"] == "acc_invest_robinhood"] == []
    gone = {robinhood["id"], mirrors[0]["id"]}
    assert all(str(e.transaction_id) not in gone for e in seeded_db.query(TransferBuffer).all())


@requires_db
def test_closed_period_locks_edits(client, primary_headers, llm_stub, fx):
    assert upload(client, primary_headers, fx["hsbc_table_pdf"]).status_code == 200
    claim = client.post(
        "/api/claims",
        headers=primary_headers,
        json={"claim_date": "2026-08-10", "amount": "10.00", "merchant": "Shop", "claim_type": "shared_equal"},
    ).json()
    energy = find(list_txns(client, primary_headers), "NORTHWIND")
    salary = find(list_txns(client, primary_headers), "SALARY")
    assert (
        client.post("/api/periods/2026-08/close", headers=primary_headers, params={"force": "true"}).status_code == 200
    )
    assert (
        client.post("/api/periods/2026-08/close", headers=primary_headers, params={"force": "true"}).status_code == 409
    )

    h = primary_headers
    assert client.patch(f"/api/transactions/{energy['id']}", headers=h, json={"category": "Dining"}).status_code == 409
    assert (
        client.post(f"/api/transactions/{salary['id']}/approve", headers=h, json={"remember": False}).status_code == 409
    )
    assert client.post("/api/transactions/approve-batch", headers=h, json={"ids": [salary["id"]]}).status_code == 409
    assert client.delete(f"/api/transactions/{energy['id']}", headers=h).status_code == 409
    assert client.delete(f"/api/claims/{claim['id']}", headers=h).status_code == 409
    # Transfer matching is exempt by design (the buffer persists across closes).
    assert client.post("/api/transfers/rematch", headers=h).status_code == 200

    assert client.post("/api/periods/2026-08/reopen", headers=h).status_code == 200
    assert client.patch(f"/api/transactions/{energy['id']}", headers=h, json={"category": "Dining"}).status_code == 200


@requires_db
def test_uncategorized_approval_is_not_remembered(client, primary_headers, seeded_db, config):
    txn = make_transaction(
        seeded_db,
        config,
        raw_description="MYSTERY SHOP LONDON",
        category="Uncategorized",
        review_status="pending_review",
    )
    seeded_db.commit()
    assert (
        client.post(f"/api/transactions/{txn.id}/approve", headers=primary_headers, json={"remember": True}).status_code
        == 200
    )
    assert client.get("/api/memory", headers=primary_headers).json() == []
    # Correcting it later is remembered.
    assert (
        client.patch(
            f"/api/transactions/{txn.id}", headers=primary_headers, json={"category": "Shopping:Gifts"}
        ).status_code
        == 200
    )
    memories = client.get("/api/memory", headers=primary_headers).json()
    assert len(memories) == 1 and memories[0]["category"] == "Shopping:Gifts"


@requires_db
def test_explicit_account_honours_card_sections(client, primary_headers, llm_stub, fx):
    resp = upload(client, primary_headers, fx["amex_pdf"], account_id="acc_cc_amex")
    assert resp.status_code == 200, resp.text
    rows = list_txns(client, primary_headers)
    assert find(rows, "NETFLIX")["account_id"] == "acc_cc_amex_supp"
    assert find(rows, "CINEWORLD")["account_id"] == "acc_cc_amex"


@requires_db
def test_claim_amount_rounds_half_up_and_future_dates_are_refused(client, primary_headers):
    resp = client.post(
        "/api/claims", headers=primary_headers, json={"claim_date": "2026-08-10", "amount": "0.125", "merchant": "x"}
    )
    assert resp.status_code == 201 and Decimal(resp.json()["amount"]) == Decimal("0.13")
    assert (
        client.post(
            "/api/claims", headers=primary_headers, json={"claim_date": "2099-01-01", "amount": "1.00", "merchant": "x"}
        ).status_code
        == 422
    )
    assert client.get("/api/periods", headers=primary_headers).json()[0]["period_key"] == "2026-08"


@requires_db
def test_reupload_overlapping_a_closed_month_with_nothing_new_is_accepted(client, primary_headers, llm_stub, fx):
    assert upload(client, primary_headers, fx["hsbc_table_pdf"]).status_code == 200
    assert (
        client.post("/api/periods/2026-07/close", headers=primary_headers, params={"force": "true"}).status_code == 200
    )
    again = upload(client, primary_headers, fx["hsbc_text_pdf"])
    assert again.status_code == 200, again.text
    assert again.json()["inserted"] == 0 and again.json()["skipped_duplicates"] == 6


@requires_db
def test_patch_null_subcategory_clears_it(client, primary_headers, seeded_db, config):
    txn = make_transaction(seeded_db, config, subcategory="Sub")
    seeded_db.commit()
    resp = client.patch(f"/api/transactions/{txn.id}", headers=primary_headers, json={"subcategory": None})
    assert resp.status_code == 200 and resp.json()["subcategory"] is None
    # null on other fields leaves them alone.
    resp = client.patch(f"/api/transactions/{txn.id}", headers=primary_headers, json={"category": None})
    assert resp.status_code == 200 and resp.json()["category"] == "Groceries"


def _fake_parse(lines, closing: date | None):
    def parse(path, config, llm=None, filename=None, account=None, layouts=None):
        meta = StatementMetadata(
            institution="HSBC", account_last4="4471", closing_date=closing, account_type_hint="checking"
        )
        return ParsedStatement(metadata=meta, transactions=list(lines), parser_name="fake")

    return parse


@requires_db
def test_closing_date_in_next_month_creates_no_empty_period(
    seeded_db, config, embedder, fake_llm, tmp_path, monkeypatch
):
    lines = [
        ParsedTransaction(
            date=date(2026, 8, 20), raw_text="FIBRELINE BROADBAND", amount=Decimal("-30.00"), card_last4="4471"
        )
    ]
    monkeypatch.setattr(ingestion, "parse_statement", _fake_parse(lines, closing=date(2026, 9, 2)))
    path = _write(tmp_path / "stmt.csv", "placeholder")
    result = ingestion.ingest_statement(seeded_db, config, embedder, fake_llm, path, "stmt.csv")
    assert result.inserted == 1 and result.period_key == "2026-08"
    keys = {p.period_key for p in seeded_db.query(ingestion.LedgerPeriod).all()}
    assert keys == {"2026-08"}
    assert seeded_db.get(StatementUpload, result.upload_id).period_key == "2026-08"


@requires_db
def test_zero_amount_transfer_is_not_buffered(seeded_db, config, embedder, fake_llm, tmp_path, monkeypatch):
    lines = [
        ParsedTransaction(
            date=date(2026, 8, 3), raw_text="PAYMENT RECEIVED - THANK YOU", amount=Decimal("0.00"), card_last4="4471"
        )
    ]
    monkeypatch.setattr(ingestion, "parse_statement", _fake_parse(lines, closing=None))
    path = _write(tmp_path / "zero.csv", "placeholder")
    result = ingestion.ingest_statement(seeded_db, config, embedder, fake_llm, path, "zero.csv")
    assert result.inserted == 1
    assert seeded_db.query(TransferBuffer).count() == 0
    assert any("zero-amount" in w for w in result.warnings)
    txn = seeded_db.query(Transaction).one()
    assert txn.is_internal_transfer is True


@requires_db
def test_partner_claim_delete_in_open_period_still_works(client, primary_headers, seeded_db):
    resp = client.post(
        "/api/claims", headers=primary_headers, json={"claim_date": "2026-08-10", "amount": "5.00", "merchant": "x"}
    )
    assert resp.status_code == 201
    assert client.delete(f"/api/claims/{resp.json()['id']}", headers=primary_headers).status_code == 204
    assert seeded_db.query(PartnerClaim).count() == 0
