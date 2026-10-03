"""Synthetic statement fixtures.

Nothing binary is committed: :mod:`tests.fixtures.generate` builds the PDF / CSV /
XLSX files at runtime (``build_all(tmp_path)``) from the sanitised values of
``config.example.yaml`` (placeholder suppliers, randomised card digits).
"""

from tests.fixtures.generate import (
    AMEX_ROWS,
    CHECKING_ROWS,
    ENERGY_HISTORY_ROWS,
    amex_statement_pdf,
    build_all,
    checking_csv,
    checking_xlsx,
    energy_history_csv,
    hsbc_checking_pdf,
    hsbc_checking_text_pdf,
    prose_pdf,
)

__all__ = [
    "AMEX_ROWS",
    "CHECKING_ROWS",
    "ENERGY_HISTORY_ROWS",
    "amex_statement_pdf",
    "build_all",
    "checking_csv",
    "checking_xlsx",
    "energy_history_csv",
    "hsbc_checking_pdf",
    "hsbc_checking_text_pdf",
    "prose_pdf",
]
