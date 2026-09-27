"""Settings -> Household / Categories / Rules: stored documents overlay config.yaml, which is optional."""

from __future__ import annotations

import logging
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.config import DEFAULT_CATEGORIES, DEFAULT_TRANSFER_PATTERNS, ConfigError, load_config
from app.models import AppSetting, MerchantMemory, Transaction
from app.services import rules as rules_engine
from app.services import site_settings
from app.services.site_settings import (
    CategoryRename,
    HouseholdUpdate,
    RulesUpdate,
    RuleTest,
    SiteSettingsConflict,
    SiteSettingsError,
    SiteSettingsNotFound,
)
from tests.conftest import requires_db
from tests.factories import make_transaction

CORNER_SHOP_RULE = {"pattern": r"(?i)CORNER\s*SHOP", "category": "Groceries", "claim_type": "shared_equal"}


# --------------------------------------------------------------------------- #
# config.yaml is optional
# --------------------------------------------------------------------------- #


def test_load_config_without_a_file_uses_built_in_defaults(tmp_path, caplog):
    with caplog.at_level(logging.WARNING, logger="app.config"):
        cfg = load_config(tmp_path / "config.yaml")
    assert "built-in defaults" in caplog.text and "Settings" in caplog.text
    assert cfg.user_ids == ("user_primary", "user_secondary")
    assert (cfg.users.primary.display_name, cfg.users.secondary.display_name) == ("Primary", "Secondary")
    assert cfg.users.primary.total_income_pa == 0 and cfg.users.secondary.total_income_pa == 0
    assert cfg.settlement.split_strategy == "equal_50_50" and cfg.primary_ratio == Decimal("0.5")
    assert cfg.categories == DEFAULT_CATEGORIES
    assert cfg.transfers.payment_patterns == DEFAULT_TRANSFER_PATTERNS
    assert cfg.deterministic_rules == [] and cfg.accounts == []

    # Docker mounts a directory when the host file is missing: the same defaults.
    assert load_config(tmp_path).users.primary.id == "user_primary"

    # A file that exists but is wrong is still refused loudly.
    broken = tmp_path / "broken.yaml"
    broken.write_text("users: [1, 2]\n", encoding="utf-8")
    with pytest.raises(ConfigError):
        load_config(broken)
    broken.write_text("users:\n  primary: {id: a, display_name: A}\n  secondary: {id: a, display_name: B}\n")
    with pytest.raises(ConfigError, match="must differ"):
        load_config(broken)


# --------------------------------------------------------------------------- #
# Pure logic: defaults, validation, overlay
# --------------------------------------------------------------------------- #


def test_defaults_come_from_config_yaml(config):
    household = site_settings.household_defaults(config)
    assert household.users.primary.display_name == "Primary User"
    assert household.users.secondary.base_salary_pa == Decimal("80000")
    assert household.split_strategy == "salary_proportional" and household.settlement_day_of_month == 1
    assert (household.base_currency, household.currency_symbol) == ("GBP", "£")

    categories = site_settings.categories_defaults(config)
    assert categories.categories == config.categories and categories.categories[-1] == "Uncategorized"

    rules = site_settings.rules_defaults(config)
    assert [r.pattern for r in rules.rules] == [r.pattern for r in config.deterministic_rules]
    assert rules.rules[-1].transfer_to_account == "acc_invest_robinhood"
    assert rules.payment_patterns == config.transfers.payment_patterns
    assert (rules.match_window_days, rules.amount_tolerance) == (7, Decimal("0.01"))


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"users": {"primary": {"display_name": "   "}}}, "display_name must not be empty"),
        ({"users": {"secondary": {"additional_income_pa": "-1"}}}, "incomes cannot be negative"),
        (
            {"users": {"primary": {"base_salary_pa": 0}, "secondary": {"base_salary_pa": 0}}},
            "salary_proportional needs a positive combined income",
        ),
        ({"split_strategy": "by_mood"}, "split_strategy must be salary_proportional or equal_50_50"),
        ({"rounding_decimals": 7}, "rounding_decimals must be between 0 and 6"),
        ({"settlement_day_of_month": 31}, "settlement_day_of_month must be between 1 and 28"),
        ({"base_currency": "POUNDS"}, "base_currency must be a three-letter code"),
        ({"base_currency": "£"}, "base_currency must be a three-letter code"),
        ({"currency_symbol": ""}, "currency_symbol must be 1 to 3 characters"),
        ({"currency_symbol": "GBP£"}, "currency_symbol must be 1 to 3 characters"),
    ],
)
def test_household_validation_messages(config, body, message):
    current = site_settings.household_defaults(config)
    with pytest.raises(SiteSettingsError, match=f"^{message}$"):
        site_settings.merged_household(current, HouseholdUpdate.model_validate(body))


def test_household_merge_is_partial_and_normalises(config):
    current = site_settings.household_defaults(config)
    merged = site_settings.merged_household(
        current,
        HouseholdUpdate.model_validate(
            {"users": {"secondary": {"display_name": "  Sam  "}}, "base_currency": " eur ", "currency_symbol": " € "}
        ),
    )
    assert merged.users.secondary.display_name == "Sam"
    assert merged.users.secondary.base_salary_pa == Decimal("80000")  # untouched field keeps its value
    assert merged.users.primary == current.users.primary
    assert (merged.base_currency, merged.currency_symbol) == ("EUR", "€")
    # Zero incomes are fine once the split no longer depends on them.
    zero = {"primary": {"base_salary_pa": 0}, "secondary": {"base_salary_pa": 0}}
    equal = site_settings.merged_household(
        current, HouseholdUpdate.model_validate({"split_strategy": "equal_50_50", "users": zero})
    )
    assert equal.users.primary.total_income_pa == 0


def test_category_normalisation():
    doc = site_settings.normalise_categories(["  Groceries ", "Dining", "uncategorized"])
    assert doc.categories == ["Groceries", "Dining", "Uncategorized"]  # trimmed, canonical spelling
    assert site_settings.normalise_categories(["Dining", "Groceries"]).categories == [
        "Dining",
        "Groceries",
        "Uncategorized",
    ]  # appended when missing, order kept
    with pytest.raises(SiteSettingsError, match="^category 2 must not be empty$"):
        site_settings.normalise_categories(["Groceries", " "])
    with pytest.raises(SiteSettingsError, match="^category 1 is longer than 128 characters$"):
        site_settings.normalise_categories(["x" * 129])
    with pytest.raises(SiteSettingsError, match="^category 'groceries' is listed twice$"):
        site_settings.normalise_categories(["Groceries", "groceries"])


def _rules(config, rules: list[dict] | None = None, **overrides):
    current = site_settings.rules_defaults(config)
    body = RulesUpdate.model_validate({"rules": rules, **overrides} if rules is not None else overrides)
    return site_settings.validate_rules(site_settings.merged_rules(current, body), config)


@pytest.mark.parametrize(
    ("rules", "overrides", "message"),
    [
        ([{"pattern": "(", "category": "Groceries"}], {}, "rule 1: invalid regex '(': "),
        ([{"pattern": "OK", "category": "Groceries"}, {"pattern": "X", "category": "Foo"}], {},
         "rule 2: category 'Foo' is not in the configured taxonomy"),
        ([{"pattern": "OK", "category": "Groceries", "claim_type": "split"}], {}, "rule 1: unknown claim_type"),
        ([{"pattern": "OK", "category": "Groceries", "transfer_to_account": "acc_x"}], {},
         "rule 1: transfer_to_account 'acc_x' is not an account"),
        ([{"pattern": "  ", "category": "Groceries"}], {}, "rule 1: pattern must not be empty"),
        ([{"pattern": "OK", "category": " "}], {}, "rule 1: category must not be empty"),
        (None, {"payment_patterns": ["(?i)OK", "["]}, "payment pattern 2: invalid regex '[': "),
        (None, {"match_window_days": 61}, "match_window_days must be between 0 and 60"),
        (None, {"amount_tolerance": "10.5"}, "amount_tolerance must be between 0 and 10"),
    ],
)  # fmt: skip
def test_rule_validation_messages(config, rules, overrides, message):
    with pytest.raises(SiteSettingsError) as info:
        _rules(config, rules, **overrides)
    assert str(info.value).startswith(message)


def test_rule_validation_normalises(config):
    doc = _rules(
        config,
        [
            {
                "pattern": "(?i)ROBINHOOD",
                "category": "transfers:investment",
                "merchant": " Robinhood ",
                "subcategory": "",
                "transfer_to_account": " acc_invest_robinhood ",
            }
        ],
    )
    rule = doc.rules[0]
    assert rule.category == "Transfers:Investment"  # the configured spelling
    assert rule.merchant == "Robinhood" and rule.subcategory is None
    assert rule.transfer_to_account == "acc_invest_robinhood" and rule.claim_type == "personal"
    # Without a configuration (loading a stored document) the references are left alone.
    gone = doc.model_copy(update={"rules": [rule.model_copy(update={"category": "Gone"})]})
    assert site_settings.validate_rules(gone).rules[0].category == "Gone"


def test_apply_overlays_without_touching_the_file_configuration(config):
    alex = {"split_strategy": "equal_50_50", "users": {"primary": {"display_name": "Alex"}}}
    household = site_settings.merged_household(
        site_settings.household_defaults(config), HouseholdUpdate.model_validate(alex)
    )
    effective = site_settings.apply_household(config, household)
    assert effective.primary_ratio == Decimal("0.5") and effective.users.primary.display_name == "Alex"
    assert effective.users.primary.id == config.users.primary.id  # ids never move
    assert config.primary_ratio != Decimal("0.5") and config.users.primary.display_name == "Primary User"

    categories = site_settings.normalise_categories(["Dining", "Groceries"])
    assert site_settings.apply_categories(config, categories).categories == ["Dining", "Groceries", "Uncategorized"]
    assert config.categories[0] == "Bills:Water"

    rules = _rules(config, [CORNER_SHOP_RULE], payment_patterns=[r"(?i)CARD\s+PAYMENT"], match_window_days=3)
    effective = site_settings.apply_rules(config, rules)
    match = rules_engine.match_rule("CORNER SHOP 12", effective)
    assert match is not None and match.category == "Groceries" and match.claim_type == "shared_equal"
    assert rules_engine.match_rule("AQUANORTH WATER", effective) is None  # the list was replaced
    assert effective.transfers.is_payment("CARD PAYMENT 1234") and effective.transfers.match_window_days == 3
    assert rules_engine.match_rule("AQUANORTH WATER", config) is not None

    out = site_settings.household_out(config, household, stored=False)
    assert out.primary_ratio == 0.5 and out.users.primary.id == "user_primary" and out.stored is False


def test_validate_full_catches_what_the_file_would_refuse(config):
    dangling = config.deterministic_rules[-1].model_copy(update={"transfer_to_account": "acc_gone"})
    overlaid = config.model_copy(update={"deterministic_rules": [dangling]})
    with pytest.raises(SiteSettingsError, match="acc_gone"):
        site_settings.validate_full(overlaid)
    assert site_settings.validate_full(config).users == config.users


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #


@requires_db
def test_documents_round_trip_and_corrupt_ones_fall_back(db, config, caplog):
    household, stored = site_settings.load_household(db, config)
    assert stored is False
    site_settings.save_household(
        db, site_settings.merged_household(household, HouseholdUpdate.model_validate({"rounding_decimals": 3}))
    )
    loaded, stored = site_settings.load_household(db, config)
    assert stored is True and loaded.rounding_decimals == 3 and loaded.split_strategy == "salary_proportional"

    site_settings.save_categories(db, site_settings.normalise_categories(["Dining"]))
    assert site_settings.load_categories(db, config) == (
        site_settings.Categories(categories=["Dining", "Uncategorized"]),
        True,
    )
    site_settings.save_rules(db, _rules(config, [CORNER_SHOP_RULE], amount_tolerance="0.05"))
    rules, stored = site_settings.load_rules(db, config)
    assert stored and [r.pattern for r in rules.rules] == [CORNER_SHOP_RULE["pattern"]]
    assert rules.amount_tolerance == Decimal("0.05")

    # A document nobody could have saved through the API is ignored, not fatal.
    with caplog.at_level(logging.WARNING, logger="app.services.site_settings"):
        db.get(AppSetting, site_settings.HOUSEHOLD_KEY).value = {"split_strategy": "salary_proportional",
                                                                  "users": {"primary": {"base_salary_pa": 0},
                                                                            "secondary": {"base_salary_pa": 0}}}
        db.get(AppSetting, site_settings.RULES_KEY).value = {"rules": [{"pattern": "(", "category": "X"}]}
        db.flush()
        assert site_settings.load_household(db, config) == (site_settings.household_defaults(config), False)
        assert site_settings.load_rules(db, config) == (site_settings.rules_defaults(config), False)
    assert "invalid household settings document" in caplog.text
    assert "invalid rules settings document" in caplog.text


@requires_db
def test_apply_all_reflects_every_saved_document(seeded_db, config):
    from app.services.accounts import load_account_configs

    base = config.with_accounts(load_account_configs(seeded_db))
    assert site_settings.apply_all(seeded_db, base).primary_ratio == config.primary_ratio

    equal = HouseholdUpdate.model_validate({"split_strategy": "equal_50_50"})
    site_settings.update_household(seeded_db, config, base, equal)
    # The file's rules pin their categories, so they are replaced before the taxonomy shrinks.
    site_settings.update_rules(seeded_db, config, base, RulesUpdate.model_validate({"rules": [CORNER_SHOP_RULE]}))
    site_settings.update_categories(seeded_db, config, base, site_settings.CategoriesUpdate(categories=["Groceries"]))
    effective = site_settings.apply_all(seeded_db, base)
    assert effective.primary_ratio == Decimal("0.5") and effective.secondary_ratio == Decimal("0.5")
    assert effective.categories == ["Groceries", "Uncategorized"]
    assert rules_engine.match_rule("CORNER SHOP", effective).claim_type == "shared_equal"
    assert [a.id for a in effective.accounts] == [a.id for a in config.accounts]  # accounts stay overlaid
    assert config.primary_ratio != Decimal("0.5")  # the file configuration is never mutated


# --------------------------------------------------------------------------- #
# The API
# --------------------------------------------------------------------------- #


@requires_db
def test_secondary_role_is_refused_everywhere(client, secondary_headers):
    calls = [
        ("GET", "/api/settings/household", None),
        ("PUT", "/api/settings/household", {"split_strategy": "equal_50_50"}),
        ("GET", "/api/settings/categories", None),
        ("PUT", "/api/settings/categories", {"categories": ["Groceries"]}),
        ("POST", "/api/settings/categories/rename", {"from": "Groceries", "to": "Food"}),
        ("GET", "/api/settings/rules", None),
        ("PUT", "/api/settings/rules", {"rules": []}),
        ("POST", "/api/settings/rules/test", {"description": "x"}),
    ]
    for method, path, body in calls:
        resp = client.request(method, path, headers=secondary_headers, json=body)
        assert resp.status_code == 403, (method, path, resp.text)
        assert client.request(method, path, json=body).status_code == 401, (method, path)


@requires_db
def test_household_api(client, primary_headers, secondary_headers):
    info = client.get("/api/settings/household", headers=primary_headers).json()
    assert info["stored"] is False and info["split_strategy"] == "salary_proportional"
    assert info["users"]["primary"] == {
        "id": "user_primary",
        "display_name": "Primary User",
        "base_salary_pa": "100000",
        "additional_income_pa": "0",
    }
    assert abs(info["primary_ratio"] - 0.555556) < 1e-6 and abs(info["secondary_ratio"] - 0.444444) < 1e-6
    assert (info["base_currency"], info["currency_symbol"], info["settlement_day_of_month"]) == ("GBP", "£", 1)

    # A nested partial: only the secondary's name changes, and it shows up everywhere at once.
    resp = client.put(
        "/api/settings/household",
        json={"users": {"secondary": {"display_name": "Sam"}}, "base_currency": "eur", "currency_symbol": "€"},
        headers=primary_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["stored"] is True and body["users"]["secondary"]["display_name"] == "Sam"
    assert body["users"]["secondary"]["id"] == "user_secondary"
    assert Decimal(body["users"]["secondary"]["base_salary_pa"]) == Decimal("80000")
    assert (body["base_currency"], body["currency_symbol"]) == ("EUR", "€")
    public = client.get("/api/config", headers=primary_headers).json()
    assert public["users"]["secondary"]["display_name"] == "Sam" and public["currency_symbol"] == "€"
    assert client.get("/api/auth/me", headers=secondary_headers).json()["display_name"] == "Sam"

    # The split follows the saved incomes and strategy on the next request.
    incomes = {"primary": {"base_salary_pa": 60000, "additional_income_pa": 0}, "secondary": {"base_salary_pa": 20000}}
    resp = client.put("/api/settings/household", json={"users": incomes}, headers=primary_headers)
    assert resp.status_code == 200 and resp.json()["primary_ratio"] == 0.75
    assert client.get("/api/config", headers=primary_headers).json()["split"]["primary_ratio"] == 0.75
    resp = client.put("/api/settings/household", json={"split_strategy": "equal_50_50"}, headers=primary_headers)
    assert resp.json()["primary_ratio"] == 0.5
    split = client.get("/api/config", headers=primary_headers).json()["split"]
    assert split["strategy"] == "equal_50_50" and split["primary_ratio"] == 0.5
    settlement = client.get("/api/settlement/2026-08", headers=primary_headers).json()
    assert Decimal(settlement["primary_ratio"]) == Decimal("0.5")

    # Validation messages name the problem; nothing is saved on a refusal.
    zero = {"primary": {"base_salary_pa": 0}, "secondary": {"base_salary_pa": 0}}
    for body, message in [
        ({"users": {"primary": {"display_name": ""}}}, "display_name must not be empty"),
        ({"users": {"primary": {"base_salary_pa": -1}}}, "incomes cannot be negative"),
        (
            {"split_strategy": "salary_proportional", "users": zero},
            "salary_proportional needs a positive combined income",
        ),
        ({"base_currency": "EURO"}, "base_currency must be a three-letter code"),
        ({"currency_symbol": "    "}, "currency_symbol must be 1 to 3 characters"),
        ({"rounding_decimals": -1}, "rounding_decimals must be between 0 and 6"),
        ({"settlement_day_of_month": 0}, "settlement_day_of_month must be between 1 and 28"),
        ({"split_strategy": "thirds"}, "split_strategy must be salary_proportional or equal_50_50"),
    ]:
        resp = client.put("/api/settings/household", json=body, headers=primary_headers)
        assert resp.status_code == 422, body
        assert resp.json()["detail"] == message
    assert client.get("/api/settings/household", headers=primary_headers).json()["split_strategy"] == "equal_50_50"


@requires_db
def test_categories_api(client, primary_headers, seeded_db, config, embedder):
    from app.services import memory

    listed = client.get("/api/settings/categories", headers=primary_headers).json()
    assert listed["stored"] is False
    assert [c["name"] for c in listed["categories"]] == config.categories
    by_name = {c["name"]: c["in_use"] for c in listed["categories"]}
    assert by_name["Health:Gym"] == {"transactions": 0, "memory": 0, "rules": 1}  # the example THIRD SPACE rule
    assert by_name["Groceries"] == {"transactions": 0, "memory": 0, "rules": 0}

    # The file's rules pin the categories they name: with them gone the taxonomy is free to shrink.
    resp = client.put("/api/settings/categories", json={"categories": ["Dining", "Groceries"]}, headers=primary_headers)
    assert resp.status_code == 409 and resp.json()["detail"].startswith("category 'Bills:Water' is still used by ")
    resp = client.put("/api/settings/rules", json={"rules": [CORNER_SHOP_RULE]}, headers=primary_headers)
    assert resp.status_code == 200, resp.text

    # Reorder, drop unused ones, add a new one; Uncategorized is appended when left out.
    resp = client.put(
        "/api/settings/categories", json={"categories": ["Dining", "Groceries", " Pets "]}, headers=primary_headers
    )
    assert resp.status_code == 200, resp.text
    assert [c["name"] for c in resp.json()["categories"]] == ["Dining", "Groceries", "Pets", "Uncategorized"]
    assert resp.json()["stored"] is True
    assert client.get("/api/config", headers=primary_headers).json()["categories"] == [
        "Dining",
        "Groceries",
        "Pets",
        "Uncategorized",
    ]

    for body, message in [
        ({"categories": ["Dining", ""]}, "category 2 must not be empty"),
        ({"categories": ["Dining", "dining"]}, "category 'dining' is listed twice"),
        ({"categories": ["x" * 129]}, "category 1 is longer than 128 characters"),
    ]:
        resp = client.put("/api/settings/categories", json=body, headers=primary_headers)
        assert resp.status_code == 422 and resp.json()["detail"] == message, resp.text

    # A category in use cannot be dropped; the answer says by what. Split parts count as transactions.
    parent = make_transaction(seeded_db, config, category="Groceries", amount="-30.00")
    make_transaction(seeded_db, config, category="Groceries", amount="-20.00", split_parent_id=parent.id, split_index=0)
    memory.remember(seeded_db, embedder, "OCADO RETAIL", normalized_merchant="Ocado", category="Groceries",
                    claim_type="shared_proportional")
    seeded_db.commit()
    resp = client.put("/api/settings/categories", json={"categories": ["Dining"]}, headers=primary_headers)
    assert resp.status_code == 409
    expected = "category 'Groceries' is still used by 2 transactions, 1 remembered merchant and 1 rule"
    assert resp.json()["detail"] == expected
    listed = client.get("/api/settings/categories", headers=primary_headers).json()
    assert {c["name"]: c["in_use"] for c in listed["categories"]}["Groceries"] == {
        "transactions": 2,
        "memory": 1,
        "rules": 1,
    }
    # Uncategorized is never dropped either: it is put back rather than refused.
    resp = client.put("/api/settings/categories", json={"categories": ["Dining", "Groceries"]}, headers=primary_headers)
    assert resp.status_code == 200 and [c["name"] for c in resp.json()["categories"]][-1] == "Uncategorized"


@requires_db
def test_rename_cascades_to_transactions_memory_and_rules(client, primary_headers, seeded_db, config, embedder):
    from app.services import memory

    gym = make_transaction(seeded_db, config, category="Health:Gym", raw_description="THIRD SPACE", amount="-90.00")
    other = make_transaction(seeded_db, config, category="Groceries")
    memory.remember(seeded_db, embedder, "THIRD SPACE", normalized_merchant="Third Space", category="Health:Gym",
                    claim_type="personal")
    seeded_db.commit()

    for body, status, message in [
        ({"from": "Nope", "to": "Fitness"}, 404, "category 'Nope' is not in the taxonomy"),
        ({"from": "Health:Gym", "to": "groceries"}, 409, "category 'Groceries' already exists"),
        ({"from": "Health:Gym", "to": "Uncategorized"}, 409, "category 'Uncategorized' already exists"),
        ({"from": "uncategorized", "to": "Unsorted"}, 409, "'Uncategorized' cannot be renamed"),
        ({"from": "Health:Gym", "to": "  "}, 422, "category names must not be empty"),
        ({"from": "", "to": "Fitness"}, 422, "category names must not be empty"),
    ]:
        resp = client.post("/api/settings/categories/rename", json=body, headers=primary_headers)
        assert (resp.status_code, resp.json()["detail"]) == (status, message), body

    resp = client.post(
        "/api/settings/categories/rename", json={"from": "health:gym", "to": "Health:Fitness"}, headers=primary_headers
    )
    assert resp.status_code == 200, resp.text
    names = [c["name"] for c in resp.json()["categories"]]
    assert "Health:Fitness" in names and "Health:Gym" not in names
    assert names.index("Health:Fitness") == config.categories.index("Health:Gym")  # same place in the menus
    by_name = {c["name"]: c["in_use"] for c in resp.json()["categories"]}
    assert by_name["Health:Fitness"] == {"transactions": 1, "memory": 1, "rules": 1}

    seeded_db.expire_all()
    assert seeded_db.get(Transaction, gym.id).category == "Health:Fitness"
    assert seeded_db.get(Transaction, other.id).category == "Groceries"
    assert seeded_db.scalars(select(MerchantMemory.category)).all() == ["Health:Fitness"]
    rules = client.get("/api/settings/rules", headers=primary_headers).json()
    assert rules["stored"] is True  # the file's rules were carried over with the new name
    assert [r["category"] for r in rules["rules"] if "THIRD" in r["pattern"]] == ["Health:Fitness"]
    assert client.get(f"/api/transactions/{gym.id}", headers=primary_headers).json()["category"] == "Health:Fitness"
    assert "Health:Fitness" in client.get("/api/config", headers=primary_headers).json()["categories"]

    # A case-only rename is a respelling of the same category, not a clash.
    respell = {"from": "Health:Fitness", "to": "Health:FITNESS"}
    resp = client.post("/api/settings/categories/rename", json=respell, headers=primary_headers)
    assert resp.status_code == 200 and "Health:FITNESS" in [c["name"] for c in resp.json()["categories"]]
    seeded_db.expire_all()
    assert seeded_db.get(Transaction, gym.id).category == "Health:FITNESS"


@requires_db
def test_rules_api_and_tester(client, primary_headers, config):
    info = client.get("/api/settings/rules", headers=primary_headers).json()
    assert info["stored"] is False and len(info["rules"]) == len(config.deterministic_rules)
    assert info["rules"][-1]["transfer_to_account"] == "acc_invest_robinhood"
    assert info["match_window_days"] == 7 and Decimal(info["amount_tolerance"]) == Decimal("0.01")
    assert info["payment_patterns"] == config.transfers.payment_patterns

    # Every refusal names the item; nothing is saved.
    for body, message in [
        ({"rules": [{"pattern": "(", "category": "Groceries"}]}, "rule 1: invalid regex '(': "),
        ({"rules": [CORNER_SHOP_RULE, {"pattern": "X", "category": "Foo"}]},
         "rule 2: category 'Foo' is not in the configured taxonomy"),
        ({"rules": [{"pattern": "X", "category": "Groceries", "claim_type": "mine"}]}, "rule 1: unknown claim_type"),
        ({"rules": [{"pattern": "X", "category": "Groceries", "transfer_to_account": "acc_x"}]},
         "rule 1: transfer_to_account 'acc_x' is not an account"),
        ({"payment_patterns": ["OK", "["]}, "payment pattern 2: invalid regex '[': "),
        ({"match_window_days": 61}, "match_window_days must be between 0 and 60"),
        ({"amount_tolerance": 11}, "amount_tolerance must be between 0 and 10"),
    ]:  # fmt: skip
        resp = client.put("/api/settings/rules", json=body, headers=primary_headers)
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"].startswith(message), resp.text
    assert client.get("/api/settings/rules", headers=primary_headers).json()["stored"] is False

    # An archived account is still an account.
    archive = client.patch("/api/accounts/acc_invest_robinhood", json={"is_active": False}, headers=primary_headers)
    assert archive.status_code == 200
    robinhood = {
        "pattern": "(?i)ROBINHOOD",
        "category": "transfers:investment",
        "transfer_to_account": "acc_invest_robinhood",
    }
    resp = client.put(
        "/api/settings/rules",
        json={
            "rules": [CORNER_SHOP_RULE, robinhood],
            "payment_patterns": [r"(?i)CARD\s+PAYMENT"],
            "amount_tolerance": "0.05",
        },
        headers=primary_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["stored"] is True
    assert [r["pattern"] for r in body["rules"]] == [CORNER_SHOP_RULE["pattern"], "(?i)ROBINHOOD"]
    assert body["rules"][1]["category"] == "Transfers:Investment" and body["rules"][1]["claim_type"] == "personal"
    assert body["payment_patterns"] == [r"(?i)CARD\s+PAYMENT"] and Decimal(body["amount_tolerance"]) == Decimal("0.05")
    assert body["match_window_days"] == 7  # untouched
    # A subset update keeps the rest.
    resp = client.put("/api/settings/rules", json={"match_window_days": 2}, headers=primary_headers)
    assert resp.status_code == 200 and resp.json()["match_window_days"] == 2 and len(resp.json()["rules"]) == 2
    # The account is now pinned by an app rule, not a file rule.
    resp = client.delete("/api/accounts/acc_invest_robinhood", headers=primary_headers)
    assert resp.status_code == 409 and "Settings -> Rules" in resp.json()["detail"]

    # The tester: saved rules and patterns by default...
    def try_rules(**body):
        return client.post("/api/settings/rules/test", json=body, headers=primary_headers)

    resp = try_rules(description="CARD PAYMENT TO CORNER SHOP")
    assert resp.status_code == 200, resp.text
    stored_rule = {**CORNER_SHOP_RULE, "merchant": None, "subcategory": None, "is_internal_transfer": False,
                   "transfer_to_account": None}  # fmt: skip
    assert resp.json() == {"rule_index": 0, "rule": stored_rule, "is_payment": True}
    assert try_rules(description="WAITROSE 1234").json() == {"rule_index": None, "rule": None, "is_payment": False}
    # ...or unsaved edits, validated like a PUT, without saving anything.
    resp = try_rules(
        description="WAITROSE 1234",
        rules=[{"pattern": "(?i)WAITROSE", "category": "groceries"}],
        payment_patterns=[r"(?i)WAITROSE"],
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["rule_index"] == 0 and resp.json()["rule"]["category"] == "Groceries"
    assert resp.json()["is_payment"] is True
    resp = try_rules(description="x", rules=[{"pattern": "(?i)WAITROSE", "category": "Nope"}])
    assert resp.status_code == 422
    assert resp.json()["detail"] == "rule 1: category 'Nope' is not in the configured taxonomy"
    assert len(client.get("/api/settings/rules", headers=primary_headers).json()["rules"]) == 2


@requires_db
def test_a_rule_saved_in_the_app_classifies_the_next_upload(client, primary_headers, tmp_path):
    resp = client.put(
        "/api/settings/rules",
        json={"rules": [{**CORNER_SHOP_RULE, "merchant": "Corner Shop", "subcategory": "Snacks"}]},
        headers=primary_headers,
    )
    assert resp.status_code == 200, resp.text
    statement = tmp_path / "export.csv"
    statement.write_text(
        "Date,Description,Paid Out,Paid In,Balance\n03/08/2026,CORNER SHOP 12,12.50,,987.50\n", encoding="utf-8"
    )
    with open(statement, "rb") as fh:
        resp = client.post(
            "/api/statements/upload",
            headers=primary_headers,
            files={"file": (statement.name, fh, "application/octet-stream")},
            data={"account_id": "acc_checking_hsbc"},
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["inserted"] == 1 and resp.json()["auto_approved"] == 1
    rows = client.get("/api/transactions", headers=primary_headers).json()["items"]
    assert len(rows) == 1
    row = rows[0]
    assert row["classification_source"] == "rule" and row["review_status"] == "auto_approved"
    assert (row["category"], row["claim_type"]) == ("Groceries", "shared_equal")
    assert (row["cleaned_merchant"], row["subcategory"]) == ("Corner Shop", "Snacks")
    assert row["transaction_date"] == "2026-08-03"
    assert Decimal(row["allocated_primary_amount"]) == Decimal("-6.25")  # shared_equal, whatever the incomes


@requires_db
def test_service_errors_map_to_the_right_status(client, primary_headers, seeded_db, config):
    """The three error classes are distinct so the router can map them without inspecting text."""
    base = config.with_accounts([])
    with pytest.raises(SiteSettingsNotFound):
        site_settings.rename_category(seeded_db, config, base, CategoryRename.model_validate({"from": "X", "to": "Y"}))
    with pytest.raises(SiteSettingsConflict):
        site_settings.rename_category(seeded_db, config, base, CategoryRename(from_="Uncategorized", to="Y"))
    with pytest.raises(SiteSettingsError):
        site_settings.try_rules(seeded_db, config, base, RuleTest(description="x", payment_patterns=["("]))
    assert site_settings.try_rules(seeded_db, config, base, RuleTest(description="AMEX DD")).is_payment is True
    water = site_settings.try_rules(seeded_db, config, base, RuleTest(description="AQUANORTH WATER"))
    assert water.rule_index == 0 and water.rule.category == "Bills:Water"
