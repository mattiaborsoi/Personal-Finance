"""Deterministic rules engine and merchant-name cleaning (pure logic, no database)."""

from __future__ import annotations

import pytest

from app.config import AppConfig, load_config_from_dict
from app.services.rules import UNKNOWN_MERCHANT, RuleMatch, clean_merchant_name, match_rule


def _config(rules: list[dict]) -> AppConfig:
    """Minimal config with custom deterministic rules and one investment account."""
    return load_config_from_dict(
        {
            "users": {
                "primary": {"id": "user_primary", "display_name": "Primary User", "base_salary_pa": 100000},
                "secondary": {"id": "user_secondary", "display_name": "Secondary User", "base_salary_pa": 80000},
            },
            "accounts": [
                {
                    "id": "acc_invest_robinhood",
                    "institution": "Robinhood",
                    "account_type": "investment_cash",
                    "owner": "user_primary",
                    "identifier_last4": "INVEST",
                }
            ],
            "deterministic_rules": rules,
        }
    )


# --------------------------------------------------------------------------- #
# clean_merchant_name
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("SP PIMORONI LTD LONDON", "Pimoroni"),
        ("WAITROSE 1234 LONDON GB", "Waitrose"),
        ("ZOOM OCADO", "Zoom Ocado"),
        ("NETFLIX.COM 866-579-7172", "Netflix"),
        ("NORTHWIND ENERGY", "Northwind Energy"),
        ("PAYMENT RECEIVED - THANK YOU", "Payment Received - Thank You"),
    ],
)
def test_clean_merchant_name_blueprint_examples(raw: str, expected: str) -> None:
    assert clean_merchant_name(raw) == expected


def test_clean_merchant_name_hsbc_card_payment_either_casing() -> None:
    assert clean_merchant_name("HSBC CARD PYMT") in {"Hsbc Card Pymt", "HSBC Card Pymt"}


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("SQ *BLUE BOTTLE COFFEE", "Blue Bottle Coffee"),
        ("PAYPAL *SPOTIFY 35314369001", "Spotify"),
        ("CRV*ACME", "Acme"),
        ("DD AQUANORTH WATER", "Aquanorth Water"),
        ("CARD PAYMENT TO TESCO STORES 2345", "Tesco Stores"),
        ("DIRECT DEBIT NORTHWIND ENERGY", "Northwind Energy"),
        # stacked prefixes are removed one after the other
        ("CARD PAYMENT TO SQ *CORNER CAFE", "Corner Cafe"),
    ],
)
def test_clean_merchant_name_strips_prefixes(raw: str, expected: str) -> None:
    assert clean_merchant_name(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("M&S SIMPLY FOOD LONDON GB", "M&S Simply Food"),
        ("BP CONNECT 1234", "BP Connect"),
        ("TFL TRAVEL CH", "TFL Travel"),
        ("APPLE.COM/BILL 866-712-7753", "Apple"),
        ("WWW.EXAMPLE.CO.UK", "Example"),
        ("SAINSBURY'S 1234 LONDON", "Sainsbury's"),
        ("AMZN MKTP US*AB12C3", "Amzn Mktp"),
        ("PARTNER TRANSFER CR", "Partner Transfer"),
        ("EE LIMITED", "EE"),
        ("ACME   SHOP\t12/08/2026", "Acme Shop"),
    ],
)
def test_clean_merchant_name_noise_and_acronyms(raw: str, expected: str) -> None:
    assert clean_merchant_name(raw) == expected


def test_clean_merchant_name_keeps_mixed_case_tokens() -> None:
    assert clean_merchant_name("PayPal iTunes") == "iTunes"
    assert clean_merchant_name("northwind energy") == "Northwind Energy"


@pytest.mark.parametrize("raw", ["", "   ", None])
def test_clean_merchant_name_blank_input_never_empty(raw: str | None) -> None:
    assert clean_merchant_name(raw) == UNKNOWN_MERCHANT  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("1234", "1234"),  # a lone store number is never stripped to nothing
        ("LONDON", "London"),  # nor a lone city
        ("LTD", "LTD"),  # company tokens fall back to the raw text
        ("DD ", "DD"),  # a bare prefix is not consumed
    ],
)
def test_clean_merchant_name_falls_back_to_raw(raw: str, expected: str) -> None:
    assert clean_merchant_name(raw) == expected


def test_clean_merchant_name_is_capped_at_column_width() -> None:
    assert len(clean_merchant_name("X" * 400)) == 255


# --------------------------------------------------------------------------- #
# match_rule
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "raw", ["AQUANORTH WATER", "AQUANORTH   WATER", "AQUANORTHWATER", "aquanorth water DD 12345"]
)
def test_match_rule_example_config_water_supplier(raw: str, config: AppConfig) -> None:
    match = match_rule(raw, config)
    assert isinstance(match, RuleMatch)
    assert match.category == "Bills:Water"
    assert match.claim_type == "shared_proportional"
    assert match.is_internal_transfer is False
    assert match.transfer_to_account is None
    assert match.subcategory is None


def test_match_rule_merchant_falls_back_to_cleaned_description(config: AppConfig) -> None:
    match = match_rule("NORTHWIND ENERGY 1234 LONDON GB", config)
    assert match is not None
    assert match.merchant == "Northwind Energy"
    assert match.rule.pattern == r"(?i)NORTHWIND\s*ENERGY"


def test_match_rule_uses_rule_merchant_when_set(config: AppConfig) -> None:
    match = match_rule("PARTNER TRANSFER CR", config)
    assert match is not None
    assert match.merchant == "Partner settlement"
    assert match.category == "Transfers:Settlement"


def test_match_rule_transfer_rule_sets_flags(config: AppConfig) -> None:
    match = match_rule("ROBINHOOD", config)
    assert match is not None
    assert match.is_internal_transfer is True
    assert match.transfer_to_account == "acc_invest_robinhood"
    assert match.merchant == "Robinhood"
    assert match.category == "Transfers:Investment"


def test_match_rule_no_match_returns_none(config: AppConfig) -> None:
    assert match_rule("WAITROSE 1234 LONDON GB", config) is None
    assert match_rule("", config) is None


def test_match_rule_first_matching_rule_wins() -> None:
    cfg = _config(
        [
            {"pattern": "(?i)ENERGY", "category": "Bills:Energy", "claim_type": "shared_proportional"},
            {"pattern": "(?i)NORTHWIND", "category": "Shopping", "claim_type": "personal"},
        ]
    )
    match = match_rule("NORTHWIND ENERGY", cfg)
    assert match is not None
    assert match.category == "Bills:Energy"
    assert match.claim_type == "shared_proportional"


def test_match_rule_transfer_to_account_implies_internal_transfer() -> None:
    cfg = _config(
        [
            {
                "pattern": "(?i)ROBINHOOD",
                "category": "Transfers:Investment",
                "transfer_to_account": "acc_invest_robinhood",
                # is_internal_transfer deliberately omitted
            }
        ]
    )
    match = match_rule("ROBINHOOD", cfg)
    assert match is not None
    assert match.rule.is_internal_transfer is False
    assert match.is_internal_transfer is True
    assert match.transfer_to_account == "acc_invest_robinhood"


def test_match_rule_copies_subcategory() -> None:
    cfg = _config(
        [{"pattern": "(?i)GYM", "category": "Health:Gym", "subcategory": "Membership", "claim_type": "personal"}]
    )
    match = match_rule("THIRD SPACE GYM", cfg)
    assert match is not None
    assert match.subcategory == "Membership"


def test_match_rule_with_no_rules() -> None:
    assert match_rule("ANYTHING", _config([])) is None
