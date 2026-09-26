"""Shared types for statement parsing.

Sign convention (matches the ledger): **negative = money out (debit / charge),
positive = money in (credit / refund / payment received)** regardless of whether
the source is a checking statement ("Paid Out"/"Paid In") or a card statement
(charges vs "CR" lines).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from functools import cached_property
from pathlib import Path
from typing import Any, Protocol, runtime_checkable


class ParseError(ValueError):
    """The document could not be parsed by the chosen parser."""


@dataclass(slots=True)
class ParsedTransaction:
    date: date
    raw_text: str
    amount: Decimal
    post_date: date | None = None
    card_last4: str | None = None
    foreign_amount: Decimal | None = None
    foreign_currency: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "date": self.date.isoformat(),
            "post_date": self.post_date.isoformat() if self.post_date else None,
            "raw_text": self.raw_text,
            "amount": float(self.amount),
            "card_last4": self.card_last4,
            "foreign_spend": (
                {"amount": float(self.foreign_amount), "currency": self.foreign_currency}
                if self.foreign_amount is not None
                else None
            ),
        }


@dataclass(slots=True)
class StatementMetadata:
    institution: str | None = None
    account_last4: str | None = None
    closing_date: date | None = None
    period_start: date | None = None
    period_end: date | None = None
    closing_balance: Decimal | None = None
    account_type_hint: str | None = None  # "credit" | "checking" | None

    def to_dict(self) -> dict[str, Any]:
        period = None
        if self.period_start and self.period_end:
            period = f"{self.period_start.isoformat()} to {self.period_end.isoformat()}"
        return {
            "institution": self.institution,
            "account_last4": self.account_last4,
            "closing_date": self.closing_date.isoformat() if self.closing_date else None,
            "statement_period": period,
            "closing_balance": float(self.closing_balance) if self.closing_balance is not None else None,
        }


@dataclass(slots=True)
class ParsedStatement:
    metadata: StatementMetadata
    transactions: list[ParsedTransaction]
    parser_name: str
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "statement_metadata": self.metadata.to_dict(),
            "transactions": [t.to_dict() for t in self.transactions],
            "parser": self.parser_name,
            "warnings": list(self.warnings),
        }


class StatementDocument:
    """Lazy view over an uploaded file: raw bytes, extracted text pages and tables."""

    def __init__(self, path: str | Path, filename: str | None = None) -> None:
        self.path = Path(path)
        self.filename = filename or self.path.name

    @property
    def suffix(self) -> str:
        return self.path.suffix.lower()

    @property
    def is_pdf(self) -> bool:
        return self.suffix == ".pdf"

    @property
    def is_tabular(self) -> bool:
        return self.suffix in (".csv", ".xlsx", ".xls")

    @cached_property
    def raw_bytes(self) -> bytes:
        return self.path.read_bytes()

    @cached_property
    def text_pages(self) -> list[str]:
        """Text of each PDF page (empty list for non-PDF files)."""
        if not self.is_pdf:
            return []
        import pdfplumber

        pages: list[str] = []
        with pdfplumber.open(str(self.path)) as pdf:
            for page in pdf.pages:
                pages.append(page.extract_text() or "")
        return pages

    @cached_property
    def tables(self) -> list[list[list[str | None]]]:
        """All tables detected by pdfplumber across pages (empty for non-PDF files)."""
        if not self.is_pdf:
            return []
        import pdfplumber

        out: list[list[list[str | None]]] = []
        with pdfplumber.open(str(self.path)) as pdf:
            for page in pdf.pages:
                for table in page.extract_tables() or []:
                    if table:
                        out.append(table)
        return out

    @property
    def full_text(self) -> str:
        return "\n".join(self.text_pages)


@runtime_checkable
class StatementParser(Protocol):
    name: str

    def can_parse(self, doc: StatementDocument) -> bool: ...

    def parse(self, doc: StatementDocument) -> ParsedStatement: ...
