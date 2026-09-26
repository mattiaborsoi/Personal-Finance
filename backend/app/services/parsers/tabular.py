"""CSV / XLSX statement parser (pandas).

Header names are normalised (``Date``, ``Description``/``Details``/``Narrative``,
``Amount`` or ``Paid Out``/``Paid In`` or ``Debit``/``Credit`` or ``Money Out``/
``Money In``, ``Balance``, ``Currency`` ...). Debit columns give negative amounts and
credit columns positive ones. Numeric dates are read day-first (UK) unless the data
proves otherwise. Preamble lines above the header row are skipped.
"""

from __future__ import annotations

import csv
import io
from dataclasses import replace
from pathlib import Path
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
from app.services.parsers.dates import detect_day_first
from app.services.parsers.metadata import date_context, detect_metadata, fill_gaps


def _read_csv_rows(path: Path) -> list[list[Any]]:
    import pandas as pd

    raw = path.read_bytes()
    text: str | None = None
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:  # pragma: no cover - latin-1 never fails
        raise ParseError("could not decode CSV file")
    lines = text.splitlines()
    if not any(line.strip() for line in lines):
        raise ParseError("CSV file is empty")

    # Locate the header row with the csv module (tolerates ragged preamble lines).
    delimiter = ","
    header_idx: int | None = None
    for idx, line in enumerate(lines[:50]):
        if not line.strip():
            continue
        try:
            delim = csv.Sniffer().sniff(line, delimiters=",;\t|").delimiter
        except csv.Error:
            delim = ","
        cells = next(csv.reader([line], delimiter=delim))
        if len(cells) >= 2 and find_header_row([cells]) == 0:
            delimiter, header_idx = delim, idx
            break
    if header_idx is None:
        raise ParseError("no header row with Date and Amount/Paid Out/Paid In columns found in CSV")

    frame = pd.read_csv(
        io.StringIO("\n".join(lines[header_idx:])),
        header=None,
        dtype=str,
        sep=delimiter,
        engine="python",
        keep_default_na=False,
        skip_blank_lines=True,
        on_bad_lines="skip",
    ).fillna("")
    return frame.values.tolist()


def _read_excel_rows(path: Path) -> list[list[Any]]:
    import pandas as pd

    try:
        frame = pd.read_excel(path, header=None, dtype=object)
    except Exception as exc:  # openpyxl / xlrd errors
        raise ParseError(f"could not read spreadsheet: {exc}") from exc
    rows = frame.values.tolist()
    return [[None if (isinstance(v, float) and v != v) else v for v in row] for row in rows]


class TabularParser:
    """Parser for ``.csv`` / ``.xlsx`` / ``.xls`` exports."""

    name = "tabular"

    def __init__(self, config: AppConfig | None = None, metadata: StatementMetadata | None = None) -> None:
        self.config = config
        self.metadata = metadata

    def can_parse(self, doc: StatementDocument) -> bool:
        return doc.is_tabular

    def read_rows(self, doc: StatementDocument) -> list[list[Any]]:
        if doc.suffix == ".csv":
            return _read_csv_rows(doc.path)
        return _read_excel_rows(doc.path)

    def parse(self, doc: StatementDocument) -> ParsedStatement:
        meta = replace(self.metadata) if self.metadata else detect_metadata(doc, self.config)
        rows = self.read_rows(doc)
        header_idx = find_header_row(rows)
        if header_idx is None:
            raise ParseError("no header row with Date and Amount/Paid Out/Paid In columns found")
        columns = map_columns(rows[header_idx])
        body = rows[header_idx + 1 :]
        warnings: list[str] = []

        ctx = date_context(meta)
        date_col = columns["date"]
        ctx.day_first = detect_day_first([clean_cell(r[date_col]) for r in body if date_col < len(r)])

        # Single "Amount" column: card-style (unmarked = charge) when the account is a
        # card or the column uses CR/DR markers; otherwise signed at face value.
        if "amount" in columns:
            has_markers = markers_present(body, [columns["amount"]])
            has_negatives = explicit_negatives_present(body, [columns["amount"]])
            plain_is_debit = meta.account_type_hint == "credit" or (has_markers and not has_negatives)
        else:
            plain_is_debit = False

        parser = TableRowParser(
            columns=columns,
            dates=ctx,
            plain_is_debit=plain_is_debit,
            base_currency=(self.config.app.base_currency if self.config else "GBP"),
        )
        transactions, last_balance, notes = parse_rows(body, parser)
        warnings.extend(notes[:10])
        if len(notes) > 10:
            warnings.append(f"{len(notes) - 10} further rows skipped")
        if not transactions:
            raise ParseError("no transaction rows found under the header")

        derived_hint = "checking" if ("debit" in columns or "credit" in columns) else None
        fill_gaps(meta, transactions, hint=derived_hint, closing_balance=last_balance)
        return ParsedStatement(metadata=meta, transactions=transactions, parser_name=self.name, warnings=warnings)
