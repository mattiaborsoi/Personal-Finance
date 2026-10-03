"""Parser selection and the public ``parse_statement`` entry point.

Strategy: try deterministic parsers in order (tabular files, pdfplumber tables,
text-line regexes). If none yields transactions, try a layout learnt earlier for
this kind of statement (``app.services.layouts``, no AI); failing that, fall back to
the LLM layout extractor (Agent 1) when an LLM is available, and learn the layout
from its answer for next time; otherwise raise ``ParseError``.

For PDFs both the table and the text parser run and the one that found the most
transactions wins (the table parser on a tie). Nothing is de-duplicated here: the
ingestion pipeline fingerprints lines itself.
"""

from __future__ import annotations

import logging
from pathlib import Path

from app.config import AccountConfig, AppConfig
from app.services import layouts as layout_store
from app.services.llm import LLMClient, LLMError
from app.services.parsers.base import ParsedStatement, ParseError, StatementDocument, StatementMetadata
from app.services.parsers.llm_extractor import LLMLayoutExtractor
from app.services.parsers.metadata import detect_metadata
from app.services.parsers.pdf_table import PdfTableParser
from app.services.parsers.pdf_text import PdfTextParser
from app.services.parsers.tabular import TabularParser

log = logging.getLogger(__name__)

SUPPORTED_SUFFIXES = (".pdf", ".csv", ".xlsx", ".xls")
MAX_PDF_PAGES = 60  # a statement is a handful of pages; larger uploads are refused up front
CARD_ACCOUNT_TYPES = ("credit", "credit_supplementary")


def parse_statement(
    path: str | Path,
    config: AppConfig,
    llm: LLMClient | None = None,
    filename: str | None = None,
    account: AccountConfig | None = None,
    layouts: layout_store.LayoutStore | None = None,
) -> ParsedStatement:
    """Parse an uploaded statement file into a :class:`ParsedStatement`.

    ``config`` is used to recognise institutions / account last-4 identifiers in the
    document; the caller (ingestion) maps ``metadata.account_last4`` to an account.
    ``account`` is the account the caller already knows the file belongs to; its type
    supplies the sign convention (card exports print charges as positive numbers)
    when the document itself gives no hint. ``layouts`` is where learnt PDF layouts
    are looked up and saved (none: nothing is learnt or replayed).

    Every transaction carries ``card_last4`` where possible: the card section it was
    printed under, else the statement's ``account_last4``. Amounts are ``Decimal``
    with two places, negative = money out. Raises :class:`ParseError` when no parser
    (including the LLM fallback, if one is available) finds any transactions.
    """
    doc = StatementDocument(path, filename)
    if not doc.path.is_file():
        raise ParseError(f"file not found: {doc.path}")
    if doc.suffix not in SUPPORTED_SUFFIXES:
        raise ParseError(
            f"unsupported file type {doc.suffix or '(none)'!r} for {doc.filename}; "
            f"expected one of {', '.join(SUPPORTED_SUFFIXES)}"
        )
    try:
        metadata = detect_document(doc, config)
    except Exception as exc:  # unreadable / corrupt file
        raise ParseError(f"could not read {doc.filename}: {exc.__class__.__name__}: {exc}") from exc
    if doc.is_pdf and len(doc.text_pages) > MAX_PDF_PAGES:
        raise ParseError(
            f"{doc.filename} has {len(doc.text_pages)} pages (limit {MAX_PDF_PAGES}); "
            "upload one statement at a time"
        )
    sign_warning: str | None = None
    if metadata.account_type_hint is None and account is not None:
        metadata.account_type_hint = "credit" if account.account_type in CARD_ACCOUNT_TYPES else "checking"
    elif metadata.account_type_hint is None and doc.is_tabular:
        sign_warning = (
            "could not tell whether this is a card or a current-account export; amounts were read "
            "at face value (negative = money out). Pass account_id if the signs look inverted."
        )

    parsers: list =[TabularParser(config, metadata)] if doc.is_tabular else [
        PdfTableParser(config, metadata),
        PdfTextParser(config, metadata),
    ]
    results: list[ParsedStatement] = []
    notes: list[str] = []
    for parser in parsers:
        try:
            if not parser.can_parse(doc):
                notes.append(f"{parser.name}: not applicable")
                continue
            result = parser.parse(doc)
        except ParseError as exc:
            notes.append(f"{parser.name}: {exc}")
            continue
        except Exception as exc:  # a parser bug must not take the upload down
            log.exception("parser %s failed on %s", parser.name, doc.filename)
            notes.append(f"{parser.name}: unexpected error ({exc.__class__.__name__}: {exc})")
            continue
        if result.transactions:
            results.append(result)
        else:
            notes.append(f"{parser.name}: no transactions found")

    best: ParsedStatement | None = None
    if results:
        # Most transactions wins; ``max`` keeps the first (more structured) parser on a tie.
        best = max(results, key=lambda r: len(r.transactions))
        for other in results:
            if other is not best and len(other.transactions) != len(best.transactions):
                best.warnings.append(
                    f"{other.parser_name} found {len(other.transactions)} transaction(s) "
                    f"vs {len(best.transactions)} from {best.parser_name}; using {best.parser_name}"
                )
    elif doc.is_pdf and layouts is not None and (replayed := _replay(doc, config, metadata, layouts)):
        best = replayed
        best.warnings.insert(0, "deterministic parsers found no transactions; used a layout learnt earlier (no AI)")
    elif llm is not None and llm.available and doc.is_pdf:
        # Only PDFs go to the LLM: a spreadsheet the tabular parser rejects is not a
        # statement layout problem, and raw bytes must never be fed to a model.
        extractor = LLMLayoutExtractor(llm, config, metadata)
        try:
            if extractor.can_parse(doc):
                best = extractor.parse(doc)
                best.warnings.insert(0, "deterministic parsers found no transactions; used LLM layout extraction")
                if layouts is not None:
                    learnt = layout_store.learn_layout(doc, best, llm, config, metadata, layouts)
                    if learnt is not None:
                        best.warnings.append("the layout of this statement was learnt: next time it is read without AI")
            else:
                notes.append("llm_layout: document has no extractable text")
        except ParseError as exc:
            notes.append(f"llm_layout: {exc}")
        except LLMError as exc:
            notes.append(f"llm_layout: LLM call failed ({exc})")
    else:
        notes.append("llm_layout: no LLM available for fallback (set LLM_PROVIDER=litellm to enable)")

    if best is None:
        raise ParseError(f"could not extract any transactions from {doc.filename}: " + "; ".join(notes))
    if sign_warning:
        best.warnings.append(sign_warning)
    return _finalise(best, metadata)


def _replay(doc, config, metadata, layouts) -> ParsedStatement | None:
    return layout_store.replay_layout(doc, config, metadata, layouts)


def _finalise(result: ParsedStatement, detected: StatementMetadata) -> ParsedStatement:
    """Merge document-level metadata into the result and propagate ``card_last4``."""
    meta = result.metadata
    for name in ("institution", "account_last4", "closing_date", "period_start", "period_end",
                 "closing_balance", "account_type_hint"):  # fmt: skip
        if getattr(meta, name) is None and getattr(detected, name) is not None:
            setattr(meta, name, getattr(detected, name))
    cards = {t.card_last4 for t in result.transactions if t.card_last4}
    if meta.account_last4 is None and len(cards) == 1:
        meta.account_last4 = next(iter(cards))
    for txn in result.transactions:
        if txn.card_last4 is None:
            txn.card_last4 = meta.account_last4
    return result


def detect_document(doc: StatementDocument, config: AppConfig) -> StatementMetadata:
    """Return ``StatementMetadata`` guessed from the document text (institution,
    last4, statement period, closing date) without parsing transactions."""
    return detect_metadata(doc, config)
