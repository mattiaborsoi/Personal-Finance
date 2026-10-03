"""Line-regex parser for text-only PDF statements.

Two layouts are supported:

* **Card statements** - ``Jul 31  CINEWORLD  20.99``, ``Aug 04  ANTHROPIC  18.40
  (USD 24.00)``, ``Aug 24  BRITISH AIRWAYS  357.99 CR``. Unmarked amounts are
  charges (negative); ``CR``, a minus sign or parentheses mark credits (positive).
  Section headings such as ``Card ending 7715`` / ``Supplementary card ending 3348``
  set ``card_last4`` for the lines that follow.
* **Checking statements** - ``28 Jul  HSBC CARD PYMT  3,384.21   12,000.00`` under a
  ``Date | Description | Paid Out | Paid In | Balance`` header. Word x-positions
  (pdfplumber ``extract_words``) decide which column an amount sits in; without
  positions the running balance deltas decide, then a ``CR`` hint, then the
  statement style.

Continuation lines (no leading date) are appended to the previous transaction's
``raw_text``; totals, page footers and other boilerplate are not.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from datetime import date
from decimal import Decimal
from pathlib import Path

from app.config import AppConfig
from app.services.parsers.amounts import (
    TRAILING_AMOUNT_RE,
    AmountParts,
    ForeignSpend,
    find_foreign_spend,
    parse_amount,
    parse_amount_parts,
    quantize,
)
from app.services.parsers.base import (
    ParsedStatement,
    ParsedTransaction,
    ParseError,
    StatementDocument,
    StatementMetadata,
)
from app.services.parsers.dates import LEADING_DATE_RE, DateContext
from app.services.parsers.metadata import date_context, detect_metadata, fill_gaps

MONEY_ROLES = ("debit", "credit", "amount", "balance")

_HEADER_RE = re.compile(
    r"""
    (?P<date>(?:transaction|trans|txn|post(?:ing|ed)?|value|payment)\s+date|\bdate\b)
  | (?P<debit>paid\s+out|money\s+out|withdrawals?|debits?|payments?\s+out|\bout\b)
  | (?P<credit>paid\s+in|money\s+in|deposits?|credits?|payments?\s+in|receipts?|\bin\b)
  | (?P<balance>\bbalance\b)
  | (?P<amount>\bamount\b|\bvalue\b)
  | (?P<description>description|details|narrative|particulars|transaction|payee|reference|merchant)
    """,
    re.IGNORECASE | re.VERBOSE,
)
_CARD_SECTION_RE = re.compile(r"(?i)\b(?:card|cardmember|cardholder)\b")
# A section heading that is only the cardholder's name and the card number, as Virgin
# Money prints them (a name, then the full 16-digit card number): 16 characters of digits or masking
# in any grouping, ending in the four digits that identify the card.
_HOLDER_AND_NUMBER_RE = re.compile(r"^(?:[A-Za-z][A-Za-z'.\-]*\s+){1,5}(?P<number>[\dXx*•][\dXx*•\s]{14,24}\d)\s*$")
_LAST4_RE = re.compile(r"(?<!\d)(\d{4})(?!\d)")
_LAST4_KEYWORD_RE = re.compile(r"(?i)(?:ending(?:\s+in)?|number|no\.?|x{2,}|\*{2,}|-|#|:)\s*[x*]*\s*$")
_OPENING_BALANCE_RE = re.compile(
    r"(?i)\b(?:balance\s+brought\s+forward|opening\s+balance|balance\s+b/f|previous\s+balance|start(?:ing)?\s+balance)"
    r"\b.*?(?P<amt>[-−]?\(?£?\d[\d,]*\.\d{2}\)?(?:\s*(?:CR|DR)(?![A-Za-z]))?)\s*$"
)
_NOISE_RE = re.compile(
    r"(?i)^(?:page\s+\d|continued|statement|total|balance|closing|opening|minimum|credit\s+limit|summary|interest"
    r"|please|thank\s+you\s+for|important|your\s|new\s+balance|payment\s+due|amount\s+due|previous\s+balance"
    r"|sort\s+code|account\s+number|account\s+ending|date\b|transactions?\b|carried\s+forward|brought\s+forward)"
)
_TWO_PLACE_RE = re.compile(r"\d\.\d{2}")


# --------------------------------------------------------------------------- #
# Positioned lines
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class Word:
    text: str
    x0: float
    x1: float
    top: float
    bottom: float


@dataclass(slots=True)
class Line:
    """One text line; ``words``/``spans`` are present when x-positions are known."""

    text: str
    words: list[Word] | None = None
    spans: list[tuple[int, int]] | None = None  # character span of each word within ``text``
    top: float | None = None
    bottom: float | None = None


def line_from_words(words: list[Word]) -> Line:
    words = sorted(words, key=lambda w: w.x0)
    parts: list[str] = []
    spans: list[tuple[int, int]] = []
    pos = 0
    for w in words:
        if parts:
            pos += 1
        spans.append((pos, pos + len(w.text)))
        parts.append(w.text)
        pos += len(w.text)
    return Line(
        text=" ".join(parts),
        words=words,
        spans=spans,
        top=min(w.top for w in words),
        bottom=max(w.bottom for w in words),
    )


def extract_lines(path: str | Path, y_tolerance: float = 3.0) -> list[list[Line]]:
    """Words grouped into lines per page using pdfplumber positions ([] on failure)."""
    try:
        import pdfplumber

        pages: list[list[Line]] = []
        with pdfplumber.open(str(path)) as pdf:
            for page in pdf.pages:
                raw = page.extract_words(keep_blank_chars=False, use_text_flow=False)
                words = [
                    Word(str(w["text"]), float(w["x0"]), float(w["x1"]), float(w["top"]), float(w["bottom"]))
                    for w in raw
                ]
                words.sort(key=lambda w: (w.top, w.x0))
                lines: list[Line] = []
                bucket: list[Word] = []
                for w in words:
                    if bucket and abs(w.top - bucket[0].top) > y_tolerance:
                        lines.append(line_from_words(bucket))
                        bucket = []
                    bucket.append(w)
                if bucket:
                    lines.append(line_from_words(bucket))
                pages.append(lines)
        return pages
    except Exception:  # pragma: no cover - corrupt PDF; the caller falls back to plain text
        return []


def text_to_lines(text: str) -> list[Line]:
    return [Line(text=" ".join(raw.split())) for raw in text.splitlines()]


# --------------------------------------------------------------------------- #
# Column layout from a header line
# --------------------------------------------------------------------------- #


def header_roles(text: str) -> dict[str, tuple[int, int]]:
    """Roles named in a header line -> character span (first occurrence each)."""
    roles: dict[str, tuple[int, int]] = {}
    for m in _HEADER_RE.finditer(text):
        role = m.lastgroup or ""
        if role and role not in roles:
            roles[role] = (m.start(), m.end())
    return roles


def is_header_line(text: str) -> bool:
    if len(text) > 120 or LEADING_DATE_RE.match(text):
        return False
    roles = header_roles(text)
    return len(roles) >= 3 and ("amount" in roles or ("debit" in roles and "credit" in roles))


@dataclass(slots=True)
class ColumnLayout:
    spans: dict[str, tuple[float, float]]  # role -> (x0, x1) of the header text

    @classmethod
    def from_line(cls, line: Line) -> ColumnLayout | None:
        if not line.words or not line.spans:
            return None
        spans: dict[str, tuple[float, float]] = {}
        for role, (start, end) in header_roles(line.text).items():
            xs = [w for w, (s, e) in zip(line.words, line.spans, strict=True) if s < end and e > start]
            if xs:
                spans[role] = (min(w.x0 for w in xs), max(w.x1 for w in xs))
        return cls(spans=spans) if spans else None

    @property
    def has_money_columns(self) -> bool:
        return any(r in self.spans for r in MONEY_ROLES)

    def assign(self, word: Word) -> str | None:
        """Role whose header is nearest to ``word`` (by left edge, right edge or centre)."""
        best: tuple[float, str] | None = None
        centre = (word.x0 + word.x1) / 2
        for role, (x0, x1) in self.spans.items():
            distance = min(abs(word.x0 - x0), abs(word.x1 - x1), abs(centre - (x0 + x1) / 2))
            if best is None or distance < best[0]:
                best = (distance, role)
        return best[1] if best else None


_SHORT_YEAR_RE = re.compile(r"^\s+(\d{2})(?=\s)")


def _with_short_year(day: date, yy: str) -> date:
    """``day`` in the year 20<yy> (unchanged if that date does not exist, e.g. 29 Feb)."""
    try:
        return day.replace(year=2000 + int(yy))
    except ValueError:
        return day


def _holder_and_number(text: str) -> str | None:
    """A name followed by a full card number -> the card's last four digits."""
    m = _HOLDER_AND_NUMBER_RE.match(text.strip())
    if not m:
        return None
    number = re.sub(r"\s+", "", m.group("number"))
    if len(number) != 16 or not re.fullmatch(r"[\dXx*•]{12}\d{4}", number):
        return None
    return number[-4:]


def find_card_section(text: str, known_last4: set[str]) -> str | None:
    """``Card ending 7715`` / ``Supplementary card ... 3348`` / a name and full card number
    -> ``"7715"`` / ``"3348"``."""
    holder = _holder_and_number(text)
    if holder:
        return holder
    m = _CARD_SECTION_RE.search(text)
    if not m:
        return None
    after = text[m.end() :]
    candidates = [(c.group(1), c.start()) for c in _LAST4_RE.finditer(after)]
    if not candidates:
        return None
    for last4, _ in candidates:
        if last4 in known_last4:
            return last4
    for last4, pos in candidates:
        if _LAST4_KEYWORD_RE.search(after[:pos]):
            return last4
    if not TRAILING_AMOUNT_RE.search(text):
        for last4, _ in candidates:
            if not 1990 <= int(last4) <= 2039:
                return last4
    return None


# --------------------------------------------------------------------------- #
# Parser
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class _Entry:
    date: date
    raw_text: str
    post_date: date | None = None
    parts: AmountParts | None = None
    amount: Decimal | None = None  # set when a debit/credit column decided the sign
    balance: Decimal | None = None
    balance_sign: int | None = None
    credit_hint: bool = False
    card_last4: str | None = None
    foreign: ForeignSpend | None = None
    words_left: list[str] = field(default_factory=list)


class PdfTextParser:
    name = "pdf_text"

    def __init__(self, config: AppConfig | None = None, metadata: StatementMetadata | None = None) -> None:
        self.config = config
        self.metadata = metadata

    @property
    def base_currency(self) -> str:
        return self.config.app.base_currency if self.config else "GBP"

    @property
    def known_last4(self) -> set[str]:
        return {a.identifier_last4 for a in self.config.accounts} if self.config else set()

    def can_parse(self, doc: StatementDocument) -> bool:
        return doc.is_pdf and bool(doc.full_text.strip())

    def parse(self, doc: StatementDocument) -> ParsedStatement:
        meta = replace(self.metadata) if self.metadata else detect_metadata(doc, self.config)
        pages = extract_lines(doc.path)
        if not any(pages):
            pages = [text_to_lines(t) for t in doc.text_pages]
        return self.parse_pages(pages, meta)

    def parse_text(self, text: str, metadata: StatementMetadata | None = None) -> ParsedStatement:
        """Parse plain statement text (no positions); pages separated by form feeds."""
        meta = replace(metadata) if metadata else StatementMetadata()
        return self.parse_pages([text_to_lines(page) for page in text.split("\f")], meta)

    # ----- core ------------------------------------------------------------
    def parse_pages(self, pages: list[list[Line]], meta: StatementMetadata) -> ParsedStatement:
        ctx = date_context(meta)
        warnings: list[str] = []
        if ctx.period_end is None and ctx.period_start is None:
            warnings.append("statement period not found; years of day-month dates inferred from today's date")

        entries: list[_Entry] = []
        layout: ColumnLayout | None = None
        header_seen = False
        current_card: str | None = None
        running_balance: Decimal | None = None
        previous: _Entry | None = None
        previous_line: Line | None = None
        continuation_count = 0

        for lines in pages:
            previous = None  # page headers/footers never continue a description
            for line in lines:
                text = line.text.strip()
                if not text:
                    previous = None
                    continue
                if is_header_line(text):
                    header_seen = True
                    layout = ColumnLayout.from_line(line) if line.words else layout
                    previous = None
                    continue
                m = LEADING_DATE_RE.match(text)
                if m:
                    entry = self._parse_transaction_line(line, m, layout, header_seen, ctx)
                    if entry is not None:
                        entry.card_last4 = current_card
                        if entry.balance is not None:
                            if running_balance is not None and entry.parts is not None:
                                entry.balance_sign = _sign_from_balance(
                                    running_balance, entry.balance, entry.parts.magnitude
                                )
                            running_balance = entry.balance
                        entries.append(entry)
                        previous, previous_line, continuation_count = entry, line, 0
                        continue
                card = find_card_section(text, self.known_last4)
                if card:
                    current_card = card
                    previous = None
                    continue
                opening = _OPENING_BALANCE_RE.search(text)
                if opening and not entries:
                    running_balance = parse_amount(opening.group("amt"))
                    previous = None
                    continue
                if previous is not None and continuation_count < 3 and _is_continuation(text, line, previous_line):
                    self._append_continuation(previous, text)
                    continuation_count += 1
                    previous_line = line
                    continue
                previous = None

        transactions = self._resolve(entries, meta.account_type_hint, warnings)
        if not transactions:
            raise ParseError("no transaction lines recognised")
        derived_hint = "checking" if (layout and "debit" in layout.spans and "credit" in layout.spans) else None
        fill_gaps(meta, transactions, hint=derived_hint, closing_balance=running_balance)
        return ParsedStatement(metadata=meta, transactions=transactions, parser_name=self.name, warnings=warnings)

    # ----- one line ----------------------------------------------------------
    def _parse_transaction_line(
        self,
        line: Line,
        m: re.Match[str],
        layout: ColumnLayout | None,
        header_seen: bool,
        ctx: DateContext,
    ) -> _Entry | None:
        text = line.text
        txn_date = ctx.parse(m.group("date"))
        if txn_date is None:
            return None
        consumed: list[tuple[int, int]] = [(0, m.end())]
        rest_start = m.end()
        post_date: date | None = None
        # Virgin Money prints "16 Aug 26 17 Aug 26": a two-digit year after each date.
        # It is only read as a year when another date follows it (or, after the posted
        # date, when it repeats the first one's year), so "16 Aug 24 HOUR FITNESS" keeps
        # its "24".
        yy = _SHORT_YEAR_RE.match(text[rest_start:])
        if yy and LEADING_DATE_RE.match(text[rest_start + yy.end() :]):
            txn_date = _with_short_year(txn_date, yy.group(1))
            consumed.append((rest_start, rest_start + yy.end()))
            rest_start += yy.end()
        else:
            yy = None
        m2 = LEADING_DATE_RE.match(text[rest_start:])
        if m2:
            candidate = ctx.parse(m2.group("date"))
            if candidate is not None:
                post_date = candidate
                consumed.append((rest_start, rest_start + m2.end()))
                rest_start += m2.end()
                yy2 = _SHORT_YEAR_RE.match(text[rest_start:])
                if yy and yy2 and abs(int(yy2.group(1)) - int(yy.group(1))) <= 1:
                    post_date = _with_short_year(post_date, yy2.group(1))
                    consumed.append((rest_start, rest_start + yy2.end()))
                    rest_start += yy2.end()

        foreign: ForeignSpend | None = None
        found = find_foreign_spend(text[rest_start:], self.base_currency)
        if found:
            start, end, foreign = found
            consumed.append((rest_start + start, rest_start + end))

        if line.words and line.spans and layout is not None and layout.has_money_columns:
            entry = self._positional(line, layout, consumed, txn_date)
        else:
            entry = self._textual(text, rest_start, consumed, txn_date, header_seen)
        if entry is None:
            return None
        entry.post_date = post_date
        entry.foreign = foreign
        entry.credit_hint = bool(re.search(r"(?i)(?:^|\s)CR$", entry.raw_text))
        return entry

    def _positional(
        self, line: Line, layout: ColumnLayout, consumed: list[tuple[int, int]], txn_date: date
    ) -> _Entry | None:
        assert line.words is not None and line.spans is not None
        description: list[str] = []
        by_role: dict[str, AmountParts] = {}
        last_numeric: tuple[str, AmountParts] | None = None
        for word, (start, end) in zip(line.words, line.spans, strict=True):
            if any(s < end and e > start for s, e in consumed):
                last_numeric = None
                continue
            token = word.text.strip()
            upper = token.upper().rstrip(".")
            if upper in ("CR", "DR") and last_numeric is not None:
                role, parts = last_numeric
                if parts.marker is None:
                    parts.marker = upper
                last_numeric = None
                continue
            parts = parse_amount_parts(token) if _TWO_PLACE_RE.search(token) else None
            role = layout.assign(word) if parts else None
            if parts and role in MONEY_ROLES and role not in by_role:
                by_role[role] = parts
                last_numeric = (role, parts)
                continue
            if token in ("£", "$", "€"):
                continue
            description.append(token)
            last_numeric = None
        if not any(r in by_role for r in ("debit", "credit", "amount")):
            return None
        entry = _Entry(date=txn_date, raw_text=" ".join(description))
        if "debit" in by_role and by_role["debit"].magnitude != 0:
            entry.amount = -by_role["debit"].magnitude
            entry.parts = by_role["debit"]
        elif "credit" in by_role:
            entry.amount = by_role["credit"].magnitude
            entry.parts = by_role["credit"]
        elif "debit" in by_role:
            entry.amount = Decimal("0.00")
            entry.parts = by_role["debit"]
        else:
            entry.parts = by_role["amount"]
        if "balance" in by_role:
            entry.balance = by_role["balance"].signed
        return entry

    def _textual(
        self, text: str, rest_start: int, consumed: list[tuple[int, int]], txn_date: date, header_seen: bool
    ) -> _Entry | None:
        # Blank out consumed spans (dates, foreign spend) so neighbouring tokens stay separated.
        chars = [
            " " if any(s <= idx < e for s, e in consumed) else text[idx] for idx in range(rest_start, len(text))
        ]
        rest = " ".join("".join(chars).split())
        tokens: list[str] = []
        for _ in range(2):
            mt = TRAILING_AMOUNT_RE.search(rest)
            if not mt:
                break
            tokens.insert(0, mt.group("token"))
            rest = rest[: mt.start()].rstrip()
        if not tokens:
            return None
        entry = _Entry(date=txn_date, raw_text=rest)
        if len(tokens) == 2:
            entry.parts = parse_amount_parts(tokens[0])
            balance = parse_amount_parts(tokens[1])
            entry.balance = balance.signed if balance else None
        else:
            entry.parts = parse_amount_parts(tokens[0])
        if entry.parts is None:
            return None
        return entry

    def _append_continuation(self, entry: _Entry, text: str) -> None:
        if entry.foreign is None:
            found = find_foreign_spend(text, self.base_currency)
            if found:
                start, end, entry.foreign = found
                text = " ".join((text[:start] + " " + text[end:]).split())
        if text:
            entry.raw_text = " ".join(f"{entry.raw_text} {text}".split())

    # ----- sign resolution ----------------------------------------------------
    def _resolve(self, entries: list[_Entry], hint: str | None, warnings: list[str]) -> list[ParsedTransaction]:
        free = [e.parts for e in entries if e.amount is None and e.parts is not None]
        signed_style = (
            hint != "credit"
            and any(p.explicit_negative for p in free)
            and not any(p.marker for p in free)
        )
        plain_is_debit = not signed_style
        out: list[ParsedTransaction] = []
        dropped = 0
        for e in entries:
            if e.amount is not None:
                amount = e.amount
            elif e.parts is None:
                continue
            elif e.parts.marker:
                amount = e.parts.apply(plain_is_debit=plain_is_debit)
            elif e.balance_sign is not None:
                amount = e.balance_sign * e.parts.magnitude
            elif e.credit_hint and not e.parts.explicit_negative:
                amount = e.parts.magnitude
            else:
                amount = e.parts.apply(plain_is_debit=plain_is_debit)
            if not e.raw_text:
                dropped += 1
                continue
            out.append(
                ParsedTransaction(
                    date=e.date,
                    post_date=e.post_date,
                    raw_text=e.raw_text,
                    amount=quantize(amount),
                    card_last4=e.card_last4,
                    foreign_amount=e.foreign.amount if e.foreign else None,
                    foreign_currency=e.foreign.currency if e.foreign else None,
                )
            )
        if dropped:
            warnings.append(f"{dropped} dated line(s) without a description were ignored")
        return out


def _sign_from_balance(previous: Decimal, current: Decimal, magnitude: Decimal) -> int | None:
    delta = current - previous
    if abs(delta - magnitude) <= Decimal("0.01"):
        return 1
    if abs(delta + magnitude) <= Decimal("0.01"):
        return -1
    return None


def _is_continuation(text: str, line: Line, previous_line: Line | None) -> bool:
    if _NOISE_RE.match(text) or is_header_line(text) or TRAILING_AMOUNT_RE.search(text):
        return False
    if previous_line is not None and line.top is not None and previous_line.bottom is not None:
        height = (previous_line.bottom - previous_line.top) if previous_line.top is not None else 0
        gap = line.top - previous_line.bottom
        if height and gap > 1.2 * height:
            return False
    return True
