"""Date parsing for statement text.

Statements print dates in many shapes (``Jul 31``, ``31 Jul``, ``31/07/2026``,
``2026-07-31``, ``31 Jul 2026``, ``28th August 2026`` ...). Day-month-only dates
carry no year, so the year is inferred from the statement period: a month later
than the period's end month belongs to the previous year (December lines on a
statement that closes in January).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime

MONTHS: dict[str, int] = {
    "jan": 1, "january": 1,
    "feb": 2, "february": 2,
    "mar": 3, "march": 3,
    "apr": 4, "april": 4,
    "may": 5,
    "jun": 6, "june": 6,
    "jul": 7, "july": 7,
    "aug": 8, "august": 8,
    "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10,
    "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}  # fmt: skip

_MONTH_NAMES = (
    r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?"
    r"|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
)
_ORD = r"(?:st|nd|rd|th)?"

# A single date token in any supported shape. Longest / most specific forms first so
# that ``31 Jul 2026`` is not matched as ``31 Jul`` followed by a stray ``2026``.
DATE_PATTERN = (
    r"(?:"
    r"\d{4}-\d{2}-\d{2}"  # 2026-07-31
    rf"|\d{{1,2}}{_ORD}\s+(?:{_MONTH_NAMES})\.?,?\s+\d{{4}}(?![\d])"  # 31 Jul 2026 / 28th August 2026
    rf"|(?:{_MONTH_NAMES})\.?\s+\d{{1,2}}{_ORD},?\s+\d{{4}}(?![\d])"  # Jul 31, 2026
    r"|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(?![\d])"  # 31/07/2026, 31-07-26
    rf"|\d{{1,2}}{_ORD}\s+(?:{_MONTH_NAMES})(?![a-z])\.?"  # 31 Jul
    rf"|(?:{_MONTH_NAMES})\.?\s+\d{{1,2}}{_ORD}(?![\d])"  # Jul 31
    r"|\d{1,2}[/.]\d{1,2}(?![\d/.])"  # 31/07
    r")"
)
DATE_RE = re.compile(DATE_PATTERN, re.IGNORECASE)
LEADING_DATE_RE = re.compile(rf"^\s*(?P<date>{DATE_PATTERN})(?=\s|$)", re.IGNORECASE)

_ISO_RE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$")
_NUMERIC_RE = re.compile(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$")
_DAY_MONTH_RE = re.compile(rf"^(\d{{1,2}}){_ORD}\s+([A-Za-z]{{3,9}})\.?,?(?:\s+(\d{{2,4}}))?$")
_MONTH_DAY_RE = re.compile(rf"^([A-Za-z]{{3,9}})\.?\s+(\d{{1,2}}){_ORD},?(?:\s+(\d{{2,4}}))?$")
_DAY_MONTH_NUMERIC_RE = re.compile(r"^(\d{1,2})[/.](\d{1,2})$")


def infer_year(
    month: int,
    *,
    period_start: date | None = None,
    period_end: date | None = None,
    default_year: int | None = None,
) -> int:
    """Pick the year for a day-month-only date.

    With a known period end, months after the end month belong to the previous year
    (the Dec -> Jan rollover); with only a start, months before the start month
    belong to the next year. Without any period the current year is used, again
    treating months later than today's as last year (statements never contain
    future dates).
    """
    if period_end is not None:
        return period_end.year - 1 if month > period_end.month else period_end.year
    if period_start is not None:
        return period_start.year + 1 if month < period_start.month else period_start.year
    if default_year is not None:
        return default_year
    today = date.today()
    return today.year - 1 if month > today.month else today.year


def _expand_year(raw: str) -> int:
    year = int(raw)
    if year < 100:
        year += 2000 if year < 80 else 1900
    return year


def _safe_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def parse_date(
    value: object,
    *,
    period_start: date | None = None,
    period_end: date | None = None,
    default_year: int | None = None,
    day_first: bool = True,
) -> date | None:
    """Parse a date cell/token; ``None`` when it is not a date.

    Numeric dates are read day-first (UK) unless ``day_first`` is false; an impossible
    day-first reading (``07/31/2026``) falls back to month-first. Dates without a year
    are completed with :func:`infer_year`.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not text:
        return None

    m = _ISO_RE.match(text)
    if m:
        return _safe_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))

    m = _NUMERIC_RE.match(text)
    if m:
        a, b, year = int(m.group(1)), int(m.group(2)), _expand_year(m.group(3))
        day, month = (a, b) if day_first else (b, a)
        result = _safe_date(year, month, day)
        if result is None:
            result = _safe_date(year, day, month)
        return result

    m = _DAY_MONTH_RE.match(text)
    if m and m.group(2).lower() in MONTHS:
        day, month = int(m.group(1)), MONTHS[m.group(2).lower()]
        year = _expand_year(m.group(3)) if m.group(3) else None
    else:
        m = _MONTH_DAY_RE.match(text)
        if m and m.group(1).lower() in MONTHS:
            month, day = MONTHS[m.group(1).lower()], int(m.group(2))
            year = _expand_year(m.group(3)) if m.group(3) else None
        else:
            m = _DAY_MONTH_NUMERIC_RE.match(text)
            if not m:
                return None
            a, b = int(m.group(1)), int(m.group(2))
            day, month = (a, b) if day_first else (b, a)
            if month > 12 and day <= 12:
                day, month = month, day
            year = None

    if year is None:
        year = infer_year(month, period_start=period_start, period_end=period_end, default_year=default_year)
        result = _safe_date(year, month, day)
        if result is None and month == 2 and day == 29:
            # 29 Feb on a non-leap inferred year: the neighbouring leap year is meant.
            for candidate in (year - 1, year + 1):
                result = _safe_date(candidate, month, day)
                if result:
                    break
        return result
    return _safe_date(year, month, day)


@dataclass(slots=True)
class DateContext:
    """Statement-level context reused for every date on a statement."""

    period_start: date | None = None
    period_end: date | None = None
    default_year: int | None = None
    day_first: bool = True

    def parse(self, value: object) -> date | None:
        return parse_date(
            value,
            period_start=self.period_start,
            period_end=self.period_end,
            default_year=self.default_year,
            day_first=self.day_first,
        )


def has_explicit_year(token: str) -> bool:
    """True when the date token spells out a year (``31/07/2026``, ``31 Jul 2026``)."""
    token = token.strip()
    return bool(
        _ISO_RE.match(token)
        or _NUMERIC_RE.match(token)
        or (_DAY_MONTH_RE.match(token) and _DAY_MONTH_RE.match(token).group(3))
        or (_MONTH_DAY_RE.match(token) and _MONTH_DAY_RE.match(token).group(3))
    )


def detect_day_first(tokens: list[str]) -> bool:
    """Decide whether numeric dates in a column are day-first (UK default).

    Only switches to month-first when some value is impossible day-first (second
    component above 12) and none is impossible month-first.
    """
    first_over, second_over = False, False
    for token in tokens:
        m = _NUMERIC_RE.match(str(token).strip()) or _DAY_MONTH_NUMERIC_RE.match(str(token).strip())
        if not m:
            continue
        a, b = int(m.group(1)), int(m.group(2))
        first_over |= a > 12
        second_over |= b > 12
    if second_over and not first_over:
        return False
    return True
