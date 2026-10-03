"""GET /api/periods leaves out empty open months; deleting an upload removes the ones it leaves empty."""

from __future__ import annotations

import csv
from datetime import date

import pytest

from app.models import LedgerPeriod, StatementUpload
from app.services import periods, statement_uploads
from tests.conftest import requires_db
from tests.factories import make_claim, make_transaction
from tests.test_api import keyword_llm, upload

pytestmark = pytest.mark.usefixtures("client")


def _keys(client, headers) -> list[str]:
    resp = client.get("/api/periods", headers=headers)
    assert resp.status_code == 200, resp.text
    return [p["period_key"] for p in resp.json()]


def _upload_row(db, period_from: str, period_to: str, name: str = "statement.csv") -> StatementUpload:
    periods.get_or_create_period(db, period_to)
    row = StatementUpload(
        account_id="acc_checking_hsbc",
        period_key=period_to,
        period_from=period_from,
        period_to=period_to,
        filename=name,
        sha256=name[:1] * 64,
        parser="csv",
        transaction_count=1,
    )
    db.add(row)
    db.flush()
    return row


def test_months_between():
    assert periods.months_between("2025-11", "2026-02") == ["2025-11", "2025-12", "2026-01", "2026-02"]
    assert periods.months_between("2026-01", "2026-01") == ["2026-01"]
    assert periods.months_between(None, "2026-01") == []
    assert periods.months_between("2026-02", "2026-01") == []
    assert periods.months_between("2026-13", "2026-14") == []


@requires_db
def test_listing_leaves_out_empty_open_months_but_keeps_the_current_and_closed_ones(
    client, primary_headers, seeded_db, config
):
    current = periods.period_key_for(date.today())
    # A statement spanning December into January: only January has lines.
    periods.get_or_create_period(seeded_db, "2025-12")
    make_transaction(seeded_db, config, transaction_date=date(2026, 1, 4))
    _upload_row(seeded_db, "2025-12", "2026-01")
    # An empty month that was closed (a settlement record) and the current, still empty, month.
    periods.close_period(seeded_db, "2025-10")
    periods.get_or_create_period(seeded_db, current)
    # A month holding only a partner claim is listed too.
    make_claim(seeded_db, config, claim_date=date(2025, 11, 3))
    seeded_db.flush()

    assert _keys(client, primary_headers) == [current, "2026-01", "2025-11", "2025-10"]
    # The empty month's row is still there: it is only hidden.
    assert seeded_db.get(LedgerPeriod, "2025-12") is not None
    # Once it is no longer the current month, an empty month drops out like any other.
    later = [p.period_key for p in periods.listed_periods(seeded_db, today=date(2030, 1, 1))]
    assert later == ["2026-01", "2025-11", "2025-10"]


@requires_db
def test_deleting_an_upload_removes_the_empty_months_it_spans(seeded_db, config):
    december = "2025-12"
    periods.get_or_create_period(seeded_db, december)
    upload_row = _upload_row(seeded_db, december, "2026-01", name="a.csv")
    make_transaction(seeded_db, config, transaction_date=date(2026, 1, 4), upload_id=upload_row.id)
    # Another upload whose span also covers December: a span is not a reference.
    other = _upload_row(seeded_db, december, "2026-02", name="b.csv")
    make_transaction(seeded_db, config, transaction_date=date(2026, 2, 4), upload_id=other.id)
    # A closed empty month inside the span stays whatever happens.
    periods.close_period(seeded_db, "2025-11")
    upload_row.period_from = "2025-11"
    seeded_db.flush()

    assert statement_uploads.delete_upload(seeded_db, upload_row) == 1
    assert seeded_db.get(LedgerPeriod, december) is None
    assert seeded_db.get(LedgerPeriod, "2026-01") is None
    assert seeded_db.get(LedgerPeriod, "2025-11") is not None  # closed
    assert seeded_db.get(LedgerPeriod, "2026-02") is not None  # the other upload's lines


@requires_db
def test_deleting_an_uploaded_file_takes_its_empty_months_with_it(client, primary_headers, fake_llm, tmp_path):
    fake_llm.handler = keyword_llm
    path = tmp_path / "hsbc_4471_year_end.csv"
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["Date", "Description", "Paid Out", "Paid In", "Balance"])
        writer.writerow(["30/12/2025", "NORTHWIND ENERGY", "68.20", "", "1,931.80"])
        writer.writerow(["05/01/2026", "NORTHWIND ENERGY", "68.20", "", "1,863.60"])
    resp = upload(client, primary_headers, path, account_id="acc_checking_hsbc")
    assert resp.status_code == 200, resp.text
    current = periods.period_key_for(date.today())
    assert [k for k in _keys(client, primary_headers) if k != current] == ["2026-01", "2025-12"]

    assert client.delete(f"/api/statements/{resp.json()['upload_id']}", headers=primary_headers).status_code == 204
    assert [k for k in _keys(client, primary_headers) if k != current] == []
