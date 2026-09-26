"""Statement metadata detection (institution, account last-4, period, closing date).

Works on the document text for PDFs and on the file name for CSV/XLSX uploads
(``hsbc_4471_aug.csv``). Institutions are recognised from the configured accounts
plus a list of common UK banks; the account last-4 must be one of the configured
identifiers and is preferred when it sits next to words such as ``ending``,
``Account`` or ``Card``.
"""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal

from app.config import AppConfig
from app.services.parsers.amounts import parse_amount
from app.services.parsers.base import StatementDocument, StatementMetadata
from app.services.parsers.dates import DATE_PATTERN, DateContext, has_explicit_year, parse_date

INSTITUTION_ALIASES: dict[str, tuple[str, ...]] = {
    "amex": ("american express", "amex"),
    "hsbc": ("hsbc",),
    "virgin": ("virgin money", "virgin"),
    "barclays": ("barclays", "barclaycard"),
    "lloyds": ("lloyds",),
    "natwest": ("natwest", "national westminster"),
    "santander": ("santander",),
    "monzo": ("monzo",),
    "starling": ("starling",),
    "halifax": ("halifax",),
    "nationwide": ("nationwide",),
    "revolut": ("revolut",),
    "first direct": ("first direct",),
    "tsb": ("tsb",),
    "chase": ("chase",),
    "capital one": ("capital one",),
    "mbna": ("mbna",),
    "tesco bank": ("tesco bank",),
    "john lewis": ("john lewis",),
    "m&s bank": ("m&s bank", "marks & spencer"),
    "co-operative bank": ("co-operative bank", "cooperative bank"),
    "metro bank": ("metro bank",),
    "robinhood": ("robinhood",),
    "vanguard": ("vanguard",),
    "trading 212": ("trading 212", "trading212"),
}

_LAST4_CONTEXT_RE = re.compile(
    r"(?i)(ending(?:\s+in)?|account|acct|a/c|card|number|no\.?|xxxx|x{2,}|\*{2,}|sort\s+code|#)"
)
_SUPPLEMENTARY_RE = re.compile(r"(?i)supplementary|additional|secondary")

_DATE = DATE_PATTERN
_SEP = r"(?:to|until|through|-|–|—)"
PERIOD_RES: tuple[re.Pattern[str], ...] = (
    re.compile(rf"(?i)statement\s+period\s*:?\s*(?P<a>{_DATE})\s*{_SEP}\s*(?P<b>{_DATE})"),
    re.compile(rf"(?i)\bperiod\s*(?:covered|of|ending)?\s*:?\s*(?P<a>{_DATE})\s*{_SEP}\s*(?P<b>{_DATE})"),
    re.compile(rf"(?i)\bfrom\s+(?P<a>{_DATE})\s+(?:to|until|through)\s+(?P<b>{_DATE})"),
    re.compile(rf"(?i)(?P<a>{_DATE})\s*{_SEP}\s*(?P<b>{_DATE})"),
)
# In priority order: an explicit closing/statement date beats an "as at" phrase in prose.
_CLOSING_DATE_RES: tuple[re.Pattern[str], ...] = (
    re.compile(rf"(?i)\b(?:closing\s+date|statement\s+date|date\s+of\s+statement)\s*:?\s*(?P<d>{_DATE})"),
    re.compile(rf"(?i)\b(?:as\s+at|as\s+of)\s*:?\s*(?P<d>{_DATE})"),
)
_CLOSING_BALANCE_RE = re.compile(
    r"(?i)\b(?:closing\s+balance|new\s+balance|balance\s+carried\s+forward|balance\s+c/f|end(?:ing)?\s+balance)"
    r"\s*(?:\([^)]*\))?\s*:?\s*(?:£|GBP)?\s*"
    r"(?P<amt>[-−]?\(?£?\d[\d,]*\.\d{2}\)?(?:\s*(?:CR|DR)(?![A-Za-z]))?)"
)

_CREDIT_HINTS: tuple[tuple[str, int], ...] = (
    (r"credit\s+card", 2),
    (r"minimum\s+payment", 2),
    (r"credit\s+limit", 2),
    (r"cardmember", 2),
    (r"card\s+ending", 1),
    (r"new\s+balance", 1),
    (r"available\s+credit", 1),
    (r"american\s+express", 1),
    (r"supplementary\s+card", 1),
)
_CHECKING_HINTS: tuple[tuple[str, int], ...] = (
    (r"paid\s+out", 2),
    (r"paid\s+in", 2),
    (r"sort\s+code", 2),
    (r"current\s+account", 2),
    (r"money\s+out", 2),
    (r"money\s+in", 2),
    (r"withdrawals", 1),
    (r"deposits", 1),
    (r"account\s+number", 1),
)


def _keywords_for(institution: str) -> tuple[str, ...]:
    key = institution.strip().lower()
    return INSTITUTION_ALIASES.get(key, (key,))


def _find_keyword(text: str, keyword: str) -> int | None:
    m = re.search(rf"(?<![A-Za-z0-9]){re.escape(keyword)}(?![A-Za-z0-9])", text, re.IGNORECASE)
    return m.start() if m else None


def detect_institution(text: str, config: AppConfig | None, filename: str = "") -> str | None:
    """Institution name as spelt in ``config`` (falling back to a well-known bank)."""
    configured: list[str] = []
    if config is not None:
        for acc in config.accounts:
            if acc.institution not in configured:
                configured.append(acc.institution)
    for haystack in (text, filename):
        if not haystack:
            continue
        best: tuple[int, str] | None = None
        for institution in configured:
            for keyword in _keywords_for(institution):
                pos = _find_keyword(haystack, keyword)
                if pos is not None and (best is None or pos < best[0]):
                    best = (pos, institution)
        if best is None:
            for key, keywords in INSTITUTION_ALIASES.items():
                for keyword in keywords:
                    pos = _find_keyword(haystack, keyword)
                    if pos is not None and (best is None or pos < best[0]):
                        best = (pos, key.upper() if len(key) <= 4 else key.title())
        if best is not None:
            return best[1]
    return None


def detect_account_last4(text: str, config: AppConfig | None, filename: str = "", institution: str | None = None):
    """Best configured last-4 mentioned in the text (or file name), or ``None``."""
    if config is None or not config.accounts:
        return None
    candidates: list[tuple[int, int, str]] = []  # (score, position, last4)
    seen_plain: dict[str, int] = {}
    for acc in config.accounts:
        last4 = acc.identifier_last4
        if not last4.isdigit():
            continue
        pattern = re.compile(rf"(?<!\d){re.escape(last4)}(?!\d)")
        inst_bonus = 1 if institution and acc.institution.lower() == institution.lower() else 0
        for m in pattern.finditer(text):
            line_start = text.rfind("\n", 0, m.start()) + 1
            context = text[max(line_start, m.start() - 60) : m.start()]
            if _LAST4_CONTEXT_RE.search(context):
                score = 4 + inst_bonus - (2 if _SUPPLEMENTARY_RE.search(context) else 0)
                candidates.append((score, m.start(), last4))
            else:
                seen_plain.setdefault(last4, m.start())
        if filename:
            m = pattern.search(filename)
            if m:
                candidates.append((2 + inst_bonus, 10_000 + m.start(), last4))
    if candidates:
        candidates.sort(key=lambda c: (-c[0], c[1]))
        return candidates[0][2]
    if len(seen_plain) == 1:
        return next(iter(seen_plain))
    return None


def _parse_period_pair(a: str, b: str) -> tuple[date | None, date | None]:
    end = parse_date(b)
    if end is None:
        return None, None
    start = parse_date(a) if has_explicit_year(a) else parse_date(a, period_end=end)
    return start, end


def detect_period(text: str) -> tuple[date | None, date | None]:
    """Statement period from ``Statement period X to Y`` / ``from X to Y`` / ``X - Y``."""
    for idx, regex in enumerate(PERIOD_RES):
        for m in regex.finditer(text):
            a, b = m.group("a"), m.group("b")
            if idx == len(PERIOD_RES) - 1 and not (has_explicit_year(a) and has_explicit_year(b)):
                continue  # the generic form must spell out both years
            start, end = _parse_period_pair(a, b)
            if start and end and start <= end and (end - start).days <= 400:
                return start, end
    return None, None


def detect_closing_date(text: str) -> date | None:
    for regex in _CLOSING_DATE_RES:
        for m in regex.finditer(text):
            d = parse_date(m.group("d")) if has_explicit_year(m.group("d")) else None
            if d:
                return d
    return None


def detect_closing_balance(text: str) -> Decimal | None:
    m = _CLOSING_BALANCE_RE.search(text)
    if not m:
        return None
    return parse_amount(m.group("amt"))


def detect_account_type_hint(text: str) -> str | None:
    credit = sum(w for pat, w in _CREDIT_HINTS if re.search(pat, text, re.IGNORECASE))
    checking = sum(w for pat, w in _CHECKING_HINTS if re.search(pat, text, re.IGNORECASE))
    if credit > checking:
        return "credit"
    if checking > credit:
        return "checking"
    return None


def hint_from_config(config: AppConfig | None, institution: str | None, last4: str | None) -> str | None:
    """Derive the account type from the configured accounts the metadata points at."""
    if config is None:
        return None
    accounts = config.accounts_by_last4(last4, institution) if last4 else []
    if not accounts and institution:
        accounts = [a for a in config.accounts if a.institution.lower() == institution.lower()]
    if not accounts:
        return None
    types = {a.account_type for a in accounts}
    if types <= {"credit", "credit_supplementary"}:
        return "credit"
    if types <= {"checking", "savings"}:
        return "checking"
    return None


def detect_metadata(doc: StatementDocument, config: AppConfig | None) -> StatementMetadata:
    """Guess :class:`StatementMetadata` from the document text and file name."""
    text = doc.full_text if doc.is_pdf else ""
    filename = doc.filename or ""
    institution = detect_institution(text, config, filename)
    last4 = detect_account_last4(text, config, filename, institution)
    start, end = detect_period(text) if text else (None, None)
    closing = detect_closing_date(text) if text else None
    hint = detect_account_type_hint(text) if text else None
    if hint is None:
        hint = hint_from_config(config, institution, last4)
    return StatementMetadata(
        institution=institution,
        account_last4=last4,
        closing_date=closing or end,
        period_start=start,
        period_end=end,
        closing_balance=detect_closing_balance(text) if text else None,
        account_type_hint=hint,
    )


def date_context(meta: StatementMetadata) -> DateContext:
    """Year-inference context for a statement: the period (or closing date) drives it."""
    end = meta.period_end or meta.closing_date
    return DateContext(period_start=meta.period_start, period_end=end)


def fill_gaps(meta: StatementMetadata, transactions, *, hint: str | None = None, closing_balance=None):
    """Complete missing metadata from parsed transactions (period, closing date)."""
    dates = sorted(t.date for t in transactions)
    if dates:
        if meta.period_start is None:
            meta.period_start = dates[0]
        if meta.period_end is None:
            meta.period_end = dates[-1]
        if meta.closing_date is None:
            meta.closing_date = meta.period_end
    if meta.account_type_hint is None and hint:
        meta.account_type_hint = hint
    if meta.closing_balance is None and closing_balance is not None:
        meta.closing_balance = closing_balance
    return meta
