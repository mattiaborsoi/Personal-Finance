"""AI usage counters (requests, failures, tokens per job per month) and the accuracy figure."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest

from app.models import AiUsage, Transaction
from app.services import ai_accuracy, ai_usage
from app.services.ai_usage import Counts, Tally
from app.services.llm import LiteLLMClient, LLMError, LLMStatusError
from tests.conftest import requires_db
from tests.factories import make_transaction


@pytest.fixture(autouse=True)
def fresh_tally(monkeypatch):
    tally = Tally()
    monkeypatch.setattr(ai_usage, "tally", tally)
    return tally


def test_tally_adds_up_per_job_and_month(fresh_tally: Tally) -> None:
    ai_usage.record("chat", {"prompt_tokens": 120, "completion_tokens": 30})
    ai_usage.record("chat", {"prompt_tokens": "80", "completion_tokens": None})
    ai_usage.record_failure("audit")
    ai_usage.record("ask", "not a dict")  # type: ignore[arg-type]
    month = ai_usage.current_month()
    counts = fresh_tally.peek()
    assert counts[(month, "chat")] == Counts(requests=2, failures=0, prompt_tokens=200, completion_tokens=30)
    assert counts[(month, "audit")] == Counts(requests=1, failures=1, prompt_tokens=0, completion_tokens=0)
    assert counts[(month, "ask")] == Counts(requests=1)


def test_litellm_client_records_usage_and_failures(fresh_tally: Tally) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.read().decode())
        assert payload["temperature"] == 0 and payload["response_format"] == {"type": "json_object"}
        if payload["model"] == "down":
            return httpx.Response(503, json={"error": "down"})
        if payload["model"] == "garbage":
            return httpx.Response(200, json={"choices": [{"message": {"content": "not json"}}]})
        usage = {"prompt_tokens": 42, "completion_tokens": 7}
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": true}'}}], "usage": usage})

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = LiteLLMClient("http://proxy.test", "key", "fine", client=http, job="extraction")
    assert client.complete_json(system="s", user="u") == {"ok": True}
    def chat(model: str) -> LiteLLMClient:
        return LiteLLMClient("http://proxy.test", "key", model, client=http, job="chat")

    with pytest.raises(LLMStatusError):
        chat("down").complete_json(system="s", user="u")
    with pytest.raises(LLMError):
        chat("garbage").complete_json(system="s", user="u")
    month = ai_usage.current_month()
    counts = fresh_tally.peek()
    assert counts[(month, "extraction")] == Counts(requests=1, prompt_tokens=42, completion_tokens=7)
    # The unparseable answer still cost a request (and whatever tokens the proxy did not report).
    assert counts[(month, "chat")] == Counts(requests=2, failures=1)


@requires_db
def test_flush_writes_rows_and_usage_for_month_adds_the_unflushed(db, fresh_tally: Tally) -> None:
    month = ai_usage.current_month()
    ai_usage.record("chat", {"prompt_tokens": 10, "completion_tokens": 5})
    ai_usage.flush(db)
    assert fresh_tally.peek() == {}
    row = db.get(AiUsage, (month, "chat"))
    assert (row.requests, row.prompt_tokens, row.completion_tokens, row.failures) == (1, 10, 5, 0)

    ai_usage.record("chat", {"prompt_tokens": 1})
    ai_usage.record_failure("audit")
    ai_usage.record("chat", {"prompt_tokens": 2})
    summary = {u.job: u.counts for u in ai_usage.usage_for_month(db, month)}
    assert summary["chat"] == Counts(requests=3, prompt_tokens=13, completion_tokens=5)
    assert summary["audit"] == Counts(requests=1, failures=1)
    ai_usage.flush(db)
    assert db.get(AiUsage, (month, "chat")).requests == 3
    assert ai_usage.usage_for_month(db, "1999-01") == []


def test_record_approval_compares_with_the_suggestion() -> None:
    txn = Transaction(category="Groceries", claim_type="personal", suggested_category=None)
    ai_accuracy.record_approval(txn)
    assert txn.suggestion_accepted is None
    txn.suggested_category, txn.suggested_claim_type = "Groceries", "personal"
    ai_accuracy.record_approval(txn)
    assert txn.suggestion_accepted is True
    txn.claim_type = "shared_equal"
    ai_accuracy.record_approval(txn)
    assert txn.suggestion_accepted is False


@requires_db
def test_stats_count_the_last_90_days(seeded_db, config, fresh_tally: Tally) -> None:
    def line(**extra):
        return make_transaction(seeded_db, config, amount=Decimal("-5.00"), classification_source="llm", **extra)

    line(suggested_category="Groceries", suggested_claim_type="shared_proportional", suggestion_accepted=True)
    line(suggested_category="Groceries", suggested_claim_type="shared_proportional", suggestion_accepted=False,
         category="Dining")  # fmt: skip
    line(suggested_category="Groceries", suggested_claim_type="shared_proportional", review_status="pending_review")
    line()  # memory or rule: not the AI's doing
    old = line(suggested_category="Groceries", suggested_claim_type="shared_proportional", suggestion_accepted=True)
    old.created_at = datetime(2020, 1, 1, tzinfo=UTC)
    seeded_db.flush()
    ai_usage.record("chat", {"prompt_tokens": 500, "completion_tokens": 60})
    stats = ai_accuracy.stats(seeded_db)
    assert (stats.window_days, stats.classified, stats.approved, stats.accepted) == (90, 3, 2, 1)
    assert stats.acceptance_rate == 0.5
    assert [(u.job, u.requests, u.prompt_tokens) for u in stats.usage] == [("chat", 1, 500)]


@requires_db
def test_ai_settings_payload_carries_stats_and_layouts(client, primary_headers) -> None:
    body = client.get("/api/ai", headers=primary_headers).json()
    assert body["stats"]["window_days"] == 90 and body["stats"]["acceptance_rate"] is None
    assert body["stats"]["classified"] == 0 and isinstance(body["stats"]["usage"], list)
    assert body["layouts"] == []
    assert body["redact_words"] == []

    saved = client.put("/api/ai", headers=primary_headers, json={"redact_words": [" Acme Corp ", "", "acme corp", "x"]})
    assert saved.status_code == 200, saved.text
    assert saved.json()["redact_words"] == ["Acme Corp", "x"]
    too_long = client.put("/api/ai", headers=primary_headers, json={"redact_words": ["y" * 65]})
    assert too_long.status_code == 422
