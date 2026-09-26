"""Amount parsing for statement text.

Handles ``3,384.21``, ``-357.99``, ``357.99 CR``, ``(24.00)``, ``£15.81``,
``15.81-`` and ``24.00 DR``. Foreign spend printed next to an amount
(``(USD 24.00)``, ``USD 24.00``, ``24.00 USD``) is recognised for a curated list of
ISO 4217 codes so that ordinary three-letter words in merchant names are ignored.

All values are ``Decimal`` rounded ``ROUND_HALF_UP`` to two places.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

TWO_PLACES = Decimal("0.01")

# Common ISO 4217 codes. Codes that are also ordinary English words (ALL, TOP, CUP,
# PEN, GEL, ...) are left out on purpose.
CURRENCY_CODES: frozenset[str] = frozenset(
    {
        "GBP", "USD", "EUR", "CHF", "JPY", "AUD", "CAD", "NZD", "SEK", "NOK", "DKK", "PLN",
        "CZK", "HUF", "HKD", "SGD", "INR", "ZAR", "AED", "THB", "MXN", "BRL", "CNY", "KRW",
        "TRY", "ILS", "RON", "BGN", "ISK", "MYR", "IDR", "PHP", "TWD", "SAR", "QAR", "EGP",
        "MAD", "VND", "ARS", "CLP", "COP", "PEN", "KES", "NGN", "TND", "LKR", "MUR", "BHD",
        "KWD", "OMR", "JOD", "UAH", "RSD", "GEL",
    }
)  # fmt: skip

_MINUS = r"[-−–]"  # hyphen-minus, minus sign, en dash
_NUMBER = r"\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?"

_CELL_RE = re.compile(
    rf"""
    ^\s*
    (?P<neg1>{_MINUS})?\s*
    (?P<paren>\()?\s*
    (?:[£$€]|GBP)?\s*
    (?P<neg2>{_MINUS})?\s*
    (?P<num>{_NUMBER})
    \s*(?(paren)\))
    (?P<neg3>{_MINUS})?
    \s*(?P<marker>CR|DR)?\.?
    \s*$
    """,
    re.IGNORECASE | re.VERBOSE,
)

# An amount at the end of a free-text line (two decimals required so that reference
# numbers inside descriptions are not mistaken for money).
_TRAILING_TOKEN = rf"{_MINUS}?\(?[£$€]?{_MINUS}?\d[\d,]*\.\d{{2}}\)?{_MINUS}?(?:\s*(?:CR|DR)(?![A-Za-z]))?"
TRAILING_AMOUNT_RE = re.compile(rf"(?:^|(?<=\s))(?P<token>{_TRAILING_TOKEN})\s*$", re.IGNORECASE)
AMOUNT_TOKEN_RE = re.compile(rf"(?:^|(?<=\s))(?P<token>{_TRAILING_TOKEN})(?=\s|$)", re.IGNORECASE)

_FX_NUMBER = r"\d[\d,]*(?:\.\d{1,2})?"
FOREIGN_RE = re.compile(
    rf"""
    \(?\s*
    (?:
        (?<![A-Za-z0-9])(?P<cur1>[A-Z]{{3}})\s?(?P<amt1>{_FX_NUMBER})(?![\d.])
      | (?<![\d.,])(?P<amt2>{_FX_NUMBER})\s?(?P<cur2>[A-Z]{{3}})(?![A-Za-z0-9])
    )
    \s*\)?
    """,
    re.VERBOSE,
)


def quantize(value: Decimal | int | float | str) -> Decimal:
    """Round to two decimal places, half up. ``-0.00`` is normalised to ``0.00``."""
    result = Decimal(str(value)).quantize(TWO_PLACES, rounding=ROUND_HALF_UP)
    return result if result != 0 else Decimal("0.00")


@dataclass(slots=True)
class AmountParts:
    """A printed amount before the statement's sign convention is applied."""

    magnitude: Decimal
    explicit_negative: bool = False  # leading/trailing minus or parentheses
    marker: str | None = None  # "CR" | "DR" | None

    @property
    def signed(self) -> Decimal:
        """Sign taken at face value: ``CR`` positive, ``DR``/minus/parentheses negative."""
        if self.marker == "CR":
            return self.magnitude
        if self.marker == "DR" or self.explicit_negative:
            return -self.magnitude
        return self.magnitude

    def apply(self, *, plain_is_debit: bool) -> Decimal:
        """Resolve the ledger sign (negative = money out).

        ``plain_is_debit`` describes the statement style: on card statements (and most
        printed statements) an unmarked amount is a charge, and any credit marker
        (``CR``, a minus sign, parentheses) means money in. In a signed column
        (``-30.00`` / ``4,500.00``) the sign is taken at face value.
        """
        if self.marker == "CR":
            return self.magnitude
        if self.marker == "DR":
            return -self.magnitude
        if plain_is_debit:
            return self.magnitude if self.explicit_negative else -self.magnitude
        return -self.magnitude if self.explicit_negative else self.magnitude


def parse_amount_parts(value: object) -> AmountParts | None:
    """Parse one amount cell/token; ``None`` when it is not an amount."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float | Decimal):
        try:
            magnitude = quantize(abs(Decimal(str(value))))
        except InvalidOperation:
            return None
        return AmountParts(magnitude=magnitude, explicit_negative=Decimal(str(value)) < 0)
    text = str(value).strip()
    if not text:
        return None
    m = _CELL_RE.match(text)
    if not m:
        return None
    try:
        magnitude = quantize(m.group("num").replace(",", ""))
    except InvalidOperation:
        return None
    negative = bool(m.group("neg1") or m.group("neg2") or m.group("neg3") or m.group("paren"))
    marker = m.group("marker").upper() if m.group("marker") else None
    return AmountParts(magnitude=magnitude, explicit_negative=negative, marker=marker)


def parse_amount(value: object) -> Decimal | None:
    """Signed amount at face value (``CR`` positive, minus/parentheses/``DR`` negative)."""
    parts = parse_amount_parts(value)
    return parts.signed if parts else None


@dataclass(slots=True)
class ForeignSpend:
    currency: str
    amount: Decimal


def find_foreign_spend(text: str, base_currency: str = "GBP") -> tuple[int, int, ForeignSpend] | None:
    """Locate foreign spend such as ``(USD 24.00)`` in ``text``.

    Returns ``(start, end, spend)`` for the first match with a known currency code
    other than the base currency, or ``None``.
    """
    base = (base_currency or "GBP").upper()
    for m in FOREIGN_RE.finditer(text):
        currency = (m.group("cur1") or m.group("cur2") or "").upper()
        if currency not in CURRENCY_CODES or currency == base:
            continue
        raw = m.group("amt1") or m.group("amt2")
        try:
            amount = quantize(raw.replace(",", ""))
        except InvalidOperation:
            continue
        return m.start(), m.end(), ForeignSpend(currency=currency, amount=amount)
    return None


def extract_foreign_spend(text: str, base_currency: str = "GBP") -> tuple[str, ForeignSpend | None]:
    """Like :func:`find_foreign_spend` but returns the text with the spend removed
    (whitespace collapsed) and the spend, or the original text and ``None``."""
    found = find_foreign_spend(text, base_currency)
    if found is None:
        return text, None
    start, end, spend = found
    cleaned = " ".join((text[:start] + " " + text[end:]).split())
    return cleaned, spend
