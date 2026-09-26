"""Accounts are seeded from config.yaml once and then managed through the API."""

from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.models import Account
from app.services import accounts as accounts_service
from tests.conftest import requires_db
from tests.factories import make_transaction

NEW_CARD = {
    "institution": "Monzo",
    "label": "Monzo joint card",
    "account_type": "credit",
    "owner": "user_secondary",
    "identifier_last4": "6108",
    "default_claim_type": "shared_equal",
}


@requires_db
def test_seed_only_fills_an_empty_table(db, config):
    assert accounts_service.seed_accounts(db, config) == len(config.accounts)
    row = db.get(Account, "acc_cc_amex_supp")
    assert row.label == "Amex Platinum (supplementary)"
    assert row.default_claim_type == "shared_proportional"
    # Edits made in the app survive a restart: the seed never overwrites rows.
    row.label = "Renamed in the app"
    row.is_active = False
    db.flush()
    assert accounts_service.seed_accounts(db, config) == 0
    assert db.get(Account, "acc_cc_amex_supp").label == "Renamed in the app"


@requires_db
def test_upgrade_backfills_details_once(db, config):
    """A database from before the detail columns existed gets them from config.yaml, once."""
    for cfg in config.accounts:  # what the old sync used to write: identity columns only
        db.add(
            Account(
                id=cfg.id,
                institution=cfg.institution,
                account_type=cfg.account_type,
                owner_user_id=cfg.owner,
                identifier_last4=cfg.identifier_last4,
            )
        )
    db.flush()
    filled = accounts_service.seed_accounts(db, config)
    assert filled == sum(
        1 for c in config.accounts if c.label or c.billed_to or c.default_claim_type != "personal"
    )
    supp = db.get(Account, "acc_cc_amex_supp")
    assert supp.label == "Amex Platinum (supplementary)" and supp.default_claim_type == "shared_proportional"
    assert [r.id for r in db.scalars(select(Account).order_by(Account.sort_order))] == [c.id for c in config.accounts]
    # Now the app owns the rows: an edit is never overwritten on the next start.
    supp.default_claim_type = "personal"
    supp.label = "Sam's card"
    db.flush()
    assert accounts_service.seed_accounts(db, config) == 0
    assert db.get(Account, "acc_cc_amex_supp").label == "Sam's card"


@requires_db
def test_effective_config_reflects_the_rows(seeded_db, config):
    seeded_db.get(Account, "acc_cc_virgin").billed_to = "user_secondary"
    seeded_db.flush()
    effective = config.with_accounts(accounts_service.load_account_configs(seeded_db))
    assert effective.payer_for_account("acc_cc_virgin") == "user_secondary"
    assert config.payer_for_account("acc_cc_virgin") == "user_primary"  # the file is untouched
    assert [a.id for a in effective.accounts] == [a.id for a in config.accounts]
    assert effective.users == config.users and effective.deterministic_rules == config.deterministic_rules


@requires_db
def test_crud_over_the_api(client, primary_headers, secondary_headers):
    listed = client.get("/api/accounts", headers=primary_headers).json()
    assert {a["id"] for a in listed} >= {"acc_checking_hsbc", "acc_cc_amex", "acc_invest_robinhood"}
    assert all(a["transaction_count"] == 0 and a["is_active"] for a in listed)
    assert client.get("/api/accounts", headers=secondary_headers).status_code == 403

    created = client.post("/api/accounts", json=NEW_CARD, headers=primary_headers)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["id"] == "acc_monzo_credit_6108"
    assert body["label"] == "Monzo joint card" and body["billed_to"] is None
    assert body["default_claim_type"] == "shared_equal" and body["owner_user_id"] == "user_secondary"

    # The public config (what the UI reads) now carries the new account.
    cfg = client.get("/api/config", headers=primary_headers).json()
    entry = next(a for a in cfg["accounts"] if a["id"] == "acc_monzo_credit_6108")
    assert entry["label"] == "Monzo joint card" and entry["is_active"] is True
    assert entry["billed_to"] == "user_secondary"  # a plain credit card is paid by its owner

    updated = client.patch(
        "/api/accounts/acc_monzo_credit_6108",
        json={"label": None, "billed_to": "user_primary", "identifier_last4": "6109"},
        headers=primary_headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["label"] is None and updated.json()["billed_to"] == "user_primary"
    assert updated.json()["identifier_last4"] == "6109"

    archived = client.patch("/api/accounts/acc_monzo_credit_6108", json={"is_active": False}, headers=primary_headers)
    assert archived.json()["is_active"] is False
    cfg = client.get("/api/config", headers=primary_headers).json()
    assert next(a for a in cfg["accounts"] if a["id"] == "acc_monzo_credit_6108")["is_active"] is False

    assert client.delete("/api/accounts/acc_monzo_credit_6108", headers=primary_headers).status_code == 204
    assert client.get("/api/accounts", headers=primary_headers).json() == listed
    assert client.delete("/api/accounts/acc_monzo_credit_6108", headers=primary_headers).status_code == 404


@requires_db
def test_validation_and_refusals(client, primary_headers, seeded_db, config):
    def post(**overrides):
        return client.post("/api/accounts", json={**NEW_CARD, **overrides}, headers=primary_headers)

    assert post(owner="user_nobody").status_code == 422
    assert post(billed_to="user_nobody").status_code == 422
    assert post(institution="   ").status_code == 422
    assert post(account_type="wallet").status_code == 422
    assert post(id="Not Valid!").status_code == 422
    assert post(id="acc_cc_amex").status_code == 409
    # Same bank, same digits, both active: uploads could not be mapped.
    assert post(institution="hsbc", account_type="checking", identifier_last4="4471").status_code == 422
    # ...unless it is the supplementary card of an existing main card.
    ok = post(institution="Amex", account_type="credit_supplementary", identifier_last4="7715", owner="user_secondary")
    assert ok.status_code == 201, ok.text
    assert ok.json()["id"] == "acc_amex_credit_supplementary_7715"

    # Accounts with history cannot be deleted, only archived; rules pin their target too.
    make_transaction(seeded_db, config, account_id="acc_cc_amex", transaction_date=date(2026, 8, 3))
    seeded_db.commit()
    resp = client.delete("/api/accounts/acc_cc_amex", headers=primary_headers)
    assert resp.status_code == 409 and "archive" in resp.json()["detail"]
    resp = client.delete("/api/accounts/acc_invest_robinhood", headers=primary_headers)
    assert resp.status_code == 409 and "rule" in resp.json()["detail"]
    listed = {a["id"]: a for a in client.get("/api/accounts", headers=primary_headers).json()}
    assert listed["acc_cc_amex"]["transaction_count"] == 1
    assert client.patch("/api/accounts/acc_cc_amex", json={"is_active": False}, headers=primary_headers).json()[
        "is_active"
    ] is False


@requires_db
def test_new_account_is_used_for_uploads_and_settlement(client, primary_headers, seeded_db, config):
    """A card added in the app is mapped by its digits and its payer rule is honoured."""
    resp = client.post(
        "/api/accounts",
        json={
            "institution": "Amex",
            "label": "Second supplementary",
            "account_type": "credit_supplementary",
            "owner": "user_secondary",
            "identifier_last4": "9911",
            "default_claim_type": "shared_equal",
        },
        headers=primary_headers,
    )
    assert resp.status_code == 201, resp.text
    account_id = resp.json()["id"]
    rows = seeded_db.scalars(select(Account).where(Account.id == account_id)).all()
    assert len(rows) == 1

    from app.services.accounts import load_account_configs

    effective = config.with_accounts(load_account_configs(seeded_db))
    assert [a.id for a in effective.accounts_by_last4("9911", "Amex")] == [account_id]
    # Supplementary cards are billed to the primary user unless told otherwise.
    assert effective.payer_for_account(account_id) == "user_primary"
    assert effective.account_by_id(account_id).default_claim_type == "shared_equal"
