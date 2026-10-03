"""Rule suggestions worked out from approvals, without AI (Settings -> Rules).

Three kinds, each built from approved lines (``manual_approved`` or
``auto_approved``) that are neither internal transfers nor split parents, filed
under a category other than ``Uncategorized``, grouped by merchant key
(``memory.merchant_key`` of the raw description: the first words before any store
number):

``fixed_amount``
    the same merchant at the same exact amount filed the same way at least
    :data:`FIXED_AMOUNT_MIN` times, with no rule matching those lines: "Third Space,
    £40.00, always Health:Gym". The proposed rule carries ``amount_min`` and
    ``amount_max`` equal to that amount.
``always_same``
    a merchant filed one way at least :data:`ALWAYS_MIN` times, every time, with no
    rule matching: the proposed rule has no amount range.
``override``
    an existing rule matched the raw description but the approved category or claim
    type differs, at least :data:`OVERRIDE_MIN` times for the same rule and the same
    correction. When other lines kept the rule's answer, the proposal narrows the rule
    to the amount range of those lines (``edit``); when none ever kept it, the
    proposal is to remove the rule (``remove``).

Nothing is ever changed here: the owner accepts a suggestion in Settings, which
saves through ``PUT /settings/rules``, or dismisses it, which stores its ``key`` in
``dismissed_suggestions`` so it is not shown again. The pattern proposed is the
merchant key's words escaped and joined by ``\\s*``, case-insensitive, as the
examples in ``config.example.yaml`` are written.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import APPROVED_STATUSES, UNCATEGORIZED, AppConfig
from app.models import DismissedSuggestion, Transaction
from app.services import memory, rules

FIXED_AMOUNT_MIN = 3
ALWAYS_MIN = 5
OVERRIDE_MIN = 3
MAX_LINES = 20_000  # approved lines looked at (newest first)

Kind = Literal["fixed_amount", "always_same", "override"]


@dataclass(slots=True)
class Line:
    raw: str
    merchant: str
    amount: Decimal
    category: str
    claim_type: str


@dataclass(slots=True)
class Suggestion:
    key: str
    kind: Kind
    merchant: str
    category: str
    claim_type: str
    count: int
    """How many approved lines back the suggestion."""
    rule: dict
    """The rule to add (``fixed_amount``, ``always_same``) or the edited rule (``override`` with ``action`` edit)."""
    amount: Decimal | None = None
    """The exact amount for ``fixed_amount``."""
    rule_index: int | None = None
    """The existing rule concerned (``override``), by position in the saved list."""
    action: Literal["add", "edit", "remove"] = "add"
    examples: list[str] = field(default_factory=list)
    """Up to three raw descriptions behind it, so the owner can see what the pattern covers."""


def pattern_for(raw: str) -> str | None:
    """A case-insensitive pattern for the merchant key's words: ``(?i)THIRD\\s*SPACE``."""
    words = memory.merchant_key(raw).split()
    if not words:
        return None
    return "(?i)" + r"\s*".join(_escape(w) for w in words)


def _escape(word: str) -> str:
    """Escape regex metacharacters only, so ``M&S`` stays readable (``re.escape`` would write ``M\&S``)."""
    return re.sub(r"([.^$*+?{}\[\]\\|()])", r"\\\1", word)


def _approved_lines(db: Session) -> list[Line]:
    rows = db.execute(
        select(
            Transaction.raw_description,
            Transaction.cleaned_merchant,
            Transaction.amount,
            Transaction.category,
            Transaction.claim_type,
        )
        .where(
            Transaction.review_status.in_(APPROVED_STATUSES),
            Transaction.is_internal_transfer.isnot(True),
            Transaction.is_split.is_(False),
            Transaction.split_parent_id.is_(None),
            Transaction.category != UNCATEGORIZED,
        )
        .order_by(Transaction.transaction_date.desc(), Transaction.created_at.desc())
        .limit(MAX_LINES)
    ).all()
    return [
        Line(raw=r or "", merchant=(m or "").strip(), amount=Decimal(a), category=c, claim_type=ct)
        for r, m, a, c, ct in rows
    ]


def _rule_dict(pattern: str, category: str, claim_type: str, amount: Decimal | None = None) -> dict:
    out = {
        "pattern": pattern,
        "category": category,
        "claim_type": claim_type,
        "merchant": None,
        "subcategory": None,
        "is_internal_transfer": False,
        "transfer_to_account": None,
        "amount_min": None,
        "amount_max": None,
    }
    if amount is not None:
        out["amount_min"] = out["amount_max"] = str(abs(amount).quantize(Decimal("0.01")))
    return out


def _money(config: AppConfig, value: Decimal) -> str:
    return f"{config.app.currency_symbol}{abs(value):,.2f}"


def suggest(db: Session, config: AppConfig) -> list[Suggestion]:
    """Every suggestion the approvals support, dismissed ones left out, strongest first."""
    lines = _approved_lines(db)
    dismissed = set(db.scalars(select(DismissedSuggestion.key)))
    unruled: dict[str, list[Line]] = defaultdict(list)
    overrides: dict[tuple[int, str, str], list[Line]] = defaultdict(list)
    kept: dict[int, list[Line]] = defaultdict(list)
    for line in lines:
        match = rules.match_rule(line.raw, config, line.amount)
        if match is None:
            key = memory.merchant_key(line.raw)
            if key:
                unruled[key].append(line)
            continue
        index = config.deterministic_rules.index(match.rule)
        if match.category == line.category and match.claim_type == line.claim_type:
            kept[index].append(line)
        else:
            overrides[(index, line.category, line.claim_type)].append(line)

    out: list[Suggestion] = []
    for key, group in unruled.items():
        pattern = pattern_for(group[0].raw)
        if pattern is None:
            continue
        merchant = Counter(line.merchant for line in group).most_common(1)[0][0] or key.title()
        filings = Counter((line.category, line.claim_type) for line in group)
        (category, claim_type), same = filings.most_common(1)[0]
        if same == len(group) and len(group) >= ALWAYS_MIN:
            out.append(
                Suggestion(
                    key=f"always:{key}:{category}:{claim_type}",
                    kind="always_same",
                    merchant=merchant,
                    category=category,
                    claim_type=claim_type,
                    count=len(group),
                    rule=_rule_dict(pattern, category, claim_type),
                    examples=_examples(group),
                )
            )
            continue
        by_amount = Counter((abs(line.amount), line.category, line.claim_type) for line in group)
        for (amount, category, claim_type), count in by_amount.most_common():
            if count < FIXED_AMOUNT_MIN:
                break
            # The amount must always have been filed this way, or a range rule would misfile it.
            if sum(1 for line in group if abs(line.amount) == amount) != count:
                continue
            out.append(
                Suggestion(
                    key=f"fixed:{key}:{amount}:{category}:{claim_type}",
                    kind="fixed_amount",
                    merchant=merchant,
                    category=category,
                    claim_type=claim_type,
                    count=count,
                    amount=amount,
                    rule=_rule_dict(pattern, category, claim_type, amount),
                    examples=_examples([line for line in group if abs(line.amount) == amount]),
                )
            )
    for (index, category, claim_type), group in overrides.items():
        if len(group) < OVERRIDE_MIN or index >= len(config.deterministic_rules):
            continue
        rule = config.deterministic_rules[index]
        base = rule.model_dump(mode="json")
        agreed = kept.get(index, [])
        merchant = Counter(line.merchant for line in group).most_common(1)[0][0]
        if agreed:
            low = min(abs(line.amount) for line in agreed)
            high = max(abs(line.amount) for line in agreed)
            edited = {**base, "amount_min": str(low), "amount_max": str(high)}
            action: Literal["edit", "remove"] = "edit"
        else:
            edited = base
            action = "remove"
        out.append(
            Suggestion(
                key=f"override:{rule.pattern}:{category}:{claim_type}:{action}",
                kind="override",
                merchant=merchant,
                category=category,
                claim_type=claim_type,
                count=len(group),
                rule=edited,
                rule_index=index,
                action=action,
                examples=_examples(group),
            )
        )
    out = [s for s in out if s.key not in dismissed]
    out.sort(key=lambda s: (-s.count, s.merchant.lower()))
    return out


def _examples(group: list[Line]) -> list[str]:
    seen: list[str] = []
    for line in group:
        text = " ".join(line.raw.split())
        if text and text not in seen:
            seen.append(text)
        if len(seen) == 3:
            break
    return seen


def dismiss(db: Session, key: str) -> None:
    key = key.strip()[:200]
    if not key:
        raise ValueError("key must not be blank")
    if db.get(DismissedSuggestion, key) is None:
        db.add(DismissedSuggestion(key=key))
        db.flush()


def describe(config: AppConfig, suggestion: Suggestion) -> str:
    """One plain sentence, as Settings -> Rules shows it."""
    if suggestion.kind == "fixed_amount":
        return (
            f"{suggestion.merchant}, {_money(config, suggestion.amount or Decimal(0))}, filed as "
            f"{suggestion.category} {suggestion.count} times: make it a rule?"
        )
    if suggestion.kind == "always_same":
        return (
            f"{suggestion.merchant} has always been filed as {suggestion.category} "
            f"({suggestion.count} times): make it a rule?"
        )
    if suggestion.action == "edit":
        return (
            f"Rule {(suggestion.rule_index or 0) + 1} matched {suggestion.merchant} but you filed it as "
            f"{suggestion.category} {suggestion.count} times: limit the rule to "
            f"{_money(config, Decimal(suggestion.rule['amount_min']))} to "
            f"{_money(config, Decimal(suggestion.rule['amount_max']))}?"
        )
    return (
        f"Rule {(suggestion.rule_index or 0) + 1} matched {suggestion.merchant} but you filed it as "
        f"{suggestion.category} every time ({suggestion.count}): remove the rule?"
    )
