"""Learnt PDF layouts: templates, fingerprints, learning from the LLM fallback and replaying without AI."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from app.services import layouts
from app.services.layouts import MemoryLayoutStore, layout_fingerprint
from app.services.llm import FakeLLMClient
from app.services.parsers.base import ParsedTransaction, StatementDocument, StatementMetadata
from app.services.parsers.registry import detect_document, parse_statement
from app.services.parsers.template import Template, TemplateError, TemplateParser, clean_template, reproduces
from app.services.redaction import Redactor
from tests.conftest import requires_db

D = Decimal

# A made-up bank whose statement prints the description first, then the amount, then
# the date: nothing the deterministic parsers recognise (they want a leading date).
ROWS_A = [
    ("WAITROSE LONDON", "15.81", "", "15/08/2026"),
    ("PAYMENT RECEIVED THANK YOU", "250.00", "CR", "12/08/2026"),
    ("CINEWORLD", "20.99", "", "31/07/2026"),
]
ROWS_B = [
    ("TFL TRAVEL CHARGE", "6.80", "", "03/09/2026"),
    ("PRET A MANGER", "8.45", "", "05/09/2026"),
]

TEMPLATE = {
    "line": r"^(?P<description>[A-Z][A-Z ]+?)\s+(?P<amount>[\d,]+\.\d{2})(?P<cr>\s+CR)?\s+(?P<date>\d{2}/\d{2}/\d{4})$",
    "sign": "unsigned_is_debit",
    "day_first": True,
    "card_section": r"(?i)^card number ending (?P<last4>\d{4})$",
    "skip": [r"(?i)^(?:total|closing balance)"],
    "continuation": False,
}


def fictional_pdf(path: Path, rows, holder: str = "Primary User") -> Path:
    c = canvas.Canvas(str(path), pagesize=A4)
    y = 800
    for text in (
        "Fictional Bank plc",
        "Credit card statement",
        holder,
        "Flat 2, 1 Example Street, SW1A 1AA",
        "Statement date 28 September 2026",
        "Card number ending 7715",
        "Purchases and credits",
    ):
        c.drawString(50, y, text)
        y -= 18
    for description, amount, marker, day in rows:
        c.drawString(50, y, f"{description} {amount}{(' ' + marker) if marker else ''} {day}")
        y -= 18
    c.drawString(50, y, "Total 999.99")
    c.save()
    return path


@pytest.fixture
def pdf_a(tmp_path) -> Path:
    return fictional_pdf(tmp_path / "fictional_a.pdf", ROWS_A)


@pytest.fixture
def pdf_b(tmp_path) -> Path:
    return fictional_pdf(tmp_path / "fictional_b.pdf", ROWS_B, holder="Secondary User")


EXPECTED_A = [
    ParsedTransaction(date(2026, 8, 15), "WAITROSE LONDON", D("-15.81"), card_last4="7715"),
    ParsedTransaction(date(2026, 8, 12), "PAYMENT RECEIVED THANK YOU", D("250.00"), card_last4="7715"),
    ParsedTransaction(date(2026, 7, 31), "CINEWORLD", D("-20.99"), card_last4="7715"),
]


def llm_lines(rows) -> list[dict]:
    return [
        {"date": f"{d[6:]}-{d[3:5]}-{d[:2]}", "raw_text": desc, "amount": float(amt) * (1 if cr else -1),
         "card_last4": "7715"}  # fmt: skip
        for desc, amt, cr, d in rows
    ]


def learning_llm(rows, template=TEMPLATE) -> FakeLLMClient:
    """Answers the extraction call with ``rows`` and the layout call with ``template``."""

    def handler(system: str, user: str) -> dict:
        if "statement_metadata" in system:
            return {"statement_metadata": {"institution": "Fictional Bank"}, "transactions": llm_lines(rows)}
        return dict(template)

    return FakeLLMClient(handler=handler)


# --------------------------------------------------------------------------- #
# Templates
# --------------------------------------------------------------------------- #


def test_template_validation() -> None:
    Template.from_dict(TEMPLATE)
    with pytest.raises(TemplateError, match="missing named group"):
        Template.from_dict({**TEMPLATE, "line": r"^(?P<date>\d+) (?P<amount>\d+)$"})
    with pytest.raises(TemplateError, match="nested quantifiers"):
        Template.from_dict({**TEMPLATE, "line": r"^(?P<description>(a+)+)(?P<date>x)(?P<amount>y)$"})
    with pytest.raises(TemplateError, match="sign must be"):
        Template.from_dict({**TEMPLATE, "sign": "backwards"})
    with pytest.raises(TemplateError, match="debit_credit needs"):
        Template.from_dict({**TEMPLATE, "sign": "debit_credit"})
    with pytest.raises(TemplateError, match="longer than"):
        Template.from_dict({**TEMPLATE, "line": "(?P<date>a)(?P<description>b)(?P<amount>c)" + "x" * 400})
    with pytest.raises(TemplateError, match="card_section: missing named group"):
        Template.from_dict({**TEMPLATE, "card_section": "card"})
    with pytest.raises(TemplateError, match="invalid regex"):
        Template.from_dict({**TEMPLATE, "skip": ["("]})
    with pytest.raises(TemplateError, match="unsupported template version"):
        Template.from_dict({**TEMPLATE, "version": 7})
    assert clean_template({**TEMPLATE, "extra": "dropped"}) == {"version": 1, **TEMPLATE}


def test_template_parser_reads_the_fictional_layout(pdf_a, config) -> None:
    doc = StatementDocument(pdf_a)
    result = TemplateParser(TEMPLATE, config, detect_document(doc, config)).parse(doc)
    assert result.parser_name == "pdf_template"
    assert result.transactions == EXPECTED_A
    assert reproduces(result, EXPECTED_A)
    assert not reproduces(result, EXPECTED_A[:2])
    assert not reproduces(result, [*EXPECTED_A[:2], ParsedTransaction(date(2026, 7, 31), "CINEWORLD", D("-21.00"))])


def test_template_parser_signed_and_debit_credit_columns(config) -> None:
    signed_line = TEMPLATE["line"].replace("(?P<amount>", "(?P<amount>-?")
    signed = TemplateParser({**TEMPLATE, "sign": "signed", "line": signed_line}, config)
    out = signed.parse_pages(["SHOP -12.00 01/09/2026", "REFUND 5.00 02/09/2026"], StatementMetadata())
    assert [t.amount for t in out.transactions] == [D("-12.00"), D("5.00")]
    columns = TemplateParser(
        {
            "line": r"^(?P<date>\d{2}/\d{2}/\d{4}) (?P<description>.+?) (?P<debit>[\d.]+|-) (?P<credit>[\d.]+|-)$",
            "sign": "debit_credit",
        },
        config,
    )
    out = columns.parse_pages(["01/09/2026 SHOP 12.00 -", "02/09/2026 SALARY - 1500.00"], out.metadata)
    assert [t.amount for t in out.transactions] == [D("-12.00"), D("1500.00")]


def test_fingerprint_ignores_names_numbers_and_dates(pdf_a, pdf_b, config) -> None:
    redactor = Redactor.from_config(config)
    a = StatementDocument(pdf_a).text_pages[0]
    b = StatementDocument(pdf_b).text_pages[0]
    assert layout_fingerprint(a, "Fictional Bank", redactor) == layout_fingerprint(b, "Fictional Bank", redactor)
    assert layout_fingerprint(a, "Fictional Bank", redactor) != layout_fingerprint(a, "Other Bank", redactor)
    assert layout_fingerprint("", None, redactor) == layout_fingerprint("", "", redactor)


# --------------------------------------------------------------------------- #
# Learning and replay through the registry
# --------------------------------------------------------------------------- #


def test_first_pdf_learns_the_layout_and_the_next_one_needs_no_ai(pdf_a, pdf_b, config) -> None:
    store = MemoryLayoutStore()
    llm = learning_llm(ROWS_A)
    first = parse_statement(pdf_a, config, llm=llm, layouts=store)
    assert first.parser_name == "llm_layout"
    assert len(llm.calls) == 2  # the extraction and the layout follow-up
    layout_call = llm.calls[1]
    assert "Statement date" in layout_call["user"] and "Primary" not in layout_call["user"]  # redacted page text
    assert '"raw_text": "WAITROSE LONDON"' in layout_call["user"]
    assert first.warnings[-1].startswith("the layout of this statement was learnt")
    assert len(store.templates) == 1

    down = FakeLLMClient(unreachable=True)
    second = parse_statement(pdf_b, config, llm=down, layouts=store)
    assert second.parser_name == "pdf_template" and down.calls == []
    assert [(t.raw_text, t.amount, t.date) for t in second.transactions] == [
        ("TFL TRAVEL CHARGE", D("-6.80"), date(2026, 9, 3)),
        ("PRET A MANGER", D("-8.45"), date(2026, 9, 5)),
    ]
    assert second.warnings[0].endswith("used a layout learnt earlier (no AI)")
    assert list(store.uses.values()) == [1]


def test_a_template_that_does_not_reproduce_the_lines_is_not_kept(pdf_a, config) -> None:
    store = MemoryLayoutStore()
    wrong = {**TEMPLATE, "sign": "signed"}  # would flip every charge
    result = parse_statement(pdf_a, config, llm=learning_llm(ROWS_A, wrong), layouts=store)
    assert result.parser_name == "llm_layout" and store.templates == {}
    assert not any("learnt" in w for w in result.warnings)

    broken = learning_llm(ROWS_A, {"line": "(("})
    assert parse_statement(pdf_a, config, llm=broken, layouts=store).parser_name == "llm_layout"
    assert store.templates == {}


def test_layout_learning_failure_never_breaks_the_upload(pdf_a, config) -> None:
    calls = 0

    def handler(system: str, user: str) -> dict:
        nonlocal calls
        calls += 1
        if calls == 1:
            return {"statement_metadata": {}, "transactions": llm_lines(ROWS_A)}
        raise RuntimeError("boom")

    result = parse_statement(pdf_a, config, llm=FakeLLMClient(handler=handler), layouts=MemoryLayoutStore())
    assert result.parser_name == "llm_layout" and len(result.transactions) == 3


def test_without_a_store_nothing_is_learnt(pdf_a, config) -> None:
    llm = learning_llm(ROWS_A)
    parse_statement(pdf_a, config, llm=llm)
    assert len(llm.calls) == 1


@requires_db
def test_layouts_are_stored_listed_and_deleted_through_the_api(client, primary_headers, seeded_db, pdf_a, pdf_b):
    from app.services.providers import get_extraction_llm

    client.app.dependency_overrides[get_extraction_llm] = lambda: learning_llm(ROWS_A)
    with open(pdf_a, "rb") as fh:
        resp = client.post("/api/statements/upload", headers=primary_headers, data={"account_id": "acc_cc_amex"},
                           files={"file": ("fictional_a.pdf", fh, "application/pdf")})  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["parser"] == "llm_layout"
    listed = client.get("/api/ai", headers=primary_headers).json()["layouts"]
    assert len(listed) == 1 and listed[0]["institution"] == "Fictional Bank" and listed[0]["times_used"] == 0

    client.app.dependency_overrides[get_extraction_llm] = lambda: FakeLLMClient(unreachable=True)
    with open(pdf_b, "rb") as fh:
        resp = client.post("/api/statements/upload", headers=primary_headers, data={"account_id": "acc_cc_amex"},
                           files={"file": ("fictional_b.pdf", fh, "application/pdf")})  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["parser"] == "pdf_template" and resp.json()["inserted"] == 2
    listed = client.get("/api/ai", headers=primary_headers).json()["layouts"]
    assert listed[0]["times_used"] == 1 and listed[0]["last_used_at"] is not None

    assert client.delete(f"/api/ai/layouts/{listed[0]['id']}", headers=primary_headers).status_code == 204
    assert client.get("/api/ai", headers=primary_headers).json()["layouts"] == []
    assert client.delete(f"/api/ai/layouts/{listed[0]['id']}", headers=primary_headers).status_code == 404
    assert layouts.list_layouts(seeded_db) == []
