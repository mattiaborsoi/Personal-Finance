"""Column-oriented parsing shared by the CSV/XLSX parser and the PDF table parser.

Header cells are normalised and mapped onto roles (``date``, ``description``,
``amount``, ``debit``, ``credit``, ``balance`` ...); :class:`TableRowParser` then
turns each body row into a :class:`ParsedTransaction`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from app.services.parsers.amounts import AmountParts, extract_foreign_spend, parse_amount_parts, quantize
from app.services.parsers.base import ParsedTransaction
from app.services.parsers.dates import DateContext

ROLE_ALIASES: dict[str, tuple[str, ...]] = {
    "post_date": (
        "post date", "posted date", "posting date", "processed date", "date processed", "settled date",
        "settlement date",
    ),
    "date": (
        "date", "transaction date", "trans date", "txn date", "date of transaction", "value date",
        "payment date", "booking date",
    ),
    "description": (
        "description", "details", "narrative", "merchant", "transaction", "transaction description",
        "transaction details", "memo", "payee", "name", "reference", "particulars", "payment type and details",
        "counter party", "counterparty",
    ),
    "amount": ("amount", "value", "amount gbp", "transaction amount", "net amount", "amount £"),
    "debit": (
        "paid out", "debit", "debits", "money out", "withdrawal", "withdrawals", "out", "debit amount", "spent",
        "payments out", "amount out",
    ),
    "credit": (
        "paid in", "credit", "credits", "money in", "deposit", "deposits", "in", "credit amount", "received",
        "payments in", "amount in",
    ),
    "balance": ("balance", "running balance", "closing balance", "balance gbp"),
    "currency": ("currency", "ccy", "transaction currency"),
    "foreign_amount": (
        "foreign amount", "original amount", "foreign currency amount", "amount in foreign currency",
        "local amount",
    ),
    "foreign_currency": ("foreign currency", "original currency", "local currency"),
    "card_last4": ("card", "card number", "card ending", "card last 4", "last4", "card no"),
    "type": ("type", "transaction type", "dr/cr", "cr/dr", "d/c"),
}  # fmt: skip

_PREFIX_ROLES: tuple[tuple[str, str], ...] = (
    ("paid out", "debit"),
    ("money out", "debit"),
    ("debit", "debit"),
    ("withdrawal", "debit"),
    ("paid in", "credit"),
    ("money in", "credit"),
    ("credit", "credit"),
    ("deposit", "credit"),
    ("balance", "balance"),
    ("post", "post_date"),
    ("date", "date"),
    ("description", "description"),
    ("details", "description"),
    ("narrative", "description"),
    ("amount", "amount"),
)

MONEY_ROLES = ("amount", "debit", "credit", "balance")

# Undated rows that are never part of a description (opening/closing balance rows, totals).
_CONTINUATION_NOISE_RE = re.compile(
    r"(?i)^(?:balance|total|closing|opening|carried|brought|statement|page\s|subtotal|interest)"
)


def normalise_header(cell: object) -> str:
    """Lower-case, strip currency symbols/punctuation and collapse whitespace."""
    text = "" if cell is None else str(cell)
    text = text.replace("\n", " ").replace("_", " ").lower()
    text = re.sub(r"[£$€():.#]", " ", text)
    return " ".join(text.split())


def header_role(cell: object) -> str | None:
    norm = normalise_header(cell)
    if not norm:
        return None
    for role, aliases in ROLE_ALIASES.items():
        if norm in aliases:
            return role
    for prefix, role in _PREFIX_ROLES:
        if norm.startswith(prefix):
            return role
    return None


def map_columns(cells: list[Any]) -> dict[str, int]:
    """Map roles to column indexes (first column wins for a repeated role)."""
    roles: dict[str, int] = {}
    for idx, cell in enumerate(cells):
        role = header_role(cell)
        if role and role not in roles:
            roles[role] = idx
    if "description" not in roles:
        taken = set(roles.values())
        for idx, cell in enumerate(cells):
            if idx not in taken and str(cell or "").strip():
                roles["description"] = idx
                break
    return roles


def looks_like_header(cells: list[Any]) -> bool:
    roles = map_columns(cells)
    return "date" in roles and any(r in roles for r in ("amount", "debit", "credit"))


def find_header_row(rows: list[list[Any]], max_scan: int = 30) -> int | None:
    for idx, row in enumerate(rows[:max_scan]):
        if looks_like_header(row):
            return idx
    return None


def clean_cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value != value:  # NaN
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return " ".join(str(value).split())


def markers_present(rows: list[list[Any]], indexes: list[int]) -> bool:
    """True when any amount cell carries a ``CR``/``DR`` marker."""
    for row in rows:
        for idx in indexes:
            if idx < len(row):
                parts = parse_amount_parts(clean_cell(row[idx]))
                if parts and parts.marker:
                    return True
    return False


def explicit_negatives_present(rows: list[list[Any]], indexes: list[int]) -> bool:
    for row in rows:
        for idx in indexes:
            if idx < len(row):
                parts = parse_amount_parts(clean_cell(row[idx]))
                if parts and parts.explicit_negative:
                    return True
    return False


def last4_from_cell(value: object) -> str | None:
    digits = re.findall(r"\d", clean_cell(value))
    if len(digits) >= 4:
        return "".join(digits[-4:])
    return None


@dataclass(slots=True)
class RowResult:
    kind: str  # "transaction" | "continuation" | "skip"
    transaction: ParsedTransaction | None = None
    text: str = ""
    balance: Decimal | None = None
    note: str | None = None


@dataclass(slots=True)
class TableRowParser:
    """Turns body rows into transactions given a role -> column index map.

    ``plain_is_debit`` governs a single ``amount`` column: true for card-style
    statements (unmarked amounts are charges), false for signed columns.
    """

    columns: dict[str, int]
    dates: DateContext
    plain_is_debit: bool = False
    base_currency: str = "GBP"
    notes: list[str] = field(default_factory=list)

    def _cell(self, row: list[Any], role: str) -> str:
        idx = self.columns.get(role)
        if idx is None or idx >= len(row):
            return ""
        return clean_cell(row[idx])

    def _raw(self, row: list[Any], role: str) -> Any:
        idx = self.columns.get(role)
        if idx is None or idx >= len(row):
            return None
        return row[idx]

    def _amount(self, row: list[Any]) -> tuple[Decimal | None, str | None]:
        """Return the signed amount and any note about how it was derived."""
        if "debit" in self.columns or "credit" in self.columns:
            debit = parse_amount_parts(self._cell(row, "debit"))
            credit = parse_amount_parts(self._cell(row, "credit"))
            if debit and debit.magnitude != 0:
                return -debit.magnitude, None
            if credit and credit.magnitude != 0:
                return credit.magnitude, None
            if debit or credit:
                return Decimal("0.00"), None
            if "amount" not in self.columns:
                return None, None
        parts = parse_amount_parts(self._cell(row, "amount"))
        if parts is None:
            return None, None
        amount = parts.apply(plain_is_debit=self.plain_is_debit)
        type_cell = self._cell(row, "type").upper()
        if type_cell in ("DR", "D", "DEBIT", "DB"):
            amount = -parts.magnitude
        elif type_cell in ("CR", "C", "CREDIT"):
            amount = parts.magnitude
        return amount, None

    def parse_row(self, row: list[Any]) -> RowResult:
        cells = [clean_cell(c) for c in row]
        if not any(cells):
            return RowResult(kind="skip")
        if looks_like_header(row):
            return RowResult(kind="skip", note="header")

        txn_date = self.dates.parse(self._raw(row, "date"))
        description = self._cell(row, "description")
        amount, _ = self._amount(row)
        balance_parts = parse_amount_parts(self._cell(row, "balance"))
        balance = balance_parts.signed if balance_parts else None

        if txn_date is None:
            if amount is None and description:
                return RowResult(kind="continuation", text=description, balance=balance)
            return RowResult(kind="skip", balance=balance, note=f"row without a date: {' | '.join(cells)[:80]}")
        if amount is None:
            return RowResult(kind="skip", balance=balance, note=f"row without an amount: {' | '.join(cells)[:80]}")

        post_date = self.dates.parse(self._raw(row, "post_date")) if "post_date" in self.columns else None

        description, foreign = extract_foreign_spend(description, self.base_currency)
        foreign_amount = foreign.amount if foreign else None
        foreign_currency = foreign.currency if foreign else None
        fx_amount = parse_amount_parts(self._cell(row, "foreign_amount"))
        fx_currency = self._cell(row, "foreign_currency").upper() or self._cell(row, "currency").upper()
        if fx_amount and fx_currency and fx_currency != self.base_currency.upper():
            foreign_amount, foreign_currency = fx_amount.magnitude, fx_currency[:3]
        # A foreign spend may also be printed inside the amount cell ("18.40 (USD 24.00)").
        if foreign_amount is None:
            _, foreign = extract_foreign_spend(self._cell(row, "amount"), self.base_currency)
            if foreign:
                foreign_amount, foreign_currency = foreign.amount, foreign.currency

        txn = ParsedTransaction(
            date=txn_date,
            post_date=post_date,
            raw_text=description,
            amount=quantize(amount),
            card_last4=last4_from_cell(self._raw(row, "card_last4")) if "card_last4" in self.columns else None,
            foreign_amount=foreign_amount,
            foreign_currency=foreign_currency,
        )
        return RowResult(kind="transaction", transaction=txn, balance=balance)


def parse_rows(
    rows: list[list[Any]],
    parser: TableRowParser,
) -> tuple[list[ParsedTransaction], Decimal | None, list[str]]:
    """Run ``parser`` over body rows, appending continuation rows to the previous
    transaction. Returns transactions, the last balance seen and notes."""
    transactions: list[ParsedTransaction] = []
    last_balance: Decimal | None = None
    notes: list[str] = []
    previous: ParsedTransaction | None = None
    for row in rows:
        result = parser.parse_row(row)
        if result.balance is not None:
            last_balance = result.balance
        if result.kind == "transaction" and result.transaction is not None:
            transactions.append(result.transaction)
            previous = result.transaction
        elif result.kind == "continuation" and previous is not None and not _CONTINUATION_NOISE_RE.match(result.text):
            previous.raw_text = " ".join(f"{previous.raw_text} {result.text}".split())
        else:
            previous = None
            if result.note and result.note != "header":
                notes.append(result.note)
    return transactions, last_balance, notes


def signed_from_parts(parts: AmountParts, plain_is_debit: bool) -> Decimal:
    return parts.apply(plain_is_debit=plain_is_debit)
