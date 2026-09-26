"""End-to-end API tests: upload -> classify -> reconcile -> approve -> settle -> audit -> close.

The LLM is a keyword stub (``keyword_llm``) so the tests are fully offline; the
parsers, rules engine, transfer buffer, settlement and metrics all run for real
against PostgreSQL.
"""

from __future__ import annotations

import io
from decimal import Decimal
from pathlib import Path

import pytest

from app.services import guesser
from tests.conftest import requires_db
from tests.fixtures import generate

pytestmark = pytest.mark.usefixtures("client")

KEYWORDS = [
    ("CINEWORLD", "Cineworld", "Entertainment", "personal"),
    ("ANTHROPIC", "Anthropic", "Subscriptions:Software", "personal"),
    ("BRITISH AIRWAYS", "British Airways", "Travel", "shared_proportional"),
    ("ZOOM OCADO", "Ocado", "Groceries", "shared_proportional"),
    ("WAITROSE", "Waitrose", "Groceries", "shared_proportional"),
    ("NETFLIX", "Netflix", "Subscriptions:Entertainment", "shared_equal"),
    ("SALARY", "Salary", "Income:Salary", "personal"),
]


def keyword_llm(system: str, user: str) -> dict:
    """Stub LLM: classifies by keyword in the merchant line, ignoring few-shot example lines."""
    if "summary_sentence" in system:
        return {"summary_sentence": "Stub audit summary."}
    target = "\n".join(line for line in user.splitlines() if "->" not in line).upper()
    for key, merchant, category, claim_type in KEYWORDS:
        if key in target:
            return {
                "merchant": merchant,
                "category": category,
                "claim_type": claim_type,
                "confidence": 0.9,
                "reasoning": "stub",
            }
    return {"merchant": "Unknown", "category": "Uncategorized", "claim_type": "personal", "confidence": 0.2}


def upload(client, headers, path: Path, account_id: str | None = None):
    data = {"account_id": account_id} if account_id else {}
    with open(path, "rb") as fh:
        return client.post(
            "/api/statements/upload",
            headers=headers,
            files={"file": (path.name, fh, "application/octet-stream")},
            data=data,
        )


def list_txns(client, headers, **params):
    resp = client.get("/api/transactions", headers=headers, params={"limit": 500, **params})
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


def find(items, needle: str):
    matches = [t for t in items if needle.upper() in t["raw_description"].upper()]
    assert matches, f"no transaction containing {needle!r} in {[t['raw_description'] for t in items]}"
    return matches[0]


@pytest.fixture
def fixtures_dir(tmp_path) -> dict[str, Path]:
    """Synthetic statements built at run time (see tests/fixtures/generate.py).

    ``anon_csv`` is the checking CSV under a name that reveals neither institution
    nor account digits, to exercise the ambiguous-account path.
    """
    d = tmp_path / "fixtures"
    d.mkdir()
    fx = generate.build_all(d)
    anon = d / "export.csv"
    anon.write_text(
        "Date,Description,Paid Out,Paid In,Balance\n"
        "03/08/2026,CORNER SHOP,12.50,,987.50\n"
        "04/08/2026,COFFEE HOUSE,3.20,,984.30\n",
        encoding="utf-8",
    )
    fx["anon_csv"] = anon
    return fx


@pytest.fixture
def llm_stub(fake_llm):
    fake_llm.handler = keyword_llm
    return fake_llm


# --------------------------------------------------------------------------- #
# Auth & roles
# --------------------------------------------------------------------------- #


@requires_db
def test_login_and_role_gates(client, primary_headers, secondary_headers):
    assert client.post("/api/auth/login", json={"password": "nope"}).status_code == 401
    assert client.get("/api/transactions").status_code == 401
    assert client.get("/api/transactions", headers={"Authorization": "Bearer junk"}).status_code == 401

    me = client.get("/api/auth/me", headers=secondary_headers).json()
    assert me["role"] == "secondary" and me["user_id"] == "user_secondary"

    # secondary may read config / settlement / claims but nothing else
    assert client.get("/api/config", headers=secondary_headers).status_code == 200
    assert client.get("/api/settlement/2026-08", headers=secondary_headers).status_code == 200
    assert client.get("/api/claims", headers=secondary_headers).status_code == 200
    for path in ("/api/transactions", "/api/periods", "/api/metrics/2026-08", "/api/memory", "/api/statements"):
        assert client.get(path, headers=secondary_headers).status_code == 403, path

    cfg = client.get("/api/config", headers=primary_headers).json()
    assert cfg["currency_symbol"] == "£"
    assert abs(cfg["split"]["primary_ratio"] - 0.555556) < 1e-6
    assert "primary_personal" in cfg["claim_types"]
    assert "base_salary_pa" not in str(cfg)  # salaries never leave the server
    labels = {a["id"]: a["label"] for a in cfg["accounts"]}
    assert labels["acc_checking_hsbc"] == "HSBC Premier"
    assert labels["acc_cc_amex_supp"] == "Amex Platinum (supplementary)"


# --------------------------------------------------------------------------- #
# Ingestion
# --------------------------------------------------------------------------- #


@requires_db
def test_upload_amex_statement_end_to_end(client, primary_headers, llm_stub, fixtures_dir):
    resp = upload(client, primary_headers, fixtures_dir["amex_pdf"])
    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert result["inserted"] == 8
    assert result["skipped_duplicates"] == 0
    assert result["auto_approved"] == 1  # the "payment received" transfer
    assert result["pending_review"] == 7
    assert result["period_key"] == "2026-08"

    aug = list_txns(client, primary_headers, period="2026-08")
    jul = list_txns(client, primary_headers, period="2026-07")
    assert len(aug) + len(jul) == 8

    waitrose = find(aug, "WAITROSE")
    assert waitrose["account_id"] == "acc_cc_amex"
    assert Decimal(waitrose["amount"]) == Decimal("-15.81")
    assert waitrose["category"] == "Groceries"
    assert waitrose["claim_type"] == "shared_proportional"
    assert waitrose["review_status"] == "pending_review"
    assert waitrose["classification_source"] == "llm"
    assert Decimal(waitrose["allocated_primary_amount"]) == Decimal("-8.78")
    assert Decimal(waitrose["allocated_secondary_amount"]) == Decimal("-7.03")

    anthropic = find(aug, "ANTHROPIC")
    assert Decimal(anthropic["amount"]) == Decimal("-18.40")
    assert anthropic["original_currency"] == "USD"
    assert Decimal(anthropic["foreign_amount"]) == Decimal("24.00")

    ba = find(aug, "BRITISH AIRWAYS")
    assert Decimal(ba["amount"]) == Decimal("357.99")  # refund is positive
    assert ba["claim_type"] == "shared_proportional"
    assert Decimal(ba["allocated_secondary_amount"]) == Decimal("159.11")

    netflix = find(aug, "NETFLIX")
    assert netflix["account_id"] == "acc_cc_amex_supp"
    assert netflix["claim_type"] == "shared_equal"
    assert Decimal(netflix["allocated_primary_amount"]) == Decimal("-3.00")
    assert Decimal(netflix["allocated_secondary_amount"]) == Decimal("-2.99")

    supp_waitrose = find(jul, "WAITROSE")
    assert supp_waitrose["account_id"] == "acc_cc_amex_supp"
    assert Decimal(supp_waitrose["amount"]) == Decimal("-16.40")

    payment = find(jul, "PAYMENT RECEIVED")
    assert payment["is_internal_transfer"] is True
    assert payment["review_status"] == "auto_approved"
    assert payment["category"].startswith("Transfers:")
    assert Decimal(payment["amount"]) == Decimal("3384.21")

    # Blueprint fixture 1: every line lands with the expected category and claim type
    # (the LLM stub is the oracle; this proves the pipeline preserves its answer).
    everything = aug + jul
    expected = {
        "CINEWORLD": ("acc_cc_amex", "Entertainment", "personal"),
        "ANTHROPIC": ("acc_cc_amex", "Subscriptions:Software", "personal"),
        "BRITISH AIRWAYS": ("acc_cc_amex", "Travel", "shared_proportional"),
        "ZOOM OCADO": ("acc_cc_amex_supp", "Groceries", "shared_proportional"),
        "NETFLIX": ("acc_cc_amex_supp", "Subscriptions:Entertainment", "shared_equal"),
    }
    for needle, (account_id, category, claim_type) in expected.items():
        row = find(everything, needle)
        assert (row["account_id"], row["category"], row["claim_type"]) == (account_id, category, claim_type), needle
        assert row["review_status"] == "pending_review" and row["classification_source"] == "llm", needle
    waitrose_rows = [t for t in everything if "WAITROSE" in t["raw_description"]]
    assert {(t["account_id"], t["category"], t["claim_type"]) for t in waitrose_rows} == {
        ("acc_cc_amex", "Groceries", "shared_proportional"),
        ("acc_cc_amex_supp", "Groceries", "shared_proportional"),
    }

    # Same file again -> rejected as a duplicate upload.
    assert upload(client, primary_headers, fixtures_dir["amex_pdf"]).status_code == 409

    uploads = client.get("/api/statements", headers=primary_headers).json()
    assert len(uploads) == 1 and uploads[0]["transaction_count"] == 8

    periods = client.get("/api/periods", headers=primary_headers).json()
    assert [p["period_key"] for p in periods] == ["2026-08", "2026-07"]
    assert periods[0]["pending_review_count"] > 0


@requires_db
def test_checking_statement_rules_transfers_and_mirrors(client, primary_headers, llm_stub, fixtures_dir):
    assert upload(client, primary_headers, fixtures_dir["amex_pdf"]).status_code == 200
    resp = upload(client, primary_headers, fixtures_dir["hsbc_table_pdf"])
    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert result["account_id"] == "acc_checking_hsbc"
    assert result["inserted"] == 6
    # card payment <-> "payment received" and checking -> investment mirror
    assert result["transfers_matched"] >= 1

    all_txns = list_txns(client, primary_headers)
    energy = find(all_txns, "NORTHWIND")
    assert energy["category"] == "Bills:Energy"
    assert energy["claim_type"] == "shared_proportional"
    assert energy["review_status"] == "auto_approved"
    assert energy["classification_source"] == "rule"
    assert Decimal(energy["allocated_primary_amount"]) == Decimal("-48.48")
    assert Decimal(energy["allocated_secondary_amount"]) == Decimal("-38.79")

    broadband = find(all_txns, "FIBRELINE")
    assert broadband["category"] == "Bills:Internet" and broadband["review_status"] == "auto_approved"

    partner = find(all_txns, "PARTNER TRANSFER")
    assert partner["category"] == "Transfers:Settlement"
    assert Decimal(partner["amount"]) == Decimal("1685.73")

    card_pymt = find(all_txns, "HSBC CARD PYMT")
    assert card_pymt["is_internal_transfer"] is True
    assert card_pymt["linked_transfer_id"] is not None
    payment_received = find(all_txns, "PAYMENT RECEIVED")
    assert payment_received["linked_transfer_id"] == card_pymt["id"]
    assert card_pymt["linked_transfer_id"] == payment_received["id"]

    robinhood = [t for t in all_txns if t["account_id"] == "acc_checking_hsbc" and "ROBINHOOD" in t["raw_description"]]
    assert len(robinhood) == 1 and robinhood[0]["is_internal_transfer"] is True
    mirror = [t for t in all_txns if t["account_id"] == "acc_invest_robinhood"]
    assert len(mirror) == 1 and Decimal(mirror[0]["amount"]) == Decimal("500.00")
    assert mirror[0]["linked_transfer_id"] == robinhood[0]["id"]

    inv = client.get("/api/metrics/investment", headers=primary_headers).json()
    assert Decimal(inv["total_deposits"]) == Decimal("500.00")
    assert Decimal(inv["net_invested_capital"]) == Decimal("500.00")
    assert Decimal(inv["realized_gain"]) == Decimal("0.00")

    # Every transfer is now matched, nothing is left in the buffer.
    assert client.get("/api/transfers/unmatched", headers=primary_headers).json() == []

    # A different file carrying the same lines inserts nothing new.
    again = upload(client, primary_headers, fixtures_dir["hsbc_text_pdf"])
    assert again.status_code == 200, again.text
    assert again.json()["inserted"] == 0
    assert again.json()["skipped_duplicates"] == 6


@requires_db
def test_upload_validation(client, primary_headers, llm_stub, fixtures_dir):
    # A bare CSV export carries no institution / last-4 -> ambiguous.
    resp = upload(client, primary_headers, fixtures_dir["anon_csv"])
    assert resp.status_code == 422, resp.text
    assert "candidates" in str(resp.json()["detail"])

    ok = upload(client, primary_headers, fixtures_dir["anon_csv"], account_id="acc_checking_hsbc")
    assert ok.status_code == 200, ok.text
    assert ok.json()["inserted"] == 2
    assert ok.json()["account_id"] == "acc_checking_hsbc"

    # The xlsx export carries different rows; its csv twin then inserts nothing new.
    xlsx = upload(client, primary_headers, fixtures_dir["checking_xlsx"], account_id="acc_checking_hsbc")
    assert xlsx.status_code == 200 and xlsx.json()["inserted"] == 6
    twin = upload(client, primary_headers, fixtures_dir["checking_csv"], account_id="acc_checking_hsbc")
    assert twin.status_code == 200 and twin.json()["inserted"] == 0
    assert twin.json()["skipped_duplicates"] == 6

    bad = client.post(
        "/api/statements/upload",
        headers=primary_headers,
        files={"file": ("notes.txt", io.BytesIO(b"hello"), "text/plain")},
    )
    assert bad.status_code == 422

    unknown = upload(client, primary_headers, fixtures_dir["anon_csv"], account_id="acc_nope")
    assert unknown.status_code == 422


# --------------------------------------------------------------------------- #
# Review, corrections and the learning loop
# --------------------------------------------------------------------------- #


@requires_db
def test_approve_corrections_and_memory_learning(
    client, primary_headers, llm_stub, fixtures_dir, seeded_db, config, embedder
):
    assert upload(client, primary_headers, fixtures_dir["amex_pdf"]).status_code == 200
    pending = list_txns(client, primary_headers, status="pending_review")
    cineworld = find(pending, "CINEWORLD")

    # PATCH recomputes allocations without approving.
    patched = client.patch(
        f"/api/transactions/{cineworld['id']}",
        headers=primary_headers,
        json={"claim_type": "shared_equal", "category": "Entertainment"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["review_status"] == "pending_review"
    assert Decimal(patched.json()["allocated_primary_amount"]) == Decimal("-10.50")
    assert Decimal(patched.json()["allocated_secondary_amount"]) == Decimal("-10.49")

    # Approve with a correction and remember it.
    approved = client.post(
        f"/api/transactions/{cineworld['id']}/approve",
        headers=primary_headers,
        json={"claim_type": "personal", "remember": True},
    )
    assert approved.status_code == 200, approved.text
    body = approved.json()
    assert body["review_status"] == "manual_approved"
    assert body["classification_source"] == "manual"
    assert Decimal(body["allocated_primary_amount"]) == Decimal("-20.99")
    assert Decimal(body["allocated_secondary_amount"]) == Decimal("0.00")

    memories = client.get("/api/memory", headers=primary_headers).json()
    assert any("CINEWORLD" in m["raw_pattern"].upper() for m in memories)
    cine_mem = next(m for m in memories if "CINEWORLD" in m["raw_pattern"].upper())
    assert cine_mem["category"] == "Entertainment" and cine_mem["default_claim_type"] == "personal"

    # Correcting an already-approved transaction re-trains memory (a pending one did not).
    assert cine_mem["review_count"] == 1
    corrected = client.patch(
        f"/api/transactions/{cineworld['id']}", headers=primary_headers, json={"category": "Dining"}
    )
    assert corrected.status_code == 200 and corrected.json()["review_status"] == "manual_approved"
    cine_mem = next(
        m for m in client.get("/api/memory", headers=primary_headers).json() if "CINEWORLD" in m["raw_pattern"].upper()
    )
    assert cine_mem["category"] == "Dining" and cine_mem["review_count"] == 2
    client.patch(f"/api/transactions/{cineworld['id']}", headers=primary_headers, json={"category": "Entertainment"})

    # The next description with a different store number is classified from memory,
    # without the LLM (store numbers are stripped before embedding).
    calls_before = len(llm_stub.calls)
    account = config.account_by_id("acc_cc_amex")
    cls = guesser.classify(seeded_db, config, embedder, llm_stub, "CINEWORLD 4521", account)
    assert cls.source == "memory"
    assert cls.category == "Entertainment"
    assert cls.claim_type == "personal"
    assert len(llm_stub.calls) == calls_before

    # Batch approve the rest.
    remaining = list_txns(client, primary_headers, status="pending_review")
    ids = [t["id"] for t in remaining]
    batch = client.post(
        "/api/transactions/approve-batch", headers=primary_headers, json={"ids": ids, "remember": False}
    )
    assert batch.status_code == 200, batch.text
    assert batch.json()["approved"] == len(ids)
    assert list_txns(client, primary_headers, status="pending_review") == []

    # Unknown id -> 404
    assert (
        client.post(
            "/api/transactions/approve-batch",
            headers=primary_headers,
            json={"ids": ["00000000-0000-0000-0000-000000000000"]},
        ).status_code
        == 404
    )

    # Toggling a transaction into an internal transfer registers it in the buffer.
    netflix = find(list_txns(client, primary_headers), "NETFLIX")
    toggled = client.patch(
        f"/api/transactions/{netflix['id']}", headers=primary_headers, json={"is_internal_transfer": True}
    )
    assert toggled.status_code == 200 and toggled.json()["is_internal_transfer"] is True
    unmatched = client.get("/api/transfers/unmatched", headers=primary_headers).json()
    assert any(e["transaction_id"] == netflix["id"] for e in unmatched)
    back = client.patch(
        f"/api/transactions/{netflix['id']}", headers=primary_headers, json={"is_internal_transfer": False}
    )
    assert back.json()["is_internal_transfer"] is False
    assert not any(
        e["transaction_id"] == netflix["id"]
        for e in client.get("/api/transfers/unmatched", headers=primary_headers).json()
    )

    # Delete
    assert client.delete(f"/api/transactions/{netflix['id']}", headers=primary_headers).status_code == 204
    assert client.get(f"/api/transactions/{netflix['id']}", headers=primary_headers).status_code == 404


# --------------------------------------------------------------------------- #
# Claims & settlement
# --------------------------------------------------------------------------- #


@requires_db
def test_claims_and_settlement(client, primary_headers, secondary_headers, llm_stub, fixtures_dir):
    assert upload(client, primary_headers, fixtures_dir["hsbc_table_pdf"]).status_code == 200

    # Secondary submits a shared claim; paid_by is forced to the secondary user.
    resp = client.post(
        "/api/claims",
        headers=secondary_headers,
        json={
            "claim_date": "2026-08-10",
            "amount": "100.00",
            "merchant": "Corner Shop",
            "claim_type": "shared_proportional",
            "paid_by": "user_primary",
        },
    )
    assert resp.status_code == 201, resp.text
    claim = resp.json()
    assert claim["paid_by"] == "user_secondary"
    assert Decimal(claim["primary_owes"]) == Decimal("55.56")
    assert Decimal(claim["secondary_owes"]) == Decimal("44.44")
    assert claim["period_key"] == "2026-08"

    # Primary logs a personal item of the partner's that the primary paid for.
    resp = client.post(
        "/api/claims",
        headers=primary_headers,
        json={
            "claim_date": "2026-08-12",
            "amount": "25.00",
            "merchant": "Pharmacy",
            "claim_type": "secondary_personal",
            "paid_by": "user_primary",
        },
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["paid_by"] == "user_primary"
    assert Decimal(resp.json()["secondary_owes"]) == Decimal("25.00")

    assert (
        client.post(
            "/api/claims", headers=primary_headers, json={"claim_date": "2026-08-12", "amount": "-5", "merchant": "x"}
        ).status_code
        == 422
    )

    summary = client.get("/api/settlement/2026-08", headers=secondary_headers).json()
    # Approved shared bills paid by primary: Northwind 87.27 + Fibreline 30.00
    assert Decimal(summary["secondary_share_of_primary_paid_shared"]) == Decimal("38.79") + Decimal("13.33")
    assert Decimal(summary["primary_share_of_secondary_paid_shared"]) == Decimal("55.56")
    assert Decimal(summary["secondary_personal_on_primary_paid"]) == Decimal("25.00")
    assert Decimal(summary["primary_personal_on_secondary_paid"]) == Decimal("0.00")
    expected_net = Decimal("38.79") + Decimal("13.33") - Decimal("55.56") + Decimal("25.00")
    assert Decimal(summary["net_owed_by_secondary"]) == expected_net
    assert Decimal(summary["settlement_payments_received"]) == Decimal("1685.73")
    assert summary["unsettled_claim_count"] == 2
    assert summary["pending_review_count"] >= 1  # the salary line is pending
    assert {line["source"] for line in summary["lines"]} == {"transaction", "claim"}

    claims = client.get("/api/claims", headers=primary_headers, params={"period": "2026-08"}).json()
    assert len(claims) == 2

    settled = client.post("/api/settlement/2026-08/mark-settled", headers=primary_headers).json()
    assert settled["settled_claims"] == 2
    assert client.post("/api/settlement/2026-08/mark-settled", headers=secondary_headers).status_code == 403

    # Secondary may not delete a settled claim, primary may.
    assert client.delete(f"/api/claims/{claim['id']}", headers=secondary_headers).status_code == 403
    assert client.delete(f"/api/claims/{claim['id']}", headers=primary_headers).status_code == 204
    assert client.get("/api/settlement/2026-08", headers=primary_headers).json()["unsettled_claim_count"] == 0


# --------------------------------------------------------------------------- #
# Metrics, audit, period lifecycle
# --------------------------------------------------------------------------- #


@requires_db
def test_metrics_audit_and_period_close(client, primary_headers, llm_stub, fixtures_dir):
    assert (
        upload(client, primary_headers, fixtures_dir["energy_history_csv"], account_id="acc_checking_hsbc").status_code
        == 200
    )
    assert upload(client, primary_headers, fixtures_dir["hsbc_table_pdf"]).status_code == 200

    metrics = client.get("/api/metrics/2026-08", headers=primary_headers).json()
    assert metrics["period_key"] == "2026-08"
    # Northwind (87.27, from both files -> deduped by fingerprint) + Fibreline 30.00
    assert Decimal(metrics["macro"]["primary_accounts_burn"]) == Decimal("117.27")
    assert Decimal(metrics["micro"]["from_transactions"]) == Decimal("48.48") + Decimal("16.67")
    liquidity = metrics["liquidity"]
    assert Decimal(liquidity["credits"]) == Decimal("4500.00") + Decimal("1685.73")
    # The card payment is dated 28 July, so it belongs to July's cash flow, not August's.
    assert Decimal(liquidity["debits"]) == Decimal("87.27") + Decimal("30.00") + Decimal("500.00")
    july = client.get("/api/metrics/2026-07", headers=primary_headers).json()
    # card payment (transfer, still cash out) + July's Northwind bill from the history file
    assert Decimal(july["liquidity"]["debits"]) == Decimal("3384.21") + Decimal("68.20")
    assert Decimal(july["macro"]["household_burn"]) == Decimal("68.20")  # the transfer is not spend

    trends = client.get("/api/metrics/trends", headers=primary_headers, params={"periods": 4}).json()
    assert [t["period_key"] for t in trends] == ["2026-05", "2026-06", "2026-07", "2026-08"]
    assert Decimal(trends[0]["household_burn"]) == Decimal("68.20")

    # Audit flags the Northwind jump (68.20 x3 -> 87.27).
    assert client.get("/api/audit/2026-08", headers=primary_headers).status_code == 404
    report = client.post("/api/audit/2026-08/run", headers=primary_headers).json()
    assert report["summary_sentence"] == "Stub audit summary."
    assert any("northwind" in a["merchant"].lower() for a in report["anomalies"])
    octo = next(a for a in report["anomalies"] if "northwind" in a["merchant"].lower())
    assert octo["deviation"] > 0.27
    assert client.get("/api/audit/2026-08", headers=primary_headers).json()["summary_sentence"] == "Stub audit summary."

    # Closing with pending transactions is refused unless forced.
    assert client.post("/api/periods/2026-08/close", headers=primary_headers).status_code == 409
    closed = client.post("/api/periods/2026-08/close", headers=primary_headers, params={"force": "true"})
    assert closed.status_code == 200 and closed.json()["is_closed"] is True

    # Closing records the settlement ledger entry; the live figure and the snapshot agree.
    settlement = client.get("/api/settlement/2026-08", headers=primary_headers).json()
    assert settlement["settlement_due_date"] == "2026-09-01"
    assert settlement["snapshot"] is not None
    assert Decimal(settlement["snapshot"]["net_owed_by_secondary"]) == Decimal(settlement["net_owed_by_secondary"])
    assert settlement["snapshot"]["line_count"] == len(settlement["lines"])
    assert Decimal(settlement["primary_ratio"]) == Decimal("0.555556")

    # The anomaly carries the prior periods' spread as well as the median.
    assert Decimal(octo["baseline_stddev"]) == Decimal("0.00")
    assert Decimal(octo["baseline_amount"]) == Decimal("68.20")

    # Uploads and claims into a closed period are refused.
    # Uploads with NEW lines and claims into a closed period are refused (a re-upload
    # whose lines already exist is not blocked: nothing would be written).
    assert upload(client, primary_headers, fixtures_dir["hsbc_text_pdf"]).status_code == 200
    assert upload(client, primary_headers, fixtures_dir["anon_csv"], account_id="acc_checking_hsbc").status_code == 409
    assert (
        client.post(
            "/api/claims",
            headers=primary_headers,
            json={"claim_date": "2026-08-20", "amount": "1.00", "merchant": "x"},
        ).status_code
        == 409
    )
    reopened = client.post("/api/periods/2026-08/reopen", headers=primary_headers)
    assert reopened.status_code == 200 and reopened.json()["is_closed"] is False


@requires_db
def test_transfer_buffer_endpoints(client, primary_headers, llm_stub, fixtures_dir):
    # Only the checking side is uploaded: the card payment stays unmatched.
    assert upload(client, primary_headers, fixtures_dir["hsbc_table_pdf"]).status_code == 200
    unmatched = client.get("/api/transfers/unmatched", headers=primary_headers).json()
    assert len(unmatched) == 1
    entry = unmatched[0]
    assert "HSBC CARD PYMT" in entry["description"]
    assert Decimal(entry["amount"]) == Decimal("-3384.21")

    assert client.post("/api/transfers/rematch", headers=primary_headers).json()["matched"] == 0

    # Uploading the card statement later matches it.
    assert upload(client, primary_headers, fixtures_dir["amex_pdf"]).status_code == 200
    assert client.get("/api/transfers/unmatched", headers=primary_headers).json() == []

    # Ignore / manual match on fresh entries.
    txns = list_txns(client, primary_headers)
    a = find(txns, "CINEWORLD")
    b = find(txns, "NETFLIX")
    client.patch(f"/api/transactions/{a['id']}", headers=primary_headers, json={"is_internal_transfer": True})
    client.patch(f"/api/transactions/{b['id']}", headers=primary_headers, json={"is_internal_transfer": True})
    pending = client.get("/api/transfers/unmatched", headers=primary_headers).json()
    ids = {e["transaction_id"]: e["id"] for e in pending}
    assert a["id"] in ids and b["id"] in ids

    ignored = client.post(f"/api/transfers/{ids[a['id']]}/ignore", headers=primary_headers)
    assert ignored.status_code == 200 and ignored.json()["match_status"] == "ignored"

    c = find(txns, "ANTHROPIC")
    client.patch(f"/api/transactions/{c['id']}", headers=primary_headers, json={"is_internal_transfer": True})
    pending = {
        e["transaction_id"]: e["id"] for e in client.get("/api/transfers/unmatched", headers=primary_headers).json()
    }
    matched = client.post(
        "/api/transfers/match",
        headers=primary_headers,
        json={"buffer_id_a": pending[b["id"]], "buffer_id_b": pending[c["id"]]},
    )
    assert matched.status_code == 200, matched.text
    assert {e["match_status"] for e in matched.json()} == {"matched"}
    assert (
        client.post(
            "/api/transfers/match",
            headers=primary_headers,
            json={"buffer_id_a": pending[b["id"]], "buffer_id_b": pending[c["id"]]},
        ).status_code
        == 409
    )


@requires_db
def test_memory_endpoints(client, primary_headers, seeded_db, embedder):
    from app.services import memory

    memory.remember(
        seeded_db,
        embedder,
        "OCADO RETAIL LTD",
        normalized_merchant="Ocado",
        category="Groceries",
        claim_type="shared_proportional",
    )
    items = client.get("/api/memory", headers=primary_headers).json()
    assert len(items) == 1 and items[0]["normalized_merchant"] == "Ocado"
    assert client.delete(f"/api/memory/{items[0]['id']}", headers=primary_headers).status_code == 204
    assert client.delete(f"/api/memory/{items[0]['id']}", headers=primary_headers).status_code == 404
    assert client.get("/api/memory", headers=primary_headers).json() == []
