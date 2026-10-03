"""Redaction before anything leaves for a model: names, numbers, postcodes, e-mails, phones, extra words."""

from __future__ import annotations

import pytest

from app.config import AppConfig
from app.services.redaction import Redactor, strip_placeholders


@pytest.fixture
def redactor(config: AppConfig) -> Redactor:
    # config.example.yaml names the two users "Primary User" and "Secondary User".
    privacy = config.privacy.model_copy(update={"redact_words": ["Acme Corp", "flat 4b"]})
    return Redactor.from_config(config.model_copy(update={"privacy": privacy}))


def test_household_names_are_masked_word_by_word_ignoring_case(redactor: Redactor) -> None:
    assert redactor.redact("PAYPAL *PRIMARY USER 12") == "PAYPAL *[name] [name] 12"
    assert redactor.redact("transfer to secondary user") == "transfer to [name] [name]"
    assert redactor.redact("Primary") == "[name]"
    # Only whole words: a merchant that merely contains the letters keeps its name.
    assert redactor.redact("USERLAND SUPPLIES") == "USERLAND SUPPLIES"


def test_long_digit_runs_sort_codes_and_card_numbers(redactor: Redactor) -> None:
    assert redactor.redact("REF 123456") == "REF [number]"
    assert redactor.redact("ACCOUNT 12345678 SORT 00-00-00") == "ACCOUNT [number] SORT [number]"
    assert redactor.redact("Card 0000 0000 0000 5502") == "Card [card:5502]"
    assert redactor.redact("Primary User 0000 00000000 5502") == "[name] [name] [card:5502]"
    assert redactor.redact("0000000000005502") == "[card:5502]"


def test_dates_amounts_and_short_numbers_are_kept(redactor: Redactor) -> None:
    for text in (
        "WAITROSE 1234 LONDON",
        "Card ending 7715",
        "03/08/2026",
        "2026-07-31 to 2026-08-28",
        "Credit limit 10,000.00",
        "3,384.21 CR",
        "16 Aug 26 17 Aug 26",
        "12:34",
    ):
        assert redactor.redact(text) == text


def test_postcodes_emails_and_phones(redactor: Redactor) -> None:
    assert redactor.redact("12 High St SW1A 1AA") == "12 High St [postcode]"
    assert redactor.redact("Flat 1, m1 2ab") == "Flat 1, [postcode]"
    assert redactor.redact("mail someone.else+x@example.com now") == "mail [email] now"
    assert redactor.redact("call 07700 900123") == "call [phone]"
    assert redactor.redact("call +44 7700 900123") == "call [phone]"
    assert redactor.redact("tel (020) 7946 0123") == "tel [phone]"


def test_extra_words_are_masked_as_whole_phrases_ignoring_case(redactor: Redactor) -> None:
    assert redactor.redact("ACME CORP LTD 42") == "[word] LTD 42"
    assert redactor.redact("Flat 4B, London") == "[word], London"
    assert redactor.redact("ACMECORPORATION") == "ACMECORPORATION"


def test_empty_and_none(redactor: Redactor) -> None:
    assert redactor.redact("") == ""
    assert redactor.redact(None) == ""
    assert Redactor().redact("Primary User 123456") == "Primary User [number]"  # no names configured


def test_indexed_placeholders_restore_the_original_text(redactor: Redactor) -> None:
    text = "DD PRIMARY USER REF 987654321 someone@example.com SW1A 1AA 03/08/2026 15.81"
    redacted, originals = redactor.redact_indexed(text)
    assert redacted == "DD [name#4] [name#5] REF [number#3] [email#1] [postcode#2] 03/08/2026 15.81"
    assert originals["[name#4]"] == "PRIMARY" and originals["[number#3]"] == "987654321"
    assert Redactor.restore(redacted, originals) == text
    # A placeholder the model made up stays visible rather than becoming something else.
    assert Redactor.restore("X [number#9] Y", originals) == "X [number#9] Y"
    assert Redactor.restore("", originals) == ""


def test_card_placeholder_keeps_the_last_four_for_sections(redactor: Redactor) -> None:
    redacted, originals = redactor.redact_indexed("Secondary User 0000 000000006617")
    assert redacted == "[name#2] [name#3] [card#1:6617]"
    assert originals["[card#1:6617]"] == "0000 000000006617"


def test_strip_placeholders_cleans_a_model_echo() -> None:
    assert strip_placeholders("Tesco [number] Express") == "Tesco Express"
    assert strip_placeholders("[name#2] [card#1:1234]") == ""
    assert strip_placeholders(None) == ""


def test_redact_words_limits(config: AppConfig) -> None:
    many = [f"word{i}" for i in range(80)]
    r = Redactor(words=many)
    assert r.redact("word1 word49 word60") == "[word] [word] word60"  # only the first 50 are used
