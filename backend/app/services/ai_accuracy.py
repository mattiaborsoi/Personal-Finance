"""How the AI is doing: was its suggestion approved unchanged?

Ingestion keeps the model's answer on the row (``suggested_category`` and
``suggested_claim_type``, only when a model classified the line). Every approval,
by hand, in a batch or through "approve known merchants", then records whether the
approved category and claim type are the ones suggested
(:func:`record_approval`). :func:`stats` turns that into the acceptance rate over
the last :data:`WINDOW_DAYS` days and how many lines a model classified, for the
"How the AI is doing" block under Settings -> AI, next to this month's usage
(``app.services.ai_usage``).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import APPROVED_STATUSES
from app.models import Transaction
from app.services import ai_usage

WINDOW_DAYS = 90


def record_approval(txn: Transaction) -> None:
    """Set ``suggestion_accepted`` from the row's live fields; a no-op without a suggestion."""
    if txn.suggested_category is None:
        return
    txn.suggestion_accepted = (
        txn.category == txn.suggested_category and txn.claim_type == (txn.suggested_claim_type or txn.claim_type)
    )


@dataclass(slots=True)
class JobUsageOut:
    job: str
    requests: int
    failures: int
    prompt_tokens: int
    completion_tokens: int


@dataclass(slots=True)
class Stats:
    window_days: int
    classified: int
    """Lines a model classified in the window (by ingestion date)."""
    approved: int
    """Of those, lines approved so far."""
    accepted: int
    """Of those, approved with the suggested category and claim type unchanged."""
    acceptance_rate: float | None
    month: str
    usage: list[JobUsageOut]


def stats(db: Session, *, now: datetime | None = None) -> Stats:
    now = now or datetime.now(UTC)
    since = now - timedelta(days=WINDOW_DAYS)
    suggested = Transaction.suggested_category.is_not(None)
    recent = Transaction.created_at >= since
    classified = int(db.scalar(select(func.count()).where(suggested, recent)) or 0)
    approved = int(
        db.scalar(select(func.count()).where(suggested, recent, Transaction.review_status.in_(APPROVED_STATUSES))) or 0
    )
    accepted = int(
        db.scalar(
            select(func.count()).where(
                suggested,
                recent,
                Transaction.review_status.in_(APPROVED_STATUSES),
                Transaction.suggestion_accepted.is_(True),
            )
        )
        or 0
    )
    month = ai_usage.current_month()
    usage = [
        JobUsageOut(
            job=item.job,
            requests=item.counts.requests,
            failures=item.counts.failures,
            prompt_tokens=item.counts.prompt_tokens,
            completion_tokens=item.counts.completion_tokens,
        )
        for item in ai_usage.usage_for_month(db, month)
    ]
    return Stats(
        window_days=WINDOW_DAYS,
        classified=classified,
        approved=approved,
        accepted=accepted,
        acceptance_rate=round(accepted / approved, 4) if approved else None,
        month=month,
        usage=usage,
    )
