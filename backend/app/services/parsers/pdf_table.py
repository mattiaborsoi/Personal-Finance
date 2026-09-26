"""PDF table parser (pdfplumber ``extract_tables``).

Handles ruled statement tables whose header row contains ``Date`` plus
``Description``/``Details`` plus ``Amount`` or ``Paid Out``/``Paid In`` or
``Debit``/``Credit``. A table without a header row that has the same column count as
the previous table is treated as its continuation (tables split across pages).
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from app.config import AppConfig
from app.services.parsers.base import ParsedStatement, ParseError, StatementDocument, StatementMetadata
from app.services.parsers.columns import (
    TableRowParser,
    clean_cell,
    explicit_negatives_present,
    find_header_row,
    map_columns,
    markers_present,
    parse_rows,
)
from app.services.parsers.metadata import date_context, detect_metadata, fill_gaps


class PdfTableParser:
    name = "pdf_table"

    def __init__(self, config: AppConfig | None = None, metadata: StatementMetadata | None = None) -> None:
        self.config = config
        self.metadata = metadata

    def can_parse(self, doc: StatementDocument) -> bool:
        return doc.is_pdf and bool(doc.tables)

    def parse(self, doc: StatementDocument) -> ParsedStatement:
        meta = replace(self.metadata) if self.metadata else detect_metadata(doc, self.config)
        ctx = date_context(meta)
        base_currency = self.config.app.base_currency if self.config else "GBP"

        # Group tables into (columns, body rows) segments, carrying headers across pages.
        segments: list[tuple[dict[str, int], list[list[Any]]]] = []
        columns: dict[str, int] | None = None
        width = 0
        for table in doc.tables:
            rows = [[clean_cell(c) for c in row] for row in table if row]
            if not rows:
                continue
            header_idx = find_header_row(rows)
            if header_idx is not None:
                columns = map_columns(rows[header_idx])
                width = len(rows[header_idx])
                segments.append((columns, rows[header_idx + 1 :]))
            elif columns is not None and len(rows[0]) == width:
                segments.append((columns, rows))
        if not segments:
            raise ParseError("no table with Date and Amount/Paid Out/Paid In columns found")

        all_rows = [row for _, body in segments for row in body]
        all_columns = segments[0][0]
        if "amount" in all_columns:
            amount_idx = [cols["amount"] for cols, _ in segments if "amount" in cols]
            plain_is_debit = meta.account_type_hint == "credit" or (
                markers_present(all_rows, amount_idx) and not explicit_negatives_present(all_rows, amount_idx)
            )
        else:
            plain_is_debit = False

        transactions = []
        warnings: list[str] = []
        last_balance = None
        for cols, body in segments:
            parser = TableRowParser(columns=cols, dates=ctx, plain_is_debit=plain_is_debit, base_currency=base_currency)
            txns, balance, notes = parse_rows(body, parser)
            transactions.extend(txns)
            if balance is not None:
                last_balance = balance
            warnings.extend(notes)
        if not transactions:
            raise ParseError("statement tables contain no transaction rows")
        warnings = warnings[:10]

        derived_hint = "checking" if ("debit" in all_columns or "credit" in all_columns) else None
        fill_gaps(meta, transactions, hint=derived_hint, closing_balance=last_balance)
        return ParsedStatement(metadata=meta, transactions=transactions, parser_name=self.name, warnings=warnings)
