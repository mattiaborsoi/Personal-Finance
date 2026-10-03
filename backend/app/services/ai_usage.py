"""AI usage counters: requests, failures and tokens per job per month. Never prompts.

:class:`LiteLLMClient` calls :func:`record` after every completion with the ``usage``
object the proxy returned (when it returns one) and :func:`record_failure` when a
call fails. The counts accumulate in memory, under a lock, and :func:`flush` adds
them to the ``ai_usage`` table whenever a request that holds a database session
finishes an AI job (an upload, an audit, a question). Nothing about the content of
a call is kept: only how many were made and how many tokens the proxy said they cost.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AiUsage

JOBS: tuple[str, ...] = ("chat", "extraction", "audit", "ask", "layout")


@dataclass(slots=True)
class Counts:
    requests: int = 0
    failures: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0

    def add(self, other: Counts) -> None:
        self.requests += other.requests
        self.failures += other.failures
        self.prompt_tokens += other.prompt_tokens
        self.completion_tokens += other.completion_tokens

    @property
    def empty(self) -> bool:
        return not (self.requests or self.failures or self.prompt_tokens or self.completion_tokens)


@dataclass(slots=True)
class Tally:
    """Thread-safe accumulator keyed by ``(month, job)``."""

    _counts: dict[tuple[str, str], Counts] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def record(self, job: str, usage: dict | None, *, failed: bool = False, month: str | None = None) -> None:
        key = (month or current_month(), job[:16] or "chat")
        prompt = _count(usage, "prompt_tokens")
        completion = _count(usage, "completion_tokens")
        with self._lock:
            counts = self._counts.setdefault(key, Counts())
            counts.requests += 1
            counts.failures += int(failed)
            counts.prompt_tokens += prompt
            counts.completion_tokens += completion

    def drain(self) -> dict[tuple[str, str], Counts]:
        with self._lock:
            out, self._counts = self._counts, {}
        return out

    def merge(self, counts: dict[tuple[str, str], Counts]) -> None:
        with self._lock:
            for key, value in counts.items():
                self._counts.setdefault(key, Counts()).add(value)

    def peek(self) -> dict[tuple[str, str], Counts]:
        with self._lock:
            return {
                k: Counts(v.requests, v.failures, v.prompt_tokens, v.completion_tokens) for k, v in self._counts.items()
            }


def _count(usage: dict | None, key: str) -> int:
    if not isinstance(usage, dict):
        return 0
    value = usage.get(key)
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def current_month() -> str:
    return datetime.now(UTC).strftime("%Y-%m")


tally = Tally()


def record(job: str, usage: dict | None) -> None:
    tally.record(job, usage)


def record_failure(job: str) -> None:
    tally.record(job, None, failed=True)


def flush(db: Session) -> None:
    """Add the accumulated counts to ``ai_usage`` (flushed, not committed; the caller commits)."""
    pending = tally.drain()
    if not pending:
        return
    try:
        for (month, job), counts in pending.items():
            row = db.get(AiUsage, (month, job))
            if row is None:
                row = AiUsage(month=month, job=job)
                db.add(row)
            row.requests = (row.requests or 0) + counts.requests
            row.failures = (row.failures or 0) + counts.failures
            row.prompt_tokens = (row.prompt_tokens or 0) + counts.prompt_tokens
            row.completion_tokens = (row.completion_tokens or 0) + counts.completion_tokens
        db.flush()
    except Exception:
        tally.merge(pending)  # a failed write (a closed session) loses nothing
        raise


@dataclass(slots=True)
class JobUsage:
    job: str
    counts: Counts


def usage_for_month(db: Session, month: str | None = None) -> list[JobUsage]:
    """The stored counts for ``month`` (default: this month) plus whatever is not flushed yet."""
    month = month or current_month()
    totals: dict[str, Counts] = {}
    for row in db.scalars(select(AiUsage).where(AiUsage.month == month)):
        totals[row.job] = Counts(
            row.requests or 0, row.failures or 0, row.prompt_tokens or 0, row.completion_tokens or 0
        )
    for (m, job), counts in tally.peek().items():
        if m == month:
            totals.setdefault(job, Counts()).add(counts)
    order = {job: i for i, job in enumerate(JOBS)}
    return [
        JobUsage(job=job, counts=counts)
        for job, counts in sorted(totals.items(), key=lambda kv: (order.get(kv[0], len(JOBS)), kv[0]))
        if not counts.empty
    ]
