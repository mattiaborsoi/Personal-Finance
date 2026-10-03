"""Build synthetic statement files at runtime.

The generated PDFs/CSVs/XLSX are written into a caller-supplied directory (tests use
``tmp_path``); ``*.pdf``, ``*.csv`` and ``*.xlsx`` are git-ignored so nothing is ever
committed. Only sanitised values from ``config.example.yaml`` appear here.

Run ``python -m tests.fixtures.generate [dir]`` to build the set by hand (defaults to
``tests/fixtures/generated``).
"""

from __future__ import annotations

import csv
import sys
from datetime import datetime
from pathlib import Path

# Row tuples: (date as printed, description, amount as printed, extra token after the amount)
AMEX_ROWS: dict[str, list[tuple[str, str, str, str]]] = {
    "7715": [
        ("Jul 30", "PAYMENT RECEIVED - THANK YOU", "3,384.21", "CR"),
        ("Jul 31", "CINEWORLD", "20.99", ""),
        ("Aug 04", "ANTHROPIC", "18.40", "(USD 24.00)"),
        ("Aug 15", "WAITROSE", "15.81", ""),
        ("Aug 24", "BRITISH AIRWAYS", "357.99", "CR"),
    ],
    "3348": [
        ("Jul 28", "WAITROSE", "16.40", ""),
        ("Jul 30", "ZOOM OCADO", "37.89", ""),
        ("Aug 07", "NETFLIX", "5.99", ""),
    ],
}

# (date as printed, description, paid out, paid in, balance)
CHECKING_OPENING_BALANCE = "15,384.21"
CHECKING_ROWS: list[tuple[str, str, str, str, str]] = [
    ("28 Jul", "HSBC CARD PYMT", "3,384.21", "", "12,000.00"),
    ("01 Aug", "SALARY ACME", "", "4,500.00", "16,500.00"),
    ("03 Aug", "NORTHWIND ENERGY", "87.27", "", "16,412.73"),
    ("03 Aug", "FIBRELINE BROADBAND", "30.00", "", "16,382.73"),
    ("03 Aug", "PARTNER TRANSFER CR", "", "1,685.73", "18,068.46"),
    ("05 Aug", "ROBINHOOD", "500.00", "", "17,568.46"),
]
CHECKING_ROW_YEARS = 2026

# Fixture 3: recurring energy bill history for the auditor (checking-style CSV).
ENERGY_HISTORY_ROWS: list[tuple[str, str, str, str, str]] = [
    ("03/05/2026", "NORTHWIND ENERGY", "68.20", "", "9,931.80"),
    ("03/06/2026", "NORTHWIND ENERGY", "68.20", "", "9,863.60"),
    ("03/07/2026", "NORTHWIND ENERGY", "68.20", "", "9,795.40"),
    ("03/08/2026", "NORTHWIND ENERGY", "87.27", "", "9,708.13"),
]

_MONTHS = {"Jul": 7, "Aug": 8}


def _checking_csv_rows() -> list[tuple[str, str, str, str, str]]:
    """Checking rows with full UK-format dates (``28/07/2026``)."""
    out = []
    for printed, desc, paid_out, paid_in, balance in CHECKING_ROWS:
        day, mon = printed.split()
        out.append((f"{int(day):02d}/{_MONTHS[mon]:02d}/{CHECKING_ROW_YEARS}", desc, paid_out, paid_in, balance))
    return out


# --------------------------------------------------------------------------- #
# PDF helpers
# --------------------------------------------------------------------------- #


class _Canvas:
    """Tiny line-oriented wrapper around a reportlab canvas."""

    def __init__(self, path: Path) -> None:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas

        self.c = canvas.Canvas(str(path), pagesize=A4)
        self.width, self.height = A4
        self.y = self.height - 60

    def line(self, text: str, x: float = 50, size: float = 10, bold: bool = False) -> None:
        self.c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
        self.c.drawString(x, self.y, text)
        self.y -= 16

    def cells(self, left: list[tuple[float, str]], right: list[tuple[float, str]], bold: bool = False) -> None:
        self.c.setFont("Helvetica-Bold" if bold else "Helvetica", 10)
        for x, text in left:
            if text:
                self.c.drawString(x, self.y, text)
        for x, text in right:
            if text:
                self.c.drawRightString(x, self.y, text)
        self.y -= 16

    def gap(self, points: float = 8) -> None:
        self.y -= points

    def save(self) -> None:
        self.c.save()


def amex_statement_pdf(path: str | Path) -> Path:
    """Text-style card statement: two card sections, foreign spend, CR credits."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = _Canvas(path)
    pdf.line("American Express", size=14, bold=True)
    pdf.line("Statement of Account - Credit Card")
    pdf.line("Primary User")
    pdf.line("Statement period 29 July 2026 to 28 August 2026")
    pdf.line("Closing date 28 August 2026")
    pdf.line("Minimum payment due 25.00    Credit limit 10,000.00")
    pdf.gap()
    pdf.cells([(50, "Date"), (110, "Description")], [(450, "Amount")], bold=True)
    for card, heading in (("7715", "Card ending 7715"), ("3348", "Supplementary card ending 3348")):
        pdf.gap(4)
        pdf.line(heading, bold=True)
        for printed, desc, amount, extra in AMEX_ROWS[card]:
            pdf.cells([(50, printed), (110, desc), (458, extra)], [(450, amount)])
    pdf.gap()
    pdf.line("Total new charges 115.48")
    pdf.line("Closing balance 242.51 CR")
    pdf.line("Page 1 of 1")
    pdf.save()
    return path


# Virgin Money style: one section per card, each headed only by the cardholder's name and
# the full card number; two dates per line (transaction, posted), "£" amounts, a leading
# minus for credits. Synthetic names and numbers only.
VIRGIN_SECTIONS: list[tuple[str, list[tuple[str, str, str, str]]]] = [
    (
        "Primary User 0000 00000000 5502",
        [
            ("12 Aug 26", "14 Aug 26", "PAYMENT RECEIVED THANK YOU", "-£250.00"),
            ("15 Aug 26", "16 Aug 26", "WAITROSE LONDON", "£42.10"),
            ("18 Aug 26", "19 Aug 26", "TFL TRAVEL CHARGE", "£6.80"),
        ],
    ),
    (
        "Secondary User 0000 000000006617",
        [
            ("16 Aug 26", "17 Aug 26", "PRET A MANGER", "£8.45"),
            ("20 Aug 26", "21 Aug 26", "BOOTS THE CHEMIST", "£12.99"),
        ],
    ),
]


def virgin_statement_pdf(path: str | Path) -> Path:
    """Virgin Money style card statement with a main and a supplementary card section."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = _Canvas(path)
    pdf.line("Virgin Money credit card", size=14, bold=True)
    pdf.line("Statement period: 24/07/2026 - 23/08/2026")
    pdf.gap()
    pdf.line("Transactions on your card", bold=True)
    for heading, rows in VIRGIN_SECTIONS:
        pdf.gap(4)
        pdf.cells([(50, "Date"), (105, "Posted"), (160, "Description")], [(450, "Amount")], bold=True)
        pdf.line(heading, bold=True)
        for date_, posted, desc, amount in rows:
            pdf.cells([(50, date_), (105, posted), (160, desc)], [(450, amount)])
    pdf.gap()
    pdf.line("Your new balance £280.34")
    pdf.line("1 of 1")
    pdf.save()
    return path


def _checking_header(pdf: _Canvas) -> None:
    pdf.line("HSBC UK", size=14, bold=True)
    pdf.line("Current Account Statement")
    pdf.line("Primary User")
    pdf.line("Sort code 00-00-00    Account ending 4471")
    pdf.line("Statement period 01 July 2026 to 31 August 2026")
    pdf.gap()


def hsbc_checking_pdf(path: str | Path) -> Path:
    """Ruled-table checking statement (pdfplumber ``extract_tables`` friendly)."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    styles = getSampleStyleSheet()
    story = [
        Paragraph("HSBC UK", styles["Title"]),
        Paragraph("Current Account Statement", styles["Normal"]),
        Paragraph("Primary User", styles["Normal"]),
        Paragraph("Sort code 00-00-00 &nbsp;&nbsp; Account ending 4471", styles["Normal"]),
        Paragraph("Statement period 01 July 2026 to 31 August 2026", styles["Normal"]),
        Spacer(1, 12),
    ]
    data = [["Date", "Description", "Paid Out", "Paid In", "Balance"]]
    data.append(["", "Balance brought forward", "", "", CHECKING_OPENING_BALANCE])
    data.extend(list(row) for row in CHECKING_ROWS)
    table = Table(data, colWidths=[50, 200, 80, 80, 90])
    table.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
            ]
        )
    )
    story.append(table)
    story.append(Spacer(1, 12))
    story.append(Paragraph("Closing balance 17,568.46", styles["Normal"]))
    SimpleDocTemplate(str(path), pagesize=A4).build(story)
    return path


def hsbc_checking_text_pdf(path: str | Path) -> Path:
    """Same checking statement laid out as aligned columns without any ruling."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = _Canvas(path)
    _checking_header(pdf)
    pdf.cells([(50, "Date"), (110, "Description")], [(380, "Paid Out"), (460, "Paid In"), (545, "Balance")], bold=True)
    pdf.cells([(110, "Balance brought forward")], [(545, CHECKING_OPENING_BALANCE)])
    for printed, desc, paid_out, paid_in, balance in CHECKING_ROWS:
        pdf.cells([(50, printed), (110, desc)], [(380, paid_out), (460, paid_in), (545, balance)])
    pdf.gap()
    pdf.line("Closing balance 17,568.46")
    pdf.line("Page 1 of 1")
    pdf.save()
    return path


def prose_pdf(path: str | Path) -> Path:
    """A PDF containing only prose (no transaction lines, no tables)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = _Canvas(path)
    pdf.line("Important information about your account", size=12, bold=True)
    pdf.line("This document describes the terms that apply to your account.")
    pdf.line("It contains no transaction listing and is here to exercise the")
    pdf.line("language-model fallback of the statement extractor.")
    pdf.line("Thank you for banking with us.")
    pdf.save()
    return path


# --------------------------------------------------------------------------- #
# Tabular fixtures
# --------------------------------------------------------------------------- #

_CHECKING_COLUMNS = ["Date", "Description", "Paid Out", "Paid In", "Balance"]


def checking_csv(path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(_CHECKING_COLUMNS)
        writer.writerows(_checking_csv_rows())
    return path


def checking_xlsx(path: str | Path) -> Path:
    """Same rows as :func:`checking_csv` with real date and numeric cells."""
    from openpyxl import Workbook

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    wb = Workbook()
    ws = wb.active
    ws.title = "Statement"
    ws.append(_CHECKING_COLUMNS)
    for printed, desc, paid_out, paid_in, balance in _checking_csv_rows():
        ws.append(
            [
                datetime.strptime(printed, "%d/%m/%Y"),
                desc,
                float(paid_out.replace(",", "")) if paid_out else None,
                float(paid_in.replace(",", "")) if paid_in else None,
                float(balance.replace(",", "")),
            ]
        )
    ws.column_dimensions["A"].number_format = "DD/MM/YYYY"
    wb.save(str(path))
    return path


def energy_history_csv(path: str | Path) -> Path:
    """Monthly NORTHWIND ENERGY history (May-Aug 2026) as a checking-style CSV."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(_CHECKING_COLUMNS)
        writer.writerows(ENERGY_HISTORY_ROWS)
    return path


# --------------------------------------------------------------------------- #
# Convenience
# --------------------------------------------------------------------------- #

BUILDERS = {
    "amex_pdf": ("amex_7715_statement.pdf", amex_statement_pdf),
    "hsbc_table_pdf": ("hsbc_4471_statement_table.pdf", hsbc_checking_pdf),
    "hsbc_text_pdf": ("hsbc_4471_statement_text.pdf", hsbc_checking_text_pdf),
    "checking_csv": ("hsbc_4471_statement.csv", checking_csv),
    "checking_xlsx": ("hsbc_4471_statement.xlsx", checking_xlsx),
    "energy_history_csv": ("hsbc_4471_energy_history.csv", energy_history_csv),
    "prose_pdf": ("prose_only.pdf", prose_pdf),
}


def build_all(directory: str | Path) -> dict[str, Path]:
    """Build every fixture into ``directory``; returns ``{name: path}``."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    return {name: builder(directory / filename) for name, (filename, builder) in BUILDERS.items()}


if __name__ == "__main__":  # pragma: no cover
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "generated"
    for name, built in build_all(target).items():
        print(f"{name}: {built}")
