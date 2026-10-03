"""Rules with an amount range: matching, validation, the tester and the callers that pass the amount."""

from __future__ import annotations

from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.config import AppConfig, ConfigError, DeterministicRule
from app.services import site_settings, transfers
from app.services.guesser import UploadState, classify
from app.services.memory import remember
from app.services.rules import match_rule
from app.services.site_settings import RulesUpdate, SiteSettingsError

from .conftest import requires_db

GYM_FEE = {
    "pattern": "(?i)THIRD\\s*SPACE",
    "category": "Health:Gym",
    "claim_type": "personal",
    "amount_min": "40.00",
    "amount_max": "40.00",
}
GYM_MEMBERSHIP = {**GYM_FEE, "amount_min": "500.00", "amount_max": None}


def _with_rules(config: AppConfig, rules: list[dict]) -> AppConfig:
    return config.model_copy(update={"deterministic_rules": [DeterministicRule.model_validate(r) for r in rules]})


# --------------------------------------------------------------------------- #
# Matching
# --------------------------------------------------------------------------- #


def test_a_ranged_rule_matches_inside_its_bounds_whatever_the_sign(config):
    cfg = _with_rules(config, [GYM_FEE, GYM_MEMBERSHIP])
    assert match_rule("THIRD SPACE CLAPHAM", cfg, Decimal("-40.00")).category == "Health:Gym"
    assert match_rule("THIRD SPACE CLAPHAM", cfg, "40").rule.amount_max == Decimal("40.00")
    # Open upper bound: the annual membership.
    assert match_rule("THIRD SPACE CLAPHAM", cfg, Decimal("-1250.00")).rule.amount_min == Decimal("500.00")
    # Outside every range: the smoothie and the massage fall through.
    assert match_rule("THIRD SPACE CLAPHAM", cfg, Decimal("-8.50")) is None
    assert match_rule("THIRD SPACE CLAPHAM", cfg, Decimal("-65.00")) is None
    assert match_rule("THIRD SPACE CLAPHAM", cfg, Decimal("-40.01")) is None


def test_a_ranged_rule_never_matches_without_an_amount(config):
    cfg = _with_rules(config, [GYM_FEE, {"pattern": "(?i)THIRD", "category": "Dining"}])
    # The next rule without a range gets the line instead.
    assert match_rule("THIRD SPACE CLAPHAM", cfg).category == "Dining"
    assert match_rule("THIRD SPACE CLAPHAM", cfg, Decimal("40.00")).category == "Health:Gym"


def test_bounds_are_inclusive_and_either_may_be_open(config):
    cfg = _with_rules(config, [{"pattern": "SHOP", "category": "Groceries", "amount_max": "10.00"}])
    assert match_rule("SHOP", cfg, Decimal("0")) is not None
    assert match_rule("SHOP", cfg, Decimal("-10.00")) is not None
    assert match_rule("SHOP", cfg, Decimal("10.01")) is None
    cfg = _with_rules(config, [{"pattern": "SHOP", "category": "Groceries", "amount_min": "10.00"}])
    assert match_rule("SHOP", cfg, Decimal("9.99")) is None
    assert match_rule("SHOP", cfg, Decimal("10.00")) is not None


def test_a_rule_without_a_range_ignores_the_amount(config):
    assert match_rule("AQUANORTH WATER", config) is not None
    assert match_rule("AQUANORTH WATER", config, Decimal("-1.00")) is not None


def test_transfer_detection_passes_the_amount_through(config):
    rule = {"pattern": "(?i)ROBINHOOD", "category": "Transfers:Investment", "is_internal_transfer": True,
            "amount_min": "100.00"}  # fmt: skip
    cfg = _with_rules(config, [rule])
    assert transfers.is_transfer_description("ROBINHOOD", cfg, Decimal("-250.00")) is True
    assert transfers.is_transfer_description("ROBINHOOD", cfg, Decimal("-5.00")) is False
    assert transfers.is_transfer_description("ROBINHOOD", cfg) is False


@pytest.mark.parametrize(
    ("rule", "message"),
    [
        ({"amount_min": "-1.00"}, "amount_min must be a non-negative amount"),
        ({"amount_max": "1.005"}, "amount_max must have at most 2 decimal places"),
        ({"amount_min": "20.00", "amount_max": "10.00"}, "amount_max must not be less than amount_min"),
    ],
)
def test_config_yaml_rules_refuse_bad_ranges(rule, message):
    with pytest.raises((ConfigError, ValidationError), match=message):
        DeterministicRule.model_validate({"pattern": "X", "category": "Groceries", **rule})


# --------------------------------------------------------------------------- #
# Validation of the stored document
# --------------------------------------------------------------------------- #


def _validate(config, rules: list[dict]):
    current = site_settings.rules_defaults(config)
    return site_settings.validate_rules(site_settings.merged_rules(current, RulesUpdate(rules=rules)), config)


@pytest.mark.parametrize(
    ("bounds", "message"),
    [
        ({"amount_min": "-0.01"}, "rule 2: amount_min must be a non-negative amount"),
        ({"amount_max": "-5"}, "rule 2: amount_max must be a non-negative amount"),
        ({"amount_min": "1.234"}, "rule 2: amount_min must have at most 2 decimal places"),
        ({"amount_min": "50.00", "amount_max": "40.00"}, "rule 2: amount_max must not be less than amount_min"),
    ],
)
def test_rule_amount_validation_names_the_rule(config, bounds, message):
    with pytest.raises(SiteSettingsError) as info:
        _validate(
            config, [{"pattern": "OK", "category": "Groceries"}, {"pattern": "X", "category": "Dining", **bounds}]
        )
    assert str(info.value) == message


def test_rule_amounts_are_stored_with_two_decimals(config):
    doc = _validate(config, [{"pattern": "OK", "category": "Groceries", "amount_min": "40", "amount_max": 40.5}])
    assert doc.rules[0].amount_min == Decimal("40.00") and str(doc.rules[0].amount_min) == "40.00"
    assert doc.rules[0].amount_max == Decimal("40.50")
    assert doc.model_dump(mode="json")["rules"][0]["amount_max"] == "40.50"


# --------------------------------------------------------------------------- #
# The API
# --------------------------------------------------------------------------- #


@requires_db
def test_rules_api_round_trips_amounts_and_refuses_bad_ones(client, primary_headers):
    info = client.get("/api/settings/rules", headers=primary_headers).json()
    assert all(r["amount_min"] is None and r["amount_max"] is None for r in info["rules"])

    for bounds, message in [
        ({"amount_min": "-1"}, "rule 1: amount_min must be a non-negative amount"),
        ({"amount_max": "9.999"}, "rule 1: amount_max must have at most 2 decimal places"),
        ({"amount_min": "41.00", "amount_max": "40.00"}, "rule 1: amount_max must not be less than amount_min"),
    ]:
        resp = client.put("/api/settings/rules", json={"rules": [{**GYM_FEE, **bounds}]}, headers=primary_headers)
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == message
    assert client.get("/api/settings/rules", headers=primary_headers).json()["stored"] is False

    resp = client.put("/api/settings/rules", json={"rules": [GYM_FEE, GYM_MEMBERSHIP]}, headers=primary_headers)
    assert resp.status_code == 200, resp.text
    saved = resp.json()["rules"]
    assert (saved[0]["amount_min"], saved[0]["amount_max"]) == ("40.00", "40.00")
    assert (saved[1]["amount_min"], saved[1]["amount_max"]) == ("500.00", None)
    again = client.get("/api/settings/rules", headers=primary_headers).json()["rules"]
    assert again == saved


@requires_db
def test_rule_tester_with_and_without_an_amount(client, primary_headers):
    def try_rules(**body):
        resp = client.post("/api/settings/rules/test", json=body, headers=primary_headers)
        assert resp.status_code == 200, resp.text
        return resp.json()

    rules = [GYM_FEE]
    assert try_rules(description="THIRD SPACE CLAPHAM", rules=rules)["rule_index"] is None
    hit = try_rules(description="THIRD SPACE CLAPHAM", amount="-40.00", rules=rules)
    assert hit["rule_index"] == 0 and hit["rule"]["amount_min"] == "40.00"
    assert try_rules(description="THIRD SPACE CLAPHAM", amount="8.50", rules=rules)["rule_index"] is None
    # An unranged rule matches with or without an amount.
    assert try_rules(description="AQUANORTH WATER")["rule_index"] == 0
    assert try_rules(description="AQUANORTH WATER", amount=12.3)["rule_index"] == 0
    bad = client.post(
        "/api/settings/rules/test",
        json={"description": "THIRD SPACE", "rules": [{**GYM_FEE, "amount_min": "-1"}]},
        headers=primary_headers,
    )
    assert bad.status_code == 422 and bad.json()["detail"] == "rule 1: amount_min must be a non-negative amount"


# --------------------------------------------------------------------------- #
# The guesser: the gym example
# --------------------------------------------------------------------------- #


@requires_db
def test_the_gym_rule_files_only_the_locker_fee(db, config, embedder, fake_llm):
    cfg = _with_rules(config, [GYM_FEE])
    amex = cfg.account_by_id("acc_cc_amex")
    remember(db, embedder, "THIRD SPACE CLAPHAM", normalized_merchant="Third Space", category="Dining",
             claim_type="personal")  # fmt: skip

    fee = classify(db, cfg, embedder, fake_llm, "THIRD SPACE CLAPHAM", amex, amount=Decimal("-40.00"))
    assert (fee.source, fee.category, fee.review_status) == ("rule", "Health:Gym", "auto_approved")

    smoothie = classify(db, cfg, embedder, fake_llm, "THIRD SPACE CLAPHAM", amex, amount=Decimal("-8.50"))
    assert (smoothie.source, smoothie.category) == ("memory", "Dining")

    # Within one upload the memo must not hand the rule's answer to another amount, or the reverse.
    state = UploadState()
    first = classify(db, cfg, embedder, fake_llm, "THIRD SPACE CLAPHAM", amex, amount=Decimal("-40.00"), state=state)
    second = classify(db, cfg, embedder, fake_llm, "THIRD SPACE CLAPHAM", amex, amount=Decimal("-8.50"), state=state)
    third = classify(db, cfg, embedder, fake_llm, "THIRD SPACE CLAPHAM", amex, amount=Decimal("-40.00"), state=state)
    assert [c.source for c in (first, second, third)] == ["rule", "memory", "rule"]
    assert [c.category for c in (first, second, third)] == ["Health:Gym", "Dining", "Health:Gym"]
