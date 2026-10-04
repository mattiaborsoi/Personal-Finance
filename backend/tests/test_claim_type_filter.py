"""GET /api/transactions?claim_type= (synthetic data)."""

from __future__ import annotations

from datetime import date

import pytest

from tests.conftest import requires_db
from tests.factories import make_transaction

pytestmark = pytest.mark.usefixtures("client")


@requires_db
def test_filters_by_claim_type_including_split_parts(client, primary_headers, seeded_db, config):
    db = seeded_db
    shared = make_transaction(
        db, config, raw_description="WAITROSE 1", claim_type="shared_equal", transaction_date=date(2026, 8, 3)
    )
    make_transaction(db, config, raw_description="PRET 1", claim_type="personal", transaction_date=date(2026, 8, 4))
    parent = make_transaction(
        db, config, raw_description="M AND S 1", claim_type="personal", amount="-10.00",
        transaction_date=date(2026, 8, 5), is_split=True,
    )
    make_transaction(
        db, config, raw_description="M AND S 1", claim_type="shared_equal", amount="-6.00",
        transaction_date=date(2026, 8, 5), split_parent_id=parent.id, split_index=1,
    )
    db.commit()

    resp = client.get("/api/transactions", headers=primary_headers, params={"claim_type": "shared_equal"})
    assert resp.status_code == 200, resp.text
    ids = {t["id"] for t in resp.json()["items"]}
    # The shared line and the split whose part is shared; the personal line is left out.
    assert ids == {str(shared.id), str(parent.id)}

    personal = client.get("/api/transactions", headers=primary_headers, params={"claim_type": "personal"}).json()
    # A split parent counts through its parts only, so its own "personal" doesn't match.
    assert str(parent.id) not in {t["id"] for t in personal["items"]}

    bad = client.get("/api/transactions", headers=primary_headers, params={"claim_type": "nonsense"})
    assert bad.status_code == 422
