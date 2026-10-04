"""GET /api/transactions?sort=&order= (synthetic data)."""

from __future__ import annotations

from datetime import date

import pytest

from tests.conftest import requires_db
from tests.factories import make_transaction

pytestmark = pytest.mark.usefixtures("client")


@requires_db
def test_sorts_by_amount_size_and_by_merchant(client, primary_headers, seeded_db, config):
    db = seeded_db
    for raw, merchant, amount, day in (
        ("WAITROSE 1", "Waitrose", "-42.10", 3),
        ("PRET 1", "Pret", "-4.20", 4),
        ("REFUND 1", "Argos", "120.00", 5),
        ("BOOTS 1", "boots", "-12.99", 6),
    ):
        make_transaction(db, config, raw_description=raw, cleaned_merchant=merchant, amount=amount,
                         transaction_date=date(2026, 8, day))
    db.commit()

    def merchants(**params):
        resp = client.get("/api/transactions", headers=primary_headers, params=params)
        assert resp.status_code == 200, resp.text
        return [t["cleaned_merchant"] for t in resp.json()["items"]]

    # Default: newest first.
    assert merchants() == ["boots", "Argos", "Pret", "Waitrose"]
    # Size, whichever way the money went: the £120 refund is the largest.
    assert merchants(sort="amount", order="desc") == ["Argos", "Waitrose", "boots", "Pret"]
    assert merchants(sort="amount", order="asc") == ["Pret", "boots", "Waitrose", "Argos"]
    # Names ignore case.
    assert merchants(sort="merchant", order="asc") == ["Argos", "boots", "Pret", "Waitrose"]
    assert client.get("/api/transactions", headers=primary_headers, params={"sort": "size"}).status_code == 422
