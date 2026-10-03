"""The Guesser's batched model calls: grouping, concurrency, per-line fallbacks, memo, redaction."""

from __future__ import annotations

import threading
import time
from decimal import Decimal

import pytest

from app.config import AppConfig
from app.services import guesser
from app.services.guesser import Pending, UploadState, batches_of, classify_many, max_tokens_for, split_answers
from app.services.llm import FakeLLMClient
from app.services.memory import remember
from tests.conftest import requires_db


def answer(position: int, **overrides) -> dict:
    return {
        "id": position,
        "merchant": f"Shop {position}",
        "category": "Groceries",
        "claim_type": "personal",
        "confidence": 0.8,
        **overrides,
    }


def numbered_lines(user: str) -> list[tuple[int, str]]:
    out = []
    for line in user.splitlines():
        head, _, rest = line.partition(" | ")
        if head.isdigit():
            out.append((int(head), rest))
    return out


def echo_llm(system: str, user: str) -> dict:
    return {"answers": [answer(n) for n, _ in numbered_lines(user)]}


@pytest.fixture
def amex(config: AppConfig):
    return config.account_by_id("acc_cc_amex")


@pytest.fixture
def amex_supp(config: AppConfig):
    return config.account_by_id("acc_cc_amex_supp")


def test_batches_group_per_account_and_cap_the_size(amex, amex_supp) -> None:
    pendings = [Pending(f"L{i}", amex if i % 3 else amex_supp, None, [], None) for i in range(60)]
    batches = batches_of(pendings, size=25)
    assert [len(b) for b in batches] == [20, 25, 15]  # the first line's account comes first
    assert all(len({p.account.id for p in b}) == 1 for b in batches)
    assert [p.raw for b in batches for p in b if p.account is amex][:3] == ["L1", "L2", "L4"]


def test_max_tokens_scales_with_the_batch() -> None:
    assert max_tokens_for(1) == 230
    assert max_tokens_for(25) == 2870
    assert max_tokens_for(1000) == guesser.MAX_BATCH_TOKENS


def test_split_answers_matches_ids_and_tolerates_rubbish() -> None:
    payload = {"answers": [answer(2), {"id": "1", "category": "Dining"}, {"id": 9}, "junk", {"id": 2, "category": "X"}]}
    one, two, three = split_answers(payload, 3)
    assert one == {"id": "1", "category": "Dining"} and two["merchant"] == "Shop 2" and three is None
    assert split_answers({"category": "Dining"}, 1) == [{"category": "Dining"}]  # a bare answer for a batch of one
    assert split_answers({"category": "Dining"}, 2) == [None, None]
    assert split_answers(["nope"], 2) == [None, None]


@requires_db
def test_classify_many_batches_unknown_lines_and_keeps_the_order(db, config, embedder, amex, amex_supp) -> None:
    remember(db, embedder, "WAITROSE LONDON", normalized_merchant="Waitrose", category="Groceries",
             claim_type="shared_proportional")  # fmt: skip
    llm = FakeLLMClient(handler=echo_llm)
    state = UploadState()
    lines = [
        ("AQUANORTH WATER", amex, Decimal("-30.00")),  # rule
        ("NEW CAFE 12", amex, Decimal("-4.50")),
        ("WAITROSE 4321 LONDON", amex, Decimal("-20.00")),  # memory
        ("NEW CAFE 34", amex, Decimal("-4.50")),  # the same question again (store numbers aside): one place
        ("OTHER BAR", amex_supp, Decimal("-9.00")),
        ("AMEX PAYMENT", amex, Decimal("100.00")),  # transfer
        ("NEW CAFE 12", amex_supp, Decimal("-4.50")),  # another card is another question
    ]
    results = classify_many(db, config, embedder, llm, lines, state)
    assert [r.source for r in results] == ["rule", "llm", "memory", "llm", "llm", "transfer", "llm"]
    # Two batches, one per account, three distinct questions in all.
    assert len(llm.calls) == 2 and state.llm_requests == 2
    asked = sorted(numbered_lines(c["user"]) for c in llm.calls)
    assert asked == [
        [(1, '"NEW CAFE 12" | -4.50 GBP')],
        [(1, '"OTHER BAR" | -9.00 GBP'), (2, '"NEW CAFE 12" | -4.50 GBP')],
    ]
    assert results[1] == results[3] and results[1] is not results[3]
    assert results[1].cleaned_merchant == "Shop 1"
    assert results[4].cleaned_merchant == "Shop 1" and results[6].cleaned_merchant == "Shop 2"
    assert state.bad_answers == 0 and state.llm_outage is None


@requires_db
def test_a_bad_or_missing_answer_only_affects_its_own_line(db, config, embedder, amex) -> None:
    def partial(system: str, user: str) -> dict:
        return {"answers": [answer(1), answer(3, category="Nonsense", confidence=0.6), {"id": 2, "merchant": 5}]}

    llm = FakeLLMClient(handler=partial)
    state = UploadState()
    lines = [(f"SHOP {name}", amex, None) for name in ("ANNE", "BOB", "CARL", "DORA")]
    results = classify_many(db, config, embedder, llm, lines, state)
    assert [r.source for r in results] == ["llm", "llm", "llm", "none"]
    assert results[0].category == "Groceries"
    assert (results[1].category, results[1].cleaned_merchant) == ("Uncategorized", "Shop Bob")  # no category, no name
    assert (results[2].category, results[2].confidence) == ("Uncategorized", 0.3)  # unknown category, halved
    assert results[3].category == "Uncategorized" and state.bad_answers == 1
    assert state.llm_outage is None


@requires_db
def test_outage_trips_the_breaker_and_skips_the_batches_still_to_send(db, config, embedder, amex, amex_supp) -> None:
    llm = FakeLLMClient(unreachable=True)
    state = UploadState()
    names = [f"SHOP {i:b}".replace("0", "A").replace("1", "B") for i in range(60)]  # 60 distinct merchants
    lines = [(name, amex if i < 30 else amex_supp, None) for i, name in enumerate(names)]
    results = classify_many(db, config, embedder, llm, lines, state)
    assert all(r.source == "none" for r in results)
    assert state.llm_outage == "connection refused"
    assert state.outage_lines == 60
    # Up to BATCH_WORKERS batches may have been in flight when the first one failed; the rest never went.
    assert 1 <= len(llm.calls) <= guesser.BATCH_WORKERS


@requires_db
def test_batches_run_side_by_side_but_db_work_stays_in_the_caller(
    db, config, embedder, amex, amex_supp, monkeypatch
) -> None:
    monkeypatch.setattr(guesser, "BATCH_SIZE", 2)
    in_flight = 0
    peak = 0
    lock = threading.Lock()
    main_thread = threading.get_ident()
    threads: set[int] = set()

    def slow(system: str, user: str) -> dict:
        nonlocal in_flight, peak
        with lock:
            in_flight += 1
            peak = max(peak, in_flight)
            threads.add(threading.get_ident())
        time.sleep(0.05)
        with lock:
            in_flight -= 1
        return echo_llm(system, user)

    llm = FakeLLMClient(handler=slow)
    state = UploadState()
    names = ["ANNE", "BOB", "CARL", "DORA", "EVE", "FRED"]
    lines = [(f"SHOP {n}", amex, None) for n in names] + [(f"BAR {n}", amex_supp, None) for n in names[:4]]
    results = classify_many(db, config, embedder, llm, lines, state)
    assert len(llm.calls) == 5 and all(r.source == "llm" for r in results)
    assert 2 <= peak <= guesser.BATCH_WORKERS
    assert main_thread not in threads  # the HTTP calls ran on workers; this thread wrote the results
    assert len(state.memo) == 10


@requires_db
def test_prompt_lines_are_redacted_and_placeholders_echoed_back_are_dropped(db, config, embedder, amex) -> None:
    llm = FakeLLMClient(handler=lambda s, u: {"answers": [answer(1, merchant="Primary [name] Shop")]})
    state = UploadState()
    raw = "PAYPAL *PRIMARY USER 123456 someone@example.com"
    [result] = classify_many(db, config, embedder, llm, [(raw, amex, Decimal("-3.00"))], state)
    user = llm.calls[0]["user"]
    assert user.splitlines()[-1] == '1 | "PAYPAL *[name] [name] [number] [email]" | -3.00 GBP'
    assert "123456" not in user and "example.com" not in user
    assert result.cleaned_merchant == "Primary Shop"  # the model's echo of a placeholder is dropped
    assert result.source == "llm"


def test_few_shot_examples_are_redacted_too(config, amex) -> None:
    from app.services.memory import MemoryHit
    from app.services.redaction import Redactor

    hit = MemoryHit("PAYPAL PRIMARY USER", "Primary User", "Shopping", "personal", 0.7, 1)
    user = guesser.user_prompt([Pending("SOME SHOP", amex, None, [hit], None)], config, Redactor.from_config(config))
    assert '"PAYPAL [name] [name]" -> [name] [name] | Shopping' in user.splitlines()


@requires_db
def test_null_llm_leaves_lines_uncategorised_without_counting_an_outage(db, config, embedder, amex) -> None:
    from app.services.llm import NullLLMClient

    state = UploadState()
    results = classify_many(db, config, embedder, NullLLMClient(), [("NEW SHOP", amex, None)] * 2, state)
    assert [r.source for r in results] == ["none", "none"]
    assert state.outage_lines == 0 and state.llm_outage is None and state.llm_requests == 0
