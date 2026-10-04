"""Bank codes in merchant names (synthetic data)."""

from __future__ import annotations

from datetime import date

import pytest

from app.models import Transaction
from app.services.merchant_tidy import tidied, tidy_stored_names
from app.services.rules import clean_merchant_name
from tests.conftest import requires_db
from tests.factories import make_transaction


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("ACME WATER 900000000000 DDR", "Acme Water"),
        ("FIT CLUB CW000000001 DDR", "Fit Club"),
        ("FIT CLUB CW000000001 FIRST DDR", "Fit Club"),
        ("FIBRE NET DD FIRST PAYMENT DD", "Fibre Net"),
        ("LIFE COVER 0000000000/ 01 DDR", "Life Cover"),
        ("POWER CO A-E00b0c00-000 DDR", "Power Co"),
        ("ACME PAYROLL BGC", "Acme Payroll"),
        # One token is never cut away, however code-like.
        ("DDR", "DDR"),
    ],
)
def test_bank_codes_and_the_references_before_them_are_dropped(raw, expected):
    assert clean_merchant_name(raw) == expected


def test_tidied_leaves_ordinary_names_alone():
    assert tidied("First Direct") == "First Direct"
    assert tidied("Acme Water 900000000000 DDR") == "Acme Water"


@requires_db
def test_stored_names_are_tidied_once(seeded_db, config):
    db = seeded_db
    old = make_transaction(
        db, config, raw_description="ACME WATER 900000000000 DDR", transaction_date=date(2026, 8, 1)
    )
    old.cleaned_merchant = "Acme Water 900000000000 DDR"
    kept = make_transaction(db, config, raw_description="PRET 1", transaction_date=date(2026, 8, 2))
    kept.cleaned_merchant = "Pret"
    db.flush()

    assert tidy_stored_names(db) == 1
    assert db.get(Transaction, old.id).cleaned_merchant == "Acme Water"
    assert db.get(Transaction, kept.id).cleaned_merchant == "Pret"
    assert tidy_stored_names(db) == 0
