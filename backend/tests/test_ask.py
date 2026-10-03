"""Ask: the model sees only the question and the capabilities; the query runs locally."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.services import ask
from app.services.ask import CannotAnswer, QuerySpec, anonymise_question, check, parse_answer, transactions_link
from app.services.llm import FakeLLMClient, NullLLMClient
from app.services.redaction import Redactor
from tests.conftest import requires_db
from tests.factories import make_claim, make_transaction

D = Decimal


def answering(query: dict | None = None, cannot: str | None = None) -> FakeLLMClient:
    seen: list[tuple[str, str]] = []

    def handler(system: str, user: str) -> dict:
        seen.append((system, user))
        return {"cannot": cannot} if cannot else {"query": query or {}}

    llm = FakeLLMClient(handler=handler)
    llm.seen = seen  # type: ignore[attr-defined]
    return llm


# --------------------------------------------------------------------------- #
# What leaves, and what comes back
# --------------------------------------------------------------------------- #


def test_the_prompt_carries_capabilities_but_no_ledger_and_no_names(config) -> None:
    llm = answering({"kind": "spend", "categories": ["Travel"], "months": ["2026-08"]})
    spec = ask.interpret(llm, config, "How much did Primary User and I spend on travel in August? ref 12345678",
                         today=date(2026, 10, 3))  # fmt: skip
    system, user = llm.seen[0]
    assert "Today is 2026-10-03" in system
    for category in config.categories:
        assert category in system
    assert "acc_cc_amex: Amex credit (primary user)" in system
    assert "Primary User" not in system and "Primary User" not in user
    assert user == "Question: How much did the primary user and I spend on travel in August? ref [number]"
    assert spec.categories == ["Travel"] and spec.months == ["2026-08"]


def test_anonymise_question_swaps_names_for_roles(config) -> None:
    redactor = Redactor.from_config(config)
    text = anonymise_question("What did Secondary owe me for August? Primary's card", config, redactor)
    assert text == "What did the secondary user owe me for August? the primary user card"


def test_cannot_and_unusable_answers(config) -> None:
    with pytest.raises(CannotAnswer, match="not about money"):
        ask.interpret(answering(cannot="That is not about money."), config, "What is the weather?")
    with pytest.raises(CannotAnswer, match="did not answer with a query"):
        parse_answer(["nope"], config)
    with pytest.raises(CannotAnswer, match="not valid"):
        parse_answer({"query": {"metric": "median"}}, config)
    with pytest.raises(CannotAnswer, match="not valid"):
        parse_answer({"query": {"unknown_field": 1}}, config)
    with pytest.raises(CannotAnswer, match="no category called 'Pets'"):
        parse_answer({"query": {"categories": ["Pets"]}}, config)
    with pytest.raises(CannotAnswer, match="no account called 'Monzo'"):
        parse_answer({"query": {"accounts": ["Monzo"]}}, config)
    with pytest.raises(CannotAnswer, match="not a month"):
        parse_answer({"query": {"months": ["August"]}}, config)
    with pytest.raises(CannotAnswer, match="needs a month"):
        parse_answer({"query": {"kind": "settlement"}}, config)
    with pytest.raises(CannotAnswer, match="ends before it starts"):
        parse_answer({"query": {"date_from": "2026-09-01", "date_to": "2026-08-01"}}, config)
    with pytest.raises(CannotAnswer, match="Type a question"):
        ask.interpret(answering({}), config, "   ")


def test_check_canonicalises_names(config) -> None:
    spec = check(QuerySpec(categories=["groceries", "travel"], accounts=["amex", "acc_checking_hsbc"]), config)
    assert spec.categories == ["Groceries", "Travel"]  # the exact category, and the group covering Travel:*
    assert spec.accounts == ["acc_cc_amex", "acc_cc_amex_supp", "acc_checking_hsbc"]


def test_transactions_link_is_the_closest_view(config) -> None:
    spec = QuerySpec(months=["2026-08"], categories=["Groceries"], accounts=["acc_cc_amex"], merchant_text="ocado")
    assert transactions_link(spec, config.categories) == (
        "/transactions?period=2026-08&category=Groceries&account_id=acc_cc_amex&q=ocado&include_transfers=false"
    )
    # A group covers several categories, which the page's single-category filter cannot say.
    assert transactions_link(QuerySpec(categories=["Bills"], months=["2026-07", "2026-08"]), config.categories) == (
        "/transactions?include_transfers=false"
    )
    assert "status=pending_review" in transactions_link(QuerySpec(status="pending"), config.categories)


def test_describe_filters_wording(config) -> None:
    spec = QuerySpec(categories=["Travel"], months=["2026-01", "2026-09"], people=["secondary"], group_by="month")
    assert ask.describe_filters(spec, config) == (
        "Showing: Travel, Jan 2026 to Sep 2026, Secondary User's accounts, money out, approved and pending, by month"
    )
    assert ask.describe_filters(QuerySpec(), config) == "Showing: all time, money out, approved and pending"
    assert ask.describe_filters(QuerySpec(date_from=date(2026, 1, 1), status="approved"), config) == (
        "Showing: 2026-01-01 to today, money out, approved only"
    )


# --------------------------------------------------------------------------- #
# Running queries locally
# --------------------------------------------------------------------------- #


@pytest.fixture
def ledger(seeded_db, config):
    def line(day: str, amount: str, merchant: str, category: str, **extra):
        return make_transaction(
            seeded_db, config, transaction_date=date.fromisoformat(day), amount=amount,
            raw_description=merchant.upper(), cleaned_merchant=merchant, category=category, **extra,
        )  # fmt: skip

    line("2026-07-10", "-120.00", "British Airways", "Travel:Flights")
    line("2026-08-02", "-80.00", "Premier Inn", "Travel:Hotels")
    line("2026-08-05", "-30.00", "Trainline", "Travel")
    line("2026-08-09", "-25.50", "Ocado", "Groceries", review_status="pending_review", claim_type="shared_equal")
    line("2026-08-12", "40.00", "British Airways", "Travel:Flights")  # a refund
    line("2026-08-15", "-9.99", "Netflix", "Subscriptions:Entertainment", account_id="acc_checking_barclays")
    line("2026-08-20", "-500.00", "Amex Payment", "Transfers:Internal", is_internal_transfer=True)
    make_claim(seeded_db, config, claim_date=date(2026, 8, 10), amount="50.00", merchant="Corner Shop")
    return seeded_db


@requires_db
def test_sum_count_average_and_direction(ledger, config) -> None:
    travel = QuerySpec(categories=["Travel"], months=["2026-07", "2026-08"])
    out = ask.run(ledger, config, travel)
    assert (out.value, out.count) == (D("230.00"), 3)
    assert out.answer == "£230.00 over 3 transactions."
    assert out.interpreted.startswith("Showing: Travel, Jul 2026 to Aug 2026")
    assert ask.run(ledger, config, travel.model_copy(update={"metric": "count"})).answer == "3 transactions."
    assert ask.run(ledger, config, travel.model_copy(update={"metric": "average"})).value == D("76.67")
    refunds = ask.run(ledger, config, QuerySpec(categories=["Travel"], direction="in"))
    assert (refunds.value, refunds.count) == (D("40.00"), 1)
    net = ask.run(ledger, config, QuerySpec(categories=["Travel"], direction="any"))
    assert net.value == D("-190.00")
    assert ask.run(ledger, config, QuerySpec(categories=["Travel:Hotels"])).value == D("80.00")
    assert ask.run(ledger, config, QuerySpec(merchant_text="airways", direction="any")).count == 2
    assert ask.run(ledger, config, QuerySpec(months=["2025-01"])).answer == "Nothing matches."


@requires_db
def test_status_people_accounts_claim_types_and_transfers(ledger, config) -> None:
    assert ask.run(ledger, config, QuerySpec(status="approved")).count == 4
    assert ask.run(ledger, config, QuerySpec(status="pending")).count == 1
    assert ask.run(ledger, config, QuerySpec()).count == 5  # the internal transfer never counts
    assert ask.run(ledger, config, QuerySpec(people=["secondary"])).count == 1
    assert ask.run(ledger, config, QuerySpec(accounts=["acc_checking_barclays"])).value == D("9.99")
    assert ask.run(ledger, config, QuerySpec(claim_types=["shared_equal"])).value == D("25.50")
    assert ask.run(ledger, config, QuerySpec(date_from=date(2026, 8, 1), date_to=date(2026, 8, 6))).count == 2


@requires_db
def test_group_by_and_list(ledger, config) -> None:
    by_month = ask.run(ledger, config, QuerySpec(categories=["Travel"], group_by="month"))
    assert by_month.rows == [
        {"label": "2026-07", "amount": "120.00", "count": 1},
        {"label": "2026-08", "amount": "110.00", "count": 2},
    ]
    assert by_month.answer == "2 months, totalling £230.00 in all."
    by_category = ask.run(ledger, config, QuerySpec(months=["2026-08"], group_by="category"))
    assert [r["label"] for r in by_category.rows] == [
        "Travel:Hotels", "Travel", "Groceries", "Subscriptions:Entertainment",
    ]  # fmt: skip
    listed = ask.run(ledger, config, QuerySpec(months=["2026-08"], metric="list"))
    assert listed.count == 4 and listed.answer == "4 transactions match; here are them."
    assert listed.rows[0] == {
        "date": "2026-08-15", "merchant": "Netflix", "amount": "-9.99", "category": "Subscriptions:Entertainment",
        "account_id": "acc_checking_barclays",
    }  # fmt: skip


@requires_db
def test_settlement_question(ledger, config) -> None:
    out = ask.run(ledger, config, QuerySpec(kind="settlement", settlement_period="2026-08"))
    assert out.interpreted == "Settlement for August 2026" and out.link == "/?period=2026-08"
    assert "owed" in out.answer and out.value is not None
    assert "1 line still waiting for review may change it." in out.answer
    quiet = ask.run(ledger, config, QuerySpec(kind="settlement", settlement_period="2024-01"))
    assert quiet.answer == "Nothing was owed either way for January 2024."


@requires_db
def test_ask_endpoint(client, primary_headers, secondary_headers, ledger) -> None:
    from app.services.providers import get_ask_llm

    client.app.dependency_overrides[get_ask_llm] = lambda: answering({"categories": ["Travel"], "months": ["2026-08"]})
    resp = client.post("/api/ask", headers=primary_headers, json={"question": "Travel in August?"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["answer"] == "£110.00 over 2 transactions." and body["value"] == "110.00"
    assert body["interpreted"] == "Showing: Travel, Aug 2026, money out, approved and pending"
    assert body["query"]["categories"] == ["Travel"] and body["link"].startswith("/transactions?period=2026-08")

    client.app.dependency_overrides[get_ask_llm] = lambda: answering(cannot="Settl does not know the weather.")
    resp = client.post("/api/ask", headers=primary_headers, json={"question": "Is it raining?"})
    assert resp.status_code == 422 and resp.json()["detail"] == "Settl does not know the weather."

    client.app.dependency_overrides[get_ask_llm] = lambda: FakeLLMClient(unreachable=True)
    assert client.post("/api/ask", headers=primary_headers, json={"question": "x"}).status_code == 502
    client.app.dependency_overrides[get_ask_llm] = lambda: NullLLMClient()
    assert client.post("/api/ask", headers=primary_headers, json={"question": "x"}).status_code == 409
    assert client.post("/api/ask", headers=secondary_headers, json={"question": "x"}).status_code == 403
    assert client.post("/api/ask", headers=primary_headers, json={"question": ""}).status_code == 422


@requires_db
def test_config_says_whether_the_ask_box_shows(client, primary_headers) -> None:
    # The test settings run with llm_provider=none.
    assert client.get("/api/config", headers=primary_headers).json()["ai_enabled"] is False
