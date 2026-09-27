"""POST /api/system/reset: wipe the ledger, or the whole installation back to day one."""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from app.models import (
    Account,
    AppSetting,
    AuditReport,
    LedgerPeriod,
    MerchantMemory,
    PartnerClaim,
    SettlementSnapshot,
    StatementUpload,
    Transaction,
    TransferBuffer,
)
from app.services import memory
from tests.conftest import requires_db
from tests.fixtures import generate
from tests.test_api import find, keyword_llm, list_txns, upload

pytestmark = pytest.mark.usefixtures("client")

LEDGER_MODELS = (Transaction, TransferBuffer, StatementUpload, AuditReport, SettlementSnapshot)
EXTRA_ACCOUNT = {
    "id": "acc_checking_extra",
    "institution": "Example Bank",
    "account_type": "checking",
    "owner": "user_primary",
    "identifier_last4": "9090",
}


@pytest.fixture
def fx(tmp_path):
    return generate.build_all(tmp_path / "fixtures")


@pytest.fixture
def llm_stub(fake_llm):
    fake_llm.handler = keyword_llm
    return fake_llm


def _count(db, model) -> int:
    return int(db.scalar(select(func.count()).select_from(model)) or 0)


def _reset(client, headers, scope: str, confirm: str):
    return client.post("/api/system/reset", headers=headers, json={"scope": scope, "confirm": confirm})


@pytest.fixture
def populated(client, primary_headers, secondary_headers, llm_stub, fx, seeded_db, embedder) -> dict:
    """A lived-in installation: two uploads (a matched card payment, an investment mirror,
    a split line), claims in two months, an audit report, a closed month with its settlement
    snapshot, a merchant memory row, an account added in the app and a saved household setting."""
    assert upload(client, primary_headers, fx["amex_pdf"]).status_code == 200
    assert upload(client, primary_headers, fx["hsbc_table_pdf"]).status_code == 200
    energy = find(list_txns(client, primary_headers), "NORTHWIND")
    parts = [
        {"amount": "-50.00", "category": "Bills:Energy", "claim_type": "shared_proportional"},
        {"amount": "-37.27", "category": "Bills:Energy", "claim_type": "personal"},
    ]
    assert client.put(f"/api/transactions/{energy['id']}/split", headers=primary_headers,
                      json={"parts": parts}).status_code == 200
    for claim_date in ("2026-08-10", "2026-06-15"):
        body = {"claim_date": claim_date, "amount": "20.00", "merchant": "Corner Shop"}
        assert client.post("/api/claims", headers=secondary_headers, json=body).status_code == 201
    assert client.post("/api/audit/2026-08/run", headers=primary_headers).status_code == 200
    assert client.post("/api/periods/2026-07/close", headers=primary_headers,
                       params={"force": "true"}).status_code == 200
    memory.remember(seeded_db, embedder, "OCADO RETAIL LTD", normalized_merchant="Ocado",
                    category="Groceries", claim_type="shared_proportional")
    seeded_db.commit()
    assert client.post("/api/accounts", headers=primary_headers, json=EXTRA_ACCOUNT).status_code == 201
    default_split = client.get("/api/settings/household", headers=primary_headers).json()["split_strategy"]
    saved = client.put("/api/settings/household", headers=primary_headers, json={"split_strategy": "equal_50_50"})
    assert saved.status_code == 200, saved.text

    counts = {model: _count(seeded_db, model) for model in (*LEDGER_MODELS, PartnerClaim, LedgerPeriod)}
    assert all(counts.values()), counts
    # 8 card lines + 6 checking lines + the investment mirror + 2 split parts.
    assert counts[Transaction] == 17
    return {"default_split": default_split, "transactions": counts[Transaction]}


@requires_db
def test_reset_transactions_wipes_the_ledger_and_keeps_the_rest(
    client, primary_headers, populated, seeded_db, config, fx
):
    resp = _reset(client, primary_headers, "transactions", "  DELETE TRANSACTIONS ")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "scope": "transactions",
        "deleted": {
            "transactions": populated["transactions"],
            "uploads": 2,
            "claims": 0,
            "periods": 1,  # July (closed, no claims); June and August keep their claims
            "memory": 0,
            "accounts": 0,
            "settings": 0,
        },
    }

    for model in LEDGER_MODELS:
        assert _count(seeded_db, model) == 0, model.__name__
    assert list_txns(client, primary_headers) == []
    assert client.get("/api/statements", headers=primary_headers).json() == []
    assert {p["period_key"] for p in client.get("/api/periods", headers=primary_headers).json()} == {
        "2026-06",
        "2026-08",
    }
    assert len(client.get("/api/claims", headers=primary_headers).json()) == 2
    assert _count(seeded_db, MerchantMemory) == 1
    account_ids = {a["id"] for a in client.get("/api/accounts", headers=primary_headers).json()}
    assert account_ids == {a.id for a in config.accounts} | {EXTRA_ACCOUNT["id"]}
    household = client.get("/api/settings/household", headers=primary_headers).json()
    assert household["split_strategy"] == "equal_50_50"

    # The files were forgotten along with their lines: they go in again.
    again = upload(client, primary_headers, fx["amex_pdf"])
    assert again.status_code == 200 and again.json()["inserted"] == 8


@requires_db
def test_reset_everything_returns_to_day_one(client, primary_headers, secondary_headers, populated, seeded_db, config):
    settings_rows = _count(seeded_db, AppSetting)
    assert settings_rows >= 1

    resp = _reset(client, primary_headers, "everything", "DELETE EVERYTHING")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "scope": "everything",
        "deleted": {
            "transactions": populated["transactions"],
            "uploads": 2,
            "claims": 2,
            "periods": 3,
            "memory": 1,
            "accounts": len(config.accounts) + 1,
            "settings": settings_rows,
        },
    }

    for model in (*LEDGER_MODELS, PartnerClaim, LedgerPeriod, MerchantMemory, AppSetting):
        assert _count(seeded_db, model) == 0, model.__name__
    # The accounts are seeded from the configuration again, in its order, as on first start.
    seeded = seeded_db.scalars(select(Account).order_by(Account.sort_order)).all()
    assert [a.id for a in seeded] == [a.id for a in config.accounts]
    listed = client.get("/api/accounts", headers=primary_headers).json()
    assert {a["id"] for a in listed} == {a.id for a in config.accounts}
    assert all(a["transaction_count"] == 0 for a in listed)
    household = client.get("/api/settings/household", headers=primary_headers).json()
    assert household["split_strategy"] == populated["default_split"]
    assert client.get("/api/claims", headers=primary_headers).json() == []
    assert client.get("/api/periods", headers=primary_headers).json() == []

    # Logins are untouched: the same session keeps working and both passwords still sign in.
    assert client.get("/api/transactions", headers=primary_headers).status_code == 200
    assert client.get("/api/auth/me", headers=secondary_headers).status_code == 200
    assert client.post("/api/auth/login", json={"password": "secondary-pass"}).status_code == 200


@requires_db
def test_reset_needs_the_exact_phrase(client, primary_headers, llm_stub, fx, seeded_db):
    assert upload(client, primary_headers, fx["amex_pdf"]).status_code == 200
    cases = [
        ("transactions", "delete transactions", "type DELETE TRANSACTIONS to confirm"),
        ("transactions", "DELETE EVERYTHING", "type DELETE TRANSACTIONS to confirm"),
        ("transactions", "", "type DELETE TRANSACTIONS to confirm"),
        ("everything", "DELETE TRANSACTIONS", "type DELETE EVERYTHING to confirm"),
        ("everything", "DELETE  EVERYTHING", "type DELETE EVERYTHING to confirm"),
    ]
    for scope, phrase, message in cases:
        resp = _reset(client, primary_headers, scope, phrase)
        assert resp.status_code == 422, (scope, phrase)
        assert resp.json()["detail"] == message
    no_confirm = client.post("/api/system/reset", headers=primary_headers, json={"scope": "everything"})
    assert no_confirm.status_code == 422 and no_confirm.json()["detail"] == "type DELETE EVERYTHING to confirm"
    assert _reset(client, primary_headers, "all", "DELETE EVERYTHING").status_code == 422
    assert _count(seeded_db, Transaction) == 8  # nothing was deleted


@requires_db
def test_reset_is_primary_only(client, primary_headers, secondary_headers, llm_stub, fx, seeded_db):
    assert upload(client, primary_headers, fx["amex_pdf"]).status_code == 200
    for scope, phrase in (("transactions", "DELETE TRANSACTIONS"), ("everything", "DELETE EVERYTHING")):
        assert _reset(client, secondary_headers, scope, phrase).status_code == 403
    anonymous = client.post("/api/system/reset", json={"scope": "everything", "confirm": "DELETE EVERYTHING"})
    assert anonymous.status_code == 401
    assert _count(seeded_db, Transaction) == 8
