"""Replaying a learnt PDF layout without AI (see ``app.services.layouts``).

A *template* describes how one institution prints its statement lines, in terms
the deterministic parser can apply with regular expressions:

.. code-block:: json

    {"version": 1,
     "line": "^(?P<description>.+?)\\s+(?P<amount>[\\d,]+\\.\\d{2})(?P<cr>\\s+CR)?\\s+(?P<date>\\d{2}/\\d{2}/\\d{4})$",
     "sign": "unsigned_is_debit",
     "day_first": true,
     "card_section": "(?i)card ending (?P<last4>\\d{4})",
     "skip": ["(?i)^(?:balance|total|page)"],
     "continuation": false}

* ``line``: matched against every text line; named groups ``date`` and
  ``description`` are required, plus ``amount`` or both ``debit`` and ``credit``;
  ``post_date``, ``cr`` (money in when it matches anything) and ``card`` are optional.
* ``sign``: ``unsigned_is_debit`` (card style: a bare amount is money out; CR, a minus
  or parentheses mean money in), ``signed`` (minus means money out, as in a bank
  export) or ``debit_credit`` (two columns).
* ``day_first``: how numeric dates read (``true`` for ``31/07/2026``).
* ``card_section``: a heading that starts a card's section, with a ``last4`` group.
* ``skip``: lines to ignore before anything else; ``continuation``: whether a line
  matching nothing is appended to the previous transaction's description.

Regular expressions come from a model, so they are checked before use: at most
:data:`MAX_PATTERN_LENGTH` characters, they must compile, and a quantifier applied
to a group that itself contains a quantifier (the classic catastrophic
backtracking shape) is refused. Lines are capped at :data:`MAX_LINE_LENGTH`
characters before matching.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from datetime import date
from typing import Any

from app.config import AppConfig
from app.services.parsers.amounts import find_foreign_spend, parse_amount_parts, quantize
from app.services.parsers.base import (
    ParsedStatement,
    ParsedTransaction,
    ParseError,
    StatementDocument,
    StatementMetadata,
)
from app.services.parsers.dates import DateContext
from app.services.parsers.metadata import date_context, detect_metadata, fill_gaps

TEMPLATE_VERSION = 1
SIGNS: tuple[str, ...] = ("unsigned_is_debit", "signed", "debit_credit")
MAX_PATTERN_LENGTH = 400
MAX_SKIP_PATTERNS = 10
MAX_LINE_LENGTH = 300
MAX_CONTINUATIONS = 2
_NESTED_QUANTIFIER_RE = re.compile(r"\([^()]*[*+][^()]*\)\s*[*+{]")
_NOISE_RE = re.compile(r"(?i)^(?:page\s+\d|continued|total|balance|closing|opening|statement|summary)")


class TemplateError(ValueError):
    """The template is not usable."""


def compile_pattern(pattern: object, where: str, required: set[str] = frozenset()) -> re.Pattern[str]:
    if not isinstance(pattern, str) or not pattern.strip():
        raise TemplateError(f"{where}: a pattern is required")
    if len(pattern) > MAX_PATTERN_LENGTH:
        raise TemplateError(f"{where}: pattern longer than {MAX_PATTERN_LENGTH} characters")
    if _NESTED_QUANTIFIER_RE.search(pattern):
        raise TemplateError(f"{where}: nested quantifiers are not allowed")
    try:
        compiled = re.compile(pattern)
    except re.error as exc:
        raise TemplateError(f"{where}: invalid regex ({exc})") from exc
    missing = required - set(compiled.groupindex)
    if missing:
        raise TemplateError(f"{where}: missing named group(s) {', '.join(sorted(missing))}")
    return compiled


@dataclass(slots=True)
class Template:
    line: re.Pattern[str]
    sign: str
    day_first: bool
    card_section: re.Pattern[str] | None
    skip: list[re.Pattern[str]]
    continuation: bool

    @classmethod
    def from_dict(cls, raw: Any) -> Template:
        """Validate a stored or model-written template; raises :class:`TemplateError`."""
        if not isinstance(raw, dict):
            raise TemplateError("template must be an object")
        if raw.get("version", TEMPLATE_VERSION) != TEMPLATE_VERSION:
            raise TemplateError(f"unsupported template version {raw.get('version')!r}")
        line = compile_pattern(raw.get("line"), "line", {"date", "description"})
        groups = set(line.groupindex)
        sign = raw.get("sign", "unsigned_is_debit")
        if sign not in SIGNS:
            raise TemplateError(f"sign must be one of {', '.join(SIGNS)}")
        if sign == "debit_credit":
            if not {"debit", "credit"} <= groups:
                raise TemplateError("line: debit_credit needs the groups debit and credit")
        elif "amount" not in groups:
            raise TemplateError("line: missing named group amount")
        card_section = raw.get("card_section")
        skip_raw = raw.get("skip") or []
        if not isinstance(skip_raw, list) or len(skip_raw) > MAX_SKIP_PATTERNS:
            raise TemplateError(f"skip must be a list of at most {MAX_SKIP_PATTERNS} patterns")
        return cls(
            line=line,
            sign=sign,
            day_first=bool(raw.get("day_first", True)),
            card_section=compile_pattern(card_section, "card_section", {"last4"}) if card_section else None,
            skip=[compile_pattern(p, f"skip[{i}]") for i, p in enumerate(skip_raw)],
            continuation=bool(raw.get("continuation", False)),
        )


def clean_template(raw: Any) -> dict:
    """The template as stored: only the known keys, validated."""
    Template.from_dict(raw)
    out = {
        "version": TEMPLATE_VERSION,
        "line": raw["line"],
        "sign": raw.get("sign", "unsigned_is_debit"),
        "day_first": bool(raw.get("day_first", True)),
        "card_section": raw.get("card_section") or None,
        "skip": list(raw.get("skip") or []),
        "continuation": bool(raw.get("continuation", False)),
    }
    return out


class TemplateParser:
    name = "pdf_template"

    def __init__(
        self, template: dict | Template, config: AppConfig | None = None, metadata: StatementMetadata | None = None
    ) -> None:
        self.template = template if isinstance(template, Template) else Template.from_dict(template)
        self.config = config
        self.metadata = metadata

    @property
    def base_currency(self) -> str:
        return self.config.app.base_currency if self.config else "GBP"

    def can_parse(self, doc: StatementDocument) -> bool:
        return doc.is_pdf and bool(doc.full_text.strip())

    def parse(self, doc: StatementDocument) -> ParsedStatement:
        meta = replace(self.metadata) if self.metadata else detect_metadata(doc, self.config)
        return self.parse_pages(doc.text_pages, meta)

    def parse_pages(self, pages: list[str], meta: StatementMetadata) -> ParsedStatement:
        ctx = date_context(meta)
        ctx.day_first = self.template.day_first
        transactions: list[ParsedTransaction] = []
        warnings: list[str] = []
        current_card: str | None = None
        previous: ParsedTransaction | None = None
        continuations = 0
        for page in pages:
            previous = None
            for raw_line in page.splitlines():
                text = " ".join(raw_line.split())[:MAX_LINE_LENGTH]
                if not text:
                    previous = None
                    continue
                if any(p.search(text) for p in self.template.skip):
                    previous = None
                    continue
                if self.template.card_section is not None:
                    section = self.template.card_section.search(text)
                    if section:
                        current_card = section.group("last4")
                        previous = None
                        continue
                m = self.template.line.search(text)
                if m:
                    txn = self._transaction(m, ctx, current_card)
                    if txn is None:
                        warnings.append(f"line not understood: {text[:60]!r}")
                        previous = None
                        continue
                    transactions.append(txn)
                    previous, continuations = txn, 0
                    continue
                if (
                    self.template.continuation
                    and previous is not None
                    and continuations < MAX_CONTINUATIONS
                    and not _NOISE_RE.match(text)
                ):
                    previous.raw_text = " ".join(f"{previous.raw_text} {text}".split())
                    continuations += 1
                    continue
                previous = None
        if not transactions:
            raise ParseError("the learnt layout matched no lines")
        fill_gaps(meta, transactions)
        return ParsedStatement(metadata=meta, transactions=transactions, parser_name=self.name, warnings=warnings[:10])

    def _transaction(self, m: re.Match[str], ctx: DateContext, current_card: str | None) -> ParsedTransaction | None:
        groups = m.groupdict()
        txn_date = ctx.parse((groups.get("date") or "").strip())
        if txn_date is None:
            return None
        description = " ".join((groups.get("description") or "").split())
        description, foreign = _without_foreign(description, self.base_currency)
        if not description:
            return None
        amount = self._amount(groups)
        if amount is None:
            return None
        post = groups.get("post_date")
        card = groups.get("card")
        return ParsedTransaction(
            date=txn_date,
            post_date=ctx.parse(post.strip()) if post else None,
            raw_text=description,
            amount=quantize(amount),
            card_last4=_last4(card) if card else current_card,
            foreign_amount=foreign[1] if foreign else None,
            foreign_currency=foreign[0] if foreign else None,
        )

    def _amount(self, groups: dict[str, str | None]):
        sign = self.template.sign
        if sign == "debit_credit":
            debit = parse_amount_parts((groups.get("debit") or "").strip())
            credit = parse_amount_parts((groups.get("credit") or "").strip())
            if debit and debit.magnitude != 0:
                return -debit.magnitude
            if credit and credit.magnitude != 0:
                return credit.magnitude
            return None if debit is None and credit is None else quantize(0)
        parts = parse_amount_parts((groups.get("amount") or "").strip())
        if parts is None:
            return None
        if groups.get("cr"):
            return parts.magnitude
        return parts.apply(plain_is_debit=sign == "unsigned_is_debit")


def _last4(value: str) -> str | None:
    digits = "".join(ch for ch in value if ch.isdigit())
    return digits[-4:] if len(digits) >= 4 else None


def _without_foreign(text: str, base_currency: str):
    found = find_foreign_spend(text, base_currency)
    if not found:
        return text, None
    start, end, spend = found
    return " ".join((text[:start] + " " + text[end:]).split()), (spend.currency, spend.amount)


def _signature(txn: ParsedTransaction) -> tuple[date, str, str]:
    return txn.date, str(quantize(txn.amount)), " ".join(txn.raw_text.upper().split())


def reproduces(parsed: ParsedStatement, expected: list[ParsedTransaction]) -> bool:
    """True when ``parsed`` carries exactly the lines the model extracted (date, amount, text)."""
    if len(parsed.transactions) != len(expected) or not expected:
        return False
    return sorted(_signature(t) for t in parsed.transactions) == sorted(_signature(t) for t in expected)
