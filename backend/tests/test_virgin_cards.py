"""A Virgin Money statement holding a main and a supplementary card (synthetic data)."""

from __future__ import annotations

import pytest

from tests.conftest import requires_db
from tests.fixtures import generate
from tests.test_api import list_txns, upload

pytestmark = pytest.mark.usefixtures("client")


@pytest.fixture
def stub_llm(fake_llm):
    def handler(system: str, user: str) -> dict:
        if "summary_sentence" in system:
            return {"summary_sentence": "Stub."}
        return {"merchant": "Shop", "category": "Groceries", "claim_type": "personal", "confidence": 0.5}

    fake_llm.handler = handler
    return fake_llm


@requires_db
def test_supplementary_card_lines_land_on_their_own_account(client, primary_headers, stub_llm, tmp_path):
    resp = client.post(
        "/api/accounts",
        headers=primary_headers,
        json={
            "institution": "Virgin",
            "label": "Virgin supplementary",
            "account_type": "credit_supplementary",
            "owner": "user_secondary",
            "identifier_last4": "6617",
            "billed_to": "user_primary",
        },
    )
    assert resp.status_code == 201, resp.text
    supp = resp.json()["id"]

    statement = generate.virgin_statement_pdf(tmp_path / "virgin.pdf")
    resp = upload(client, primary_headers, statement, account_id="acc_cc_virgin")
    assert resp.status_code == 200, resp.text
    assert not any("matched no account" in w for w in resp.json()["warnings"])
    by_account = {}
    for t in list_txns(client, primary_headers):
        by_account.setdefault(t["account_id"], []).append(t["raw_description"])
    assert sorted(by_account[supp]) == ["BOOTS THE CHEMIST", "PRET A MANGER"]
    assert len(by_account["acc_cc_virgin"]) == 3


@requires_db
def test_lines_from_an_unknown_card_are_flagged_not_filed_silently(client, primary_headers, stub_llm, tmp_path):
    statement = generate.virgin_statement_pdf(tmp_path / "virgin.pdf")
    resp = upload(client, primary_headers, statement, account_id="acc_cc_virgin")
    assert resp.status_code == 200, resp.text
    warnings = [w for w in resp.json()["warnings"] if "matched no account" in w]
    assert warnings == [
        "2 lines from the card ending 6617 matched no account and were filed to Virgin Money credit card ··5502. "
        "Add that card under Settings, Accounts (a supplementary card is held by its user and billed to whoever "
        "pays), then remove this upload and upload the statement again."
    ]
