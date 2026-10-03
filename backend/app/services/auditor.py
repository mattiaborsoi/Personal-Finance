"""Agent 3 - The Auditor (anomaly & trend analysis for a ledger period).

Step 1 (deterministic): for each recurring merchant (same ``cleaned_merchant`` present
in at least two of the previous ``auditor.lookback_periods`` periods) compute the
median of its prior per-period amounts and flag the current period when::

    |current - median_prior| / median_prior > auditor.deviation_threshold

Step 2 (LLM, optional): send only *aggregated* category totals (current period vs the
average of the previous periods that carried any spend) plus the statistical anomalies,
and ask for a single concise narrative sentence. The payload and the prompt state the
configured currency, and an answer quoting another currency is rejected. If the LLM is
unavailable, fails or answers off-contract a deterministic sentence is produced instead,
so the audit always succeeds.

The category baseline is averaged over the prior look-back periods that contain any
approved spend (``baseline_periods``), not over the whole window: a fresh install whose
statements start in May must not read April as a month of zero spend.

The result is persisted in ``audit_reports`` and returned as
:class:`app.schemas.AuditReportOut`.

"Spend" throughout this module means approved (``auto_approved`` or
``manual_approved``) transactions with a negative amount that are neither flagged as
internal transfers nor categorised under ``Transfers:``. Amounts are reported as
positive (absolute) values.
"""

from __future__ import annotations

import calendar
import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from statistics import median, pstdev

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import APPROVED_STATUSES, TRANSFER_CATEGORY_PREFIX, AppConfig
from app.models import AuditReport, Transaction
from app.schemas import AnomalyOut, AuditReportOut, CategoryComparisonOut
from app.services import ai_usage
from app.services.llm import LLMClient, LLMError
from app.services.periods import get_or_create_period, previous_period_key
from app.services.redaction import Redactor

log = logging.getLogger(__name__)

TWO_PLACES = Decimal("0.01")
ZERO = Decimal("0.00")

SYSTEM_PROMPT = (
    "You are a personal finance auditor. You receive aggregated spend figures for one "
    "ledger period compared with the average of the preceding periods that carried any "
    "spend (baseline_periods says how many; when it is 0 there is no history, so describe "
    "the period without comparing it), plus a list of recurring merchants whose charge "
    "deviated from their prior median. Write ONE concise, plain-English sentence (max 60 "
    "words) summarising how the period compares and calling out the most notable changes "
    "with their amounts. Do not invent figures. Respond with strictly this JSON object and "
    'nothing else: {"summary_sentence": "<sentence>"}'
)
"""Base narrative prompt; :func:`system_prompt` appends the configured currency."""
LLM_MAX_TOKENS = 300

CURRENCY_SYMBOLS: tuple[str, ...] = ("$", "€", "£", "¥")
CURRENCY_CODES: tuple[str, ...] = ("USD", "EUR", "GBP", "JPY")
"""Symbols and ISO codes an LLM answer is checked against (see :func:`foreign_currency_mentions`)."""


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _q2(value: Decimal) -> Decimal:
    """Quantise to two decimal places, rounding half up."""
    return value.quantize(TWO_PLACES, rounding=ROUND_HALF_UP)


def _money(config: AppConfig, value: Decimal) -> str:
    """Format an absolute amount with the configured currency symbol, e.g. ``£1,234.56``."""
    return f"{config.app.currency_symbol}{_q2(value):,.2f}"


def _pct(value: float) -> str:
    """Format a relative change as a signed percentage, e.g. ``+28.0%``."""
    return f"{value * 100:+.1f}%"


def _period_label(period_key: str) -> str:
    """Human-readable label for a period key, e.g. ``2026-08`` -> ``August 2026``."""
    year, month = int(period_key[:4]), int(period_key[5:7])
    return f"{calendar.month_name[month]} {year}"


def system_prompt(config: AppConfig) -> str:
    """:data:`SYSTEM_PROMPT` followed by the configured currency, so the model never guesses it."""
    return (
        f"{SYSTEM_PROMPT} All amounts are in {config.app.base_currency}; write them with the "
        f"{config.app.currency_symbol} symbol and never in another currency."
    )


def foreign_currency_mentions(config: AppConfig, text: str) -> list[str]:
    """Currency symbols and ISO codes in *text* other than the configured ones.

    Symbols are matched anywhere (``$212.00``); codes only as whole words, so ``EUR``
    is caught but ``Europe`` is not. A symbol that is part of the configured one (``$``
    in ``US$``) is not foreign.
    """
    own_symbol = config.app.currency_symbol
    own_code = config.app.base_currency.upper()
    found = [symbol for symbol in CURRENCY_SYMBOLS if symbol not in own_symbol and symbol in text]
    found += [
        code
        for code in CURRENCY_CODES
        if code != own_code and re.search(rf"\b{code}\b", text, flags=re.IGNORECASE) is not None
    ]
    return found


def prior_period_keys(config: AppConfig, period_key: str) -> list[str]:
    """The ``auditor.lookback_periods`` period keys immediately before *period_key*.

    Ordered most recent first, e.g. ``2026-08`` with a lookback of 3 gives
    ``["2026-07", "2026-06", "2026-05"]``. Raises ``ValueError`` for a malformed key.
    """
    return [previous_period_key(period_key, steps) for steps in range(1, config.auditor.lookback_periods + 1)]


def _spend_stmt(period_keys: list[str]):
    """Base ``select`` over spend transactions (see the module docstring) in *period_keys*."""
    return select(Transaction).where(
        Transaction.period_key.in_(period_keys),
        Transaction.review_status.in_(APPROVED_STATUSES),
        Transaction.is_internal_transfer.isnot(True),  # nullable column: NULL means "not a transfer"
        Transaction.is_split.isnot(True),  # a split parent's spend is carried by its parts
        Transaction.amount < 0,
        Transaction.category.not_like(f"{TRANSFER_CATEGORY_PREFIX}%"),
    )


# --------------------------------------------------------------------------- #
# Step 1 - statistical anomalies
# --------------------------------------------------------------------------- #


@dataclass
class _MerchantHistory:
    """Per-merchant spend gathered while scanning the current and prior periods."""

    per_period: dict[str, Decimal] = field(default_factory=dict)
    largest_current: Transaction | None = None

    def add(self, period_key: str, txn: Transaction, is_current: bool) -> None:
        self.per_period[period_key] = self.per_period.get(period_key, ZERO) + abs(txn.amount)
        if is_current and self._is_larger(txn):
            self.largest_current = txn

    def _is_larger(self, txn: Transaction) -> bool:
        """Deterministic "largest" ordering: absolute amount, then earliest date, then id."""
        cur = self.largest_current
        if cur is None:
            return True
        return (-abs(txn.amount), txn.transaction_date, str(txn.id)) < (
            -abs(cur.amount),
            cur.transaction_date,
            str(cur.id),
        )


def statistical_anomalies(db: Session, config: AppConfig, period_key: str) -> list[AnomalyOut]:
    """Flag recurring merchants whose current-period spend deviates from their prior median.

    Merchants are grouped by ``cleaned_merchant`` (case-insensitive, whitespace-trimmed)
    and totalled per period. A merchant is *recurring* when it has spend in at least two
    of the prior lookback periods (or in every one of them when the lookback is 1). The
    baseline is the median of the per-period totals of the prior periods in which the
    merchant appears; the deviation is the signed relative change of the current-period
    total against that baseline. Anomalies are returned sorted by absolute deviation,
    largest first, and point at the largest current-period transaction of the merchant.
    """
    priors = prior_period_keys(config, period_key)
    required_periods = min(2, len(priors))
    threshold = config.auditor.deviation_threshold

    histories: dict[str, _MerchantHistory] = {}
    for txn in db.scalars(_spend_stmt([period_key, *priors])):
        key = (txn.cleaned_merchant or "").strip().lower()
        if not key:
            continue
        histories.setdefault(key, _MerchantHistory()).add(txn.period_key, txn, txn.period_key == period_key)

    anomalies: list[AnomalyOut] = []
    for history in histories.values():
        current_txn = history.largest_current
        if current_txn is None:
            continue
        prior_totals = [history.per_period[p] for p in priors if p in history.per_period]
        if len(prior_totals) < required_periods:
            continue
        baseline = _q2(median(prior_totals))
        if baseline <= 0:
            continue
        # The median drives the flag; the (population) standard deviation is reported for context.
        stddev = _q2(Decimal(str(pstdev(prior_totals)))) if len(prior_totals) >= 2 else None
        current = _q2(history.per_period[period_key])
        deviation = float((current - baseline) / baseline)
        if abs(deviation) <= threshold:
            continue
        anomalies.append(
            AnomalyOut(
                transaction_id=current_txn.id,
                merchant=current_txn.cleaned_merchant,
                issue=(
                    f"Price deviation: {_money(config, current)} vs {len(priors)}-month median of "
                    f"{_money(config, baseline)} ({_pct(deviation)})"
                ),
                current_amount=current,
                baseline_amount=baseline,
                baseline_stddev=stddev,
                deviation=deviation,
            )
        )

    anomalies.sort(key=lambda a: (-abs(a.deviation or 0.0), a.merchant.lower()))
    return anomalies


# --------------------------------------------------------------------------- #
# Step 2a - category comparison (aggregates only)
# --------------------------------------------------------------------------- #


def category_comparison(db: Session, config: AppConfig, period_key: str) -> list[CategoryComparisonOut]:
    """Per-category spend for *period_key* against the average of the prior lookback periods.

    Only prior periods that contain any approved spend (in any category) count towards
    the baseline: ``baseline_periods`` is their number and ``baseline_average`` is the
    category's total prior spend divided by it. A category without spend in one of
    those periods still counts as zero for that period. When no prior period has data
    the baseline is ``0`` and ``baseline_periods`` is ``0``. ``change_pct`` is the
    percentage change against the baseline, or ``None`` when the baseline is zero.
    Categories with spend in either the current or a prior period are included, sorted
    by current spend descending (then by name).
    """
    priors = prior_period_keys(config, period_key)

    totals_stmt = (
        _spend_stmt([period_key, *priors])
        .with_only_columns(Transaction.category, Transaction.period_key, func.sum(Transaction.amount))
        .group_by(Transaction.category, Transaction.period_key)
    )
    current: dict[str, Decimal] = {}
    prior_sum: dict[str, Decimal] = {}
    priors_with_data: set[str] = set()
    for category, key, total in db.execute(totals_stmt):
        if key == period_key:
            current[category] = current.get(category, ZERO) + abs(Decimal(total))
        else:
            prior_sum[category] = prior_sum.get(category, ZERO) + abs(Decimal(total))
            priors_with_data.add(key)
    baseline_periods = len(priors_with_data)

    rows: list[CategoryComparisonOut] = []
    for category in set(current) | set(prior_sum):
        cur = _q2(current.get(category, ZERO))
        baseline = _q2(prior_sum.get(category, ZERO) / baseline_periods) if baseline_periods else ZERO
        change = float((cur - baseline) / baseline * 100) if baseline > 0 else None
        rows.append(
            CategoryComparisonOut(
                category=category,
                current=cur,
                baseline_average=baseline,
                change_pct=change,
                baseline_periods=baseline_periods,
            )
        )

    rows.sort(key=lambda r: (-r.current, r.category))
    return rows


def baseline_periods(comparison: list[CategoryComparisonOut]) -> int:
    """How many prior periods the comparison's baseline averages over (0 without history).

    Every row of one report carries the same count; reports stored before the field
    existed read as ``0``.
    """
    return max((r.baseline_periods for r in comparison), default=0)


def _baseline_label(lookback: int, periods_with_data: int) -> str:
    """What the total is compared against, e.g. ``the 3-month average``."""
    if periods_with_data == lookback:
        return f"the {lookback}-month average"
    if periods_with_data == 1:
        return "the only previous month with data"
    return f"the average of the previous {periods_with_data} months with data"


# --------------------------------------------------------------------------- #
# Step 2b - narrative
# --------------------------------------------------------------------------- #


def deterministic_summary(
    config: AppConfig,
    period_key: str,
    comparison: list[CategoryComparisonOut],
    anomalies: list[AnomalyOut],
) -> str:
    """Narrative sentence built without an LLM, e.g.::

        August 2026 spend was £1,234.56, up 14.0% on the 3-month average; 1 recurring
        bill deviated: Northwind Energy £87.27 vs £68.20 (+28.0%).

    When fewer than ``lookback_periods`` prior months carried spend the comparison says
    so: ``up 1.5% on the average of the previous 2 months with data``.
    """
    label = _period_label(period_key)
    lookback = config.auditor.lookback_periods
    if not comparison and not anomalies:
        return f"{label} has no approved spend to audit."

    total_current = sum((r.current for r in comparison), ZERO)
    total_baseline = sum((r.baseline_average for r in comparison), ZERO)
    head = f"{label} spend was {_money(config, total_current)}"
    if total_baseline > 0:
        against = _baseline_label(lookback, baseline_periods(comparison))
        change = float((total_current - total_baseline) / total_baseline)
        if abs(change) < 0.0005:
            head += f", in line with {against}"
        else:
            direction = "up" if change > 0 else "down"
            head += f", {direction} {abs(change) * 100:.1f}% on {against}"
    else:
        head += f", with no spend in the previous {lookback} months to compare against"

    if not anomalies:
        return f"{head}; no recurring bills deviated from their {lookback}-month median."
    noun = "bill" if len(anomalies) == 1 else "bills"
    details = ", ".join(
        f"{a.merchant} {_money(config, a.current_amount or ZERO)} vs {_money(config, a.baseline_amount or ZERO)} "
        f"({_pct(a.deviation or 0.0)})"
        for a in anomalies
    )
    return f"{head}; {len(anomalies)} recurring {noun} deviated: {details}."


def _llm_payload(
    config: AppConfig,
    period_key: str,
    comparison: list[CategoryComparisonOut],
    anomalies: list[AnomalyOut],
) -> str:
    """Compact JSON for the narrative prompt: aggregates and anomalies only, never line items.

    States the currency and how many prior periods the baseline averages over
    (``baseline_periods``, 0 when there is nothing to compare against). Merchant
    names go through the redactor (a merchant can be a person: a transfer to a
    landlord by name), category names are the taxonomy's own.
    """
    redactor = Redactor.from_config(config)
    payload = {
        "period_key": period_key,
        "currency": {"code": config.app.base_currency, "symbol": config.app.currency_symbol},
        "lookback_periods": config.auditor.lookback_periods,
        "baseline_periods": baseline_periods(comparison),
        "total_current_spend": str(sum((r.current for r in comparison), ZERO)),
        "total_baseline_average": str(sum((r.baseline_average for r in comparison), ZERO)),
        "categories": [
            {
                "category": r.category,
                "current": str(r.current),
                "baseline_average": str(r.baseline_average),
                "change_pct": None if r.change_pct is None else round(r.change_pct, 1),
            }
            for r in comparison
        ],
        "anomalies": [
            {
                "merchant": redactor.redact(a.merchant),
                "current": str(a.current_amount),
                "baseline": str(a.baseline_amount),
                "deviation": None if a.deviation is None else round(a.deviation, 4),
            }
            for a in anomalies
        ],
    }
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


def _llm_summary(
    llm: LLMClient,
    config: AppConfig,
    period_key: str,
    comparison: list[CategoryComparisonOut],
    anomalies: list[AnomalyOut],
) -> str | None:
    """Ask the LLM for the narrative; ``None`` when unavailable, failing or off-contract.

    An answer that quotes a currency other than the configured one (``$212.00`` on a
    GBP ledger) is off-contract: the caller falls back to :func:`deterministic_summary`.
    """
    if not llm.available:
        return None
    try:
        result = llm.complete_json(
            system=system_prompt(config),
            user=_llm_payload(config, period_key, comparison, anomalies),
            max_tokens=LLM_MAX_TOKENS,
        )
    except LLMError as exc:
        log.warning("audit narrative for %s fell back to the deterministic summary: %s", period_key, exc)
        return None
    sentence = result.get("summary_sentence")
    if not isinstance(sentence, str) or not sentence.strip():
        log.warning("audit narrative for %s: LLM response lacked summary_sentence", period_key)
        return None
    sentence = sentence.strip()
    foreign = foreign_currency_mentions(config, sentence)
    if foreign:
        log.warning(
            "audit narrative for %s fell back to the deterministic summary: the LLM quoted %s on a %s ledger",
            period_key,
            ", ".join(foreign),
            config.app.base_currency,
        )
        return None
    return sentence


# --------------------------------------------------------------------------- #
# Orchestration & persistence
# --------------------------------------------------------------------------- #


def _to_out(row: AuditReport) -> AuditReportOut:
    return AuditReportOut(
        period_key=row.period_key or "",
        summary_sentence=row.summary_sentence,
        anomalies=row.anomalies or [],
        category_comparison=row.category_comparison or [],
        created_at=row.created_at,
    )


def run_audit(db: Session, config: AppConfig, llm: LLMClient, period_key: str) -> AuditReportOut:
    """Run both steps, persist an ``AuditReport`` row and return it.

    The ledger period is created if missing (the report references it). The audit is
    read-only with respect to transactions and may be re-run at any time, including on
    a closed period; each run adds a new report row. The session is flushed, not
    committed.
    """
    get_or_create_period(db, period_key)
    anomalies = statistical_anomalies(db, config, period_key)
    comparison = category_comparison(db, config, period_key)
    summary = _llm_summary(llm, config, period_key, comparison, anomalies)
    if summary is None:
        summary = deterministic_summary(config, period_key, comparison, anomalies)

    ai_usage.flush(db)
    row = AuditReport(
        id=uuid.uuid4(),
        period_key=period_key,
        summary_sentence=summary,
        anomalies=[a.model_dump(mode="json") for a in anomalies],
        category_comparison=[c.model_dump(mode="json") for c in comparison],
        created_at=datetime.now(UTC),
    )
    db.add(row)
    db.flush()
    return _to_out(row)


def latest_report(db: Session, period_key: str) -> AuditReportOut | None:
    """The most recently created report for *period_key*, or ``None`` if never audited."""
    stmt = (
        select(AuditReport)
        .where(AuditReport.period_key == period_key)
        .order_by(AuditReport.created_at.desc(), AuditReport.id)
        .limit(1)
    )
    row = db.scalars(stmt).first()
    return None if row is None else _to_out(row)


__all__ = [
    "SYSTEM_PROMPT",
    "baseline_periods",
    "category_comparison",
    "deterministic_summary",
    "foreign_currency_mentions",
    "latest_report",
    "prior_period_keys",
    "run_audit",
    "statistical_anomalies",
    "system_prompt",
]
