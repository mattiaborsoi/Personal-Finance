"""Card exports signed like a bank account (a minus on purchases) keep their signs on upload."""

from __future__ import annotations

import pytest

from tests.conftest import requires_db
from tests.test_api import list_txns, upload

pytestmark = pytest.mark.usefixtures("client")


@requires_db
def test_a_card_export_signed_like_a_bank_account_uploads_with_the_right_signs(
    client, primary_headers, fake_llm, tmp_path
):
    """Purchases carry a minus and the repayment none: purchases must stay spending, the repayment money in."""

    def handler(system: str, user: str) -> dict:
        if "summary_sentence" in system:
            return {"summary_sentence": "Stub."}
        return {"merchant": "Shop", "category": "Groceries", "claim_type": "personal", "confidence": 0.5}

    fake_llm.handler = handler
    path = tmp_path / "card_export.csv"
    path.write_text(
        "Date,Description,Amount\n"
        "03/08/2026,TESCO STORES,-12.50\n"
        "04/08/2026,PAYMENT RECEIVED - THANK YOU,300.00\n"
        "05/08/2026,PRET A MANGER,-4.20\n",
        encoding="utf-8",
    )
    resp = upload(client, primary_headers, path, account_id="acc_cc_amex")
    assert resp.status_code == 200, resp.text
    assert any("read as printed" in w for w in resp.json()["warnings"])
    amounts = {t["raw_description"]: t["amount"] for t in list_txns(client, primary_headers)}
    assert amounts["TESCO STORES"] == "-12.50"
    assert amounts["PRET A MANGER"] == "-4.20"
    assert amounts["PAYMENT RECEIVED - THANK YOU"] == "300.00"
