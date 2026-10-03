"""Plain-English questions answered at home.

The model never sees the ledger. It receives the question (with the two household
members' names swapped for their roles, and the usual redaction applied) plus a
description of what can be asked: the category names, the account ids with their
institution and type, the claim types and the two roles. It must answer with a
:class:`QuerySpec` in a strict JSON schema, or say that the question cannot be
expressed. The spec is validated here against the configuration and run locally
with SQL; the answer, the filters as interpreted ("Showing: Travel, Jan to Sep
2026, approved and pending") and the closest Transactions view go back to the
owner. Nothing about amounts, merchants or lines ever leaves.

Two kinds of question:

* ``spend``: a metric (``sum``, ``count``, ``average`` or ``list``) over the
  transactions matching the filters (dates or months, categories or category
  groups, a merchant text, accounts, claim types, people, direction, status),
  optionally grouped by month, category, merchant or account;
* ``settlement``: what one person owed the other for a month, from the settlement
  the app already computes (``app.services.settlement``).
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Literal
from urllib.parse import urlencode

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import APPROVED_STATUSES, CLAIM_TYPES, TRANSFER_CATEGORY_PREFIX, AppConfig, category_group
from app.models import Transaction
from app.services import ai_usage, settlement
from app.services.llm import LLMClient
from app.services.periods import PERIOD_KEY_RE, period_bounds
from app.services.redaction import Redactor

MAX_QUESTION_LENGTH = 300
ASK_MAX_TOKENS = 400
LIST_LIMIT = 50
GROUP_LIMIT = 50

Metric = Literal["sum", "count", "average", "list"]
GroupBy = Literal["month", "category", "merchant", "account"]
Direction = Literal["out", "in", "any"]
Status = Literal["approved", "pending", "all"]
Person = Literal["primary", "secondary"]


class QuerySpec(BaseModel):
    """The strict schema the model must answer with (and the API returns, validated)."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["spend", "settlement"] = "spend"
    metric: Metric = "sum"
    date_from: date | None = None
    date_to: date | None = None
    months: list[str] = Field(default_factory=list, max_length=36)
    """``YYYY-MM`` keys; an alternative to the date range."""
    categories: list[str] = Field(default_factory=list, max_length=20)
    """Category names, or group names (``Travel`` covers ``Travel:*``), matched ignoring case."""
    merchant_text: str | None = Field(default=None, max_length=80)
    accounts: list[str] = Field(default_factory=list, max_length=10)
    """Account ids, or an institution or account type as listed in the capabilities."""
    claim_types: list[str] = Field(default_factory=list, max_length=5)
    people: list[Person] = Field(default_factory=list, max_length=2)
    """Whose accounts: the primary's, the secondary's, or both."""
    direction: Direction = "out"
    status: Status = "all"
    group_by: GroupBy | None = None
    settlement_period: str | None = None
    """``YYYY-MM`` for a settlement question."""


class CannotAnswer(ValueError):
    """The question cannot be expressed as a query (the model said so, or its answer was unusable)."""


@dataclass(slots=True)
class AskResult:
    answer: str
    interpreted: str
    query: QuerySpec
    link: str | None
    value: Decimal | None = None
    count: int = 0
    rows: list[dict[str, Any]] = field(default_factory=list)
    """Grouped totals (``{label, amount, count}``) or listed lines (``{date, merchant, amount, category}``)."""


# --------------------------------------------------------------------------- #
# The prompt
# --------------------------------------------------------------------------- #

SYSTEM_PROMPT_HEAD = """\
You turn a question about a two-person household's ledger into a query. You never see the ledger: only
the question and the query capabilities below. Respond with a single JSON object and nothing else.

Either {"query": {...}} with a query of exactly this shape (omit fields you do not need; defaults apply):
{"kind": "spend" | "settlement",
 "metric": "sum" | "count" | "average" | "list",
 "date_from": "YYYY-MM-DD", "date_to": "YYYY-MM-DD",
 "months": ["YYYY-MM", ...],
 "categories": [<category or group name>, ...],
 "merchant_text": "<text to search merchant names for>",
 "accounts": [<account id, institution or account type>, ...],
 "claim_types": [<claim type>, ...],
 "people": ["primary" | "secondary", ...],
 "direction": "out" | "in" | "any",
 "status": "approved" | "pending" | "all",
 "group_by": "month" | "category" | "merchant" | "account",
 "settlement_period": "YYYY-MM"}
or {"cannot": "<one short sentence saying why the question cannot be expressed>"}.

Rules:
- "spend" questions total (sum, the default), count, average or list the matching transactions; "direction"
  is money out by default (spending), "in" for income and refunds, "any" for both. "status" is "all"
  (approved and pending) unless the question says approved only or pending only.
- Use "months" for whole months and "date_from"/"date_to" for other ranges; "this year" is 1 January of the
  current year to today; a month without a year is the most recent one of that name not after today.
- "categories" takes names from the list below or a group name (the part before the colon) to cover a
  whole group. Never invent a category; if none fits, leave it out and use "merchant_text" for a shop
  or brand named in the question.
- "people" selects whose accounts: the asker is the primary user ("I", "me", "my"), the other person is
  the secondary user; use the role words, never a name.
- "settlement" questions ("what did the secondary user owe me for August") set kind "settlement" and
  "settlement_period"; the app computes the balance itself.
- Group ("group_by") only when the question asks for a breakdown (per month, by category, by merchant,
  by account). Use "list" only when the question asks to see the transactions themselves.
"""


def capabilities(config: AppConfig, today: date) -> str:
    accounts = "\n".join(
        f"- {a.id}: {a.institution} {a.account_type} ({'primary' if config.is_primary(a.owner) else 'secondary'} user)"
        for a in config.accounts
        if a.is_active
    )
    groups = sorted({category_group(c) for c in config.categories})
    return "\n".join(
        [
            f"Today is {today.isoformat()}.",
            "Categories:",
            ", ".join(config.categories),
            "Category groups:",
            ", ".join(groups),
            "Accounts:",
            accounts or "- none",
            "Claim types:",
            ", ".join(CLAIM_TYPES),
        ]
    )


def anonymise_question(question: str, config: AppConfig, redactor: Redactor) -> str:
    """The question with each person's name replaced by their role, then redacted.

    Names are swapped for letter-free sentinels first and spelt out as "the primary
    user" only after redaction, so neither the redactor nor a second name word can
    touch the role phrase (a household whose names are "Primary User" included).
    """
    text = " ".join((question or "").split())[:MAX_QUESTION_LENGTH]
    roles: dict[str, str] = {}
    for role, user in (("primary", config.users.primary), ("secondary", config.users.secondary)):
        for word in re.split(r"\s+", user.display_name.strip()):
            if len(word) >= 2:
                roles.setdefault(word.lower(), role)
    if roles:
        names = "|".join(re.escape(w) for w in sorted(roles, key=len, reverse=True))
        sentinel = {"primary": "\x00\x01", "secondary": "\x00\x02"}

        def swap(m: re.Match[str]) -> str:
            return sentinel[roles[m.group(1).lower()]]

        text = re.sub(rf"(?<![A-Za-z])({names})(?:'s)?(?![A-Za-z])", swap, text, flags=re.I)
        # Two name words in a row ("Primary User") are one person.
        text = re.sub(r"(\x00[\x01\x02])(?:\s+\1)+", r"\1", text)
    text = redactor.redact(text)
    return text.replace("\x00\x01", "the primary user").replace("\x00\x02", "the secondary user")


def interpret(llm: LLMClient, config: AppConfig, question: str, *, today: date | None = None) -> QuerySpec:
    """Ask the model for the query; raises :class:`CannotAnswer` or :class:`LLMError`."""
    today = today or date.today()
    asked = anonymise_question(question, config, Redactor.from_config(config))
    if not asked:
        raise CannotAnswer("Type a question first.")
    system = SYSTEM_PROMPT_HEAD + "\n" + capabilities(config, today)
    payload = llm.complete_json(system=system, user=f"Question: {asked}", max_tokens=ASK_MAX_TOKENS)
    return parse_answer(payload, config)


def parse_answer(payload: Any, config: AppConfig) -> QuerySpec:
    """Validate the model's answer against the schema and the configuration."""
    if not isinstance(payload, dict):
        raise CannotAnswer("The AI did not answer with a query.")
    if payload.get("cannot"):
        raise CannotAnswer(str(payload["cannot"])[:200])
    raw = payload.get("query", payload)
    if not isinstance(raw, dict):
        raise CannotAnswer("The AI did not answer with a query.")
    try:
        spec = QuerySpec.model_validate({k: v for k, v in raw.items() if v is not None})
    except ValidationError as exc:
        raise CannotAnswer(f"The AI's query was not valid: {exc.errors()[0].get('msg', 'bad value')}.") from exc
    return check(spec, config)


def check(spec: QuerySpec, config: AppConfig) -> QuerySpec:
    """Canonicalise names against the configuration; raises :class:`CannotAnswer` for unknown ones."""
    categories: list[str] = []
    groups = {category_group(c).lower(): category_group(c) for c in config.categories}
    for name in spec.categories:
        canonical = config.canonical_category(name)
        if canonical is not None:
            categories.append(canonical)
        elif name.strip().lower() in groups:
            categories.append(groups[name.strip().lower()])
        else:
            raise CannotAnswer(f"There is no category called {name.strip()!r}.")
    accounts: list[str] = []
    for token in spec.accounts:
        wanted = token.strip().lower()
        hits = [
            a.id
            for a in config.accounts
            if wanted in (a.id.lower(), a.institution.lower(), a.account_type.lower(), (a.label or "").lower())
        ]
        if not hits:
            raise CannotAnswer(f"There is no account called {token.strip()!r}.")
        accounts.extend(h for h in hits if h not in accounts)
    for ct in spec.claim_types:
        if ct not in CLAIM_TYPES:
            raise CannotAnswer(f"There is no claim type called {ct!r}.")
    for month in spec.months + ([spec.settlement_period] if spec.settlement_period else []):
        if not PERIOD_KEY_RE.match(month or ""):
            raise CannotAnswer(f"{month!r} is not a month (YYYY-MM).")
    if spec.date_from and spec.date_to and spec.date_from > spec.date_to:
        raise CannotAnswer("The date range ends before it starts.")
    if spec.kind == "settlement" and not spec.settlement_period:
        raise CannotAnswer("A settlement question needs a month.")
    return spec.model_copy(update={"categories": categories, "accounts": accounts})


# --------------------------------------------------------------------------- #
# Running the query
# --------------------------------------------------------------------------- #


def _date_range(spec: QuerySpec) -> tuple[date | None, date | None]:
    if spec.months:
        bounds = [period_bounds(m) for m in sorted(spec.months)]
        return bounds[0][0], bounds[-1][1]
    return spec.date_from, spec.date_to


def _conditions(spec: QuerySpec, config: AppConfig) -> list:
    conds = [Transaction.is_split.is_(False), Transaction.is_internal_transfer.isnot(True)]
    low, high = _date_range(spec)
    if spec.months:
        conds.append(Transaction.period_key.in_(spec.months))
    else:
        if low:
            conds.append(Transaction.transaction_date >= low)
        if high:
            conds.append(Transaction.transaction_date <= high)
    if spec.categories:
        # A bare name ("Travel") covers the category of that name and its group ("Travel:*");
        # "Group:Name" is exact.
        parts = []
        for name in spec.categories:
            parts.append(Transaction.category == name)
            if ":" not in name:
                parts.append(Transaction.category.like(f"{name}:%"))
        conds.append(_any(parts))
    else:
        conds.append(Transaction.category.not_like(f"{TRANSFER_CATEGORY_PREFIX}%"))
    if spec.merchant_text:
        pattern = f"%{spec.merchant_text.strip().replace('%', '').replace('_', '')}%"
        conds.append(
            _any([Transaction.cleaned_merchant.ilike(pattern), Transaction.raw_description.ilike(pattern)])
        )
    if spec.accounts:
        conds.append(Transaction.account_id.in_(spec.accounts))
    if spec.people:
        owned = [
            a.id for a in config.accounts if ("primary" if config.is_primary(a.owner) else "secondary") in spec.people
        ]
        conds.append(Transaction.account_id.in_(owned) if owned else Transaction.account_id.is_(None))
    if spec.claim_types:
        conds.append(Transaction.claim_type.in_(spec.claim_types))
    if spec.direction == "out":
        conds.append(Transaction.amount < 0)
    elif spec.direction == "in":
        conds.append(Transaction.amount > 0)
    if spec.status == "approved":
        conds.append(Transaction.review_status.in_(APPROVED_STATUSES))
    elif spec.status == "pending":
        conds.append(Transaction.review_status == "pending_review")
    return conds


def _any(parts: list):
    from sqlalchemy import or_

    return or_(*parts) if len(parts) > 1 else parts[0]


def _signed(spec: QuerySpec, value: Decimal) -> Decimal:
    """Spending reads as a positive figure; money in stays positive; mixed keeps the ledger sign."""
    value = Decimal(value or 0).quantize(Decimal("0.01"))
    return -value if spec.direction == "out" else value


def run(db: Session, config: AppConfig, spec: QuerySpec) -> AskResult:
    if spec.kind == "settlement":
        return _settlement(db, config, spec)
    conds = _conditions(spec, config)
    interpreted = describe_filters(spec, config)
    link = transactions_link(spec, config.categories)
    if spec.metric == "list":
        rows = db.execute(
            select(Transaction)
            .where(*conds)
            .order_by(Transaction.transaction_date.desc(), Transaction.created_at.desc())
            .limit(LIST_LIMIT)
        ).scalars().all()
        total = int(db.scalar(select(func.count()).where(*conds)) or 0)
        listed = [
            {
                "date": t.transaction_date.isoformat(),
                "merchant": t.cleaned_merchant,
                "amount": str(t.amount),
                "category": t.category,
                "account_id": t.account_id,
            }
            for t in rows
        ]
        shown = f"the first {LIST_LIMIT} of them" if total > LIST_LIMIT else "them"
        return AskResult(
            answer=f"{_plural(total, 'transaction')} match; here {'are' if total != 1 else 'is'} {shown}.",
            interpreted=interpreted,
            query=spec,
            link=link,
            count=total,
            rows=listed,
        )
    if spec.group_by:
        key_expr = {
            "month": Transaction.period_key,
            "category": Transaction.category,
            "merchant": Transaction.cleaned_merchant,
            "account": Transaction.account_id,
        }[spec.group_by]
        grouped = db.execute(
            select(key_expr, func.sum(Transaction.amount), func.count())
            .where(*conds)
            .group_by(key_expr)
            .order_by(func.sum(Transaction.amount) if spec.direction == "out" else func.sum(Transaction.amount).desc())
            .limit(GROUP_LIMIT)
        ).all()
        rows = [
            {"label": label or "", "amount": str(_metric_value(spec, Decimal(total or 0), int(count))), "count": count}
            for label, total, count in ((label, total, int(count)) for label, total, count in grouped)
        ]
        if spec.group_by == "month":
            rows.sort(key=lambda r: r["label"])
        total_value = sum((Decimal(r["amount"]) for r in rows), Decimal(0)) if spec.metric != "average" else None
        noun = "categories" if spec.group_by == "category" else f"{spec.group_by}s"
        answer = f"{len(rows)} {noun if len(rows) != 1 else spec.group_by}"
        if total_value is not None:
            answer += f", {_metric_word(spec)} {_money(config, total_value)} in all"
        return AskResult(
            answer=answer + ".", interpreted=interpreted, query=spec, link=link, value=total_value, rows=rows
        )
    total, count = db.execute(select(func.sum(Transaction.amount), func.count()).where(*conds)).one()
    count = int(count or 0)
    value = _metric_value(spec, Decimal(total or 0), count)
    if spec.metric == "count":
        answer = f"{_plural(count, 'transaction')}."
    elif count == 0:
        answer = "Nothing matches."
    elif spec.metric == "average":
        answer = f"{_money(config, value)} on average over {_plural(count, 'transaction')}."
    else:
        answer = f"{_money(config, value)} over {_plural(count, 'transaction')}."
    return AskResult(answer=answer, interpreted=interpreted, query=spec, link=link, value=value, count=count)


def _metric_value(spec: QuerySpec, total: Decimal, count: int) -> Decimal:
    if spec.metric == "count":
        return Decimal(count)
    value = _signed(spec, total)
    if spec.metric == "average":
        return (value / count).quantize(Decimal("0.01")) if count else Decimal("0.00")
    return value


def _metric_word(spec: QuerySpec) -> str:
    return {"sum": "totalling", "count": "counting", "average": "averaging", "list": "listing"}[spec.metric]


def _money(config: AppConfig, value: Decimal) -> str:
    sign = "-" if value < 0 else ""
    return f"{sign}{config.app.currency_symbol}{abs(value):,.2f}"


def _settlement(db: Session, config: AppConfig, spec: QuerySpec) -> AskResult:
    period = spec.settlement_period or ""
    summary = settlement.compute_settlement(db, period, config)
    net = Decimal(summary.net_owed_by_secondary)
    primary, secondary = config.users.primary.display_name, config.users.secondary.display_name
    label = _month_label(period)
    if net > 0:
        answer = f"{secondary} owed {primary} {_money(config, net)} for {label}."
    elif net < 0:
        answer = f"{primary} owed {secondary} {_money(config, -net)} for {label}."
    else:
        answer = f"Nothing was owed either way for {label}."
    if summary.pending_review_count:
        answer += f" {_plural(summary.pending_review_count, 'line')} still waiting for review may change it."
    return AskResult(
        answer=answer,
        interpreted=f"Settlement for {label}",
        query=spec,
        link=f"/?period={period}",
        value=net,
    )


# --------------------------------------------------------------------------- #
# Wording and links
# --------------------------------------------------------------------------- #


def _month_label(period: str) -> str:
    year, month = int(period[:4]), int(period[5:7])
    return f"{calendar.month_name[month]} {year}"


def _short(period: str) -> str:
    return f"{calendar.month_abbr[int(period[5:7])]} {period[:4]}"


def describe_filters(spec: QuerySpec, config: AppConfig) -> str:
    """``Showing: Travel, Jan to Sep 2026, approved and pending``."""
    parts: list[str] = []
    if spec.categories:
        parts.append(", ".join(spec.categories))
    if spec.merchant_text:
        parts.append(f"merchants matching '{spec.merchant_text.strip()}'")
    if spec.months:
        months = sorted(spec.months)
        parts.append(_short(months[0]) if len(months) == 1 else f"{_short(months[0])} to {_short(months[-1])}")
    elif spec.date_from or spec.date_to:
        start = spec.date_from.isoformat() if spec.date_from else "the start"
        end = spec.date_to.isoformat() if spec.date_to else "today"
        parts.append(f"{start} to {end}")
    else:
        parts.append("all time")
    if spec.accounts:
        parts.append(", ".join(_account_name(config, a) for a in spec.accounts))
    if spec.people:
        names = {"primary": config.users.primary.display_name, "secondary": config.users.secondary.display_name}
        parts.append(" and ".join(f"{names[p]}'s accounts" for p in spec.people))
    if spec.claim_types:
        parts.append(", ".join(ct.replace("_", " ") for ct in spec.claim_types))
    parts.append({"out": "money out", "in": "money in", "any": "money in and out"}[spec.direction])
    parts.append({"all": "approved and pending", "approved": "approved only", "pending": "pending only"}[spec.status])
    if spec.group_by:
        parts.append(f"by {spec.group_by}")
    return "Showing: " + ", ".join(parts)


def _account_name(config: AppConfig, account_id: str) -> str:
    account = config.get_account(account_id)
    return account.label or f"{account.institution} {account.account_type}" if account else account_id


def transactions_link(spec: QuerySpec, categories: list[str] | None = None) -> str:
    """The closest Transactions view (its filters take one period, one exact category, one account)."""
    filterable = set(categories or [])
    params: dict[str, str] = {}
    if len(spec.months) == 1:
        params["period"] = spec.months[0]
    elif not spec.months and spec.date_from and spec.date_to:
        if spec.date_from.strftime("%Y-%m") == spec.date_to.strftime("%Y-%m"):
            params["period"] = spec.date_from.strftime("%Y-%m")
    if len(spec.categories) == 1 and (not filterable or spec.categories[0] in filterable):
        params["category"] = spec.categories[0]
    if len(spec.accounts) == 1:
        params["account_id"] = spec.accounts[0]
    if spec.merchant_text:
        params["q"] = spec.merchant_text.strip()
    if spec.status == "pending":
        params["status"] = "pending_review"
    params["include_transfers"] = "false"
    return "/transactions?" + urlencode(params)


def ask(db: Session, config: AppConfig, llm: LLMClient, question: str, *, today: date | None = None) -> AskResult:
    """Interpret and run ``question``; raises :class:`CannotAnswer` or :class:`LLMError`."""
    try:
        spec = interpret(llm, config, question, today=today)
    finally:
        ai_usage.flush(db)
    return run(db, config, spec)


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'s' if n != 1 else ''}"
