"""LLM layout extractor (Agent 1 fallback).

Used only when the deterministic parsers found no transactions. Each page's text
(split into chunks of at most ~6000 characters) is sent to ``llm.complete_json``
with a strict system prompt asking for exactly the :class:`ParsedStatement` JSON schema; the
responses are validated, coerced (ISO dates, ``Decimal`` amounts, negative = money
out) and merged.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from app.config import AppConfig
from app.services.llm import LLMClient
from app.services.parsers.amounts import parse_amount, quantize
from app.services.parsers.base import (
    ParsedStatement,
    ParsedTransaction,
    ParseError,
    StatementDocument,
    StatementMetadata,
)
from app.services.parsers.dates import DateContext, parse_date
from app.services.parsers.metadata import date_context, detect_metadata, detect_period, fill_gaps

MAX_CHUNK_CHARS = 6000
# Hard cap on LLM calls per document: a 25 MB upload must not turn into thousands of
# completions. Statements are a handful of pages; anything beyond this is not one.
MAX_LLM_CALLS = 20

SYSTEM_PROMPT = """\
You are a bank statement extraction engine. You receive the text of one page (or part of a page)
of a UK bank or credit card statement and return ONLY a JSON object with exactly this shape:

{"statement_metadata": {"institution": string or null, "account_last4": string or null,
                        "closing_date": "YYYY-MM-DD" or null,
                        "statement_period": "YYYY-MM-DD to YYYY-MM-DD" or null},
 "transactions": [{"date": "YYYY-MM-DD", "post_date": "YYYY-MM-DD" or null, "raw_text": string,
                   "amount": number, "card_last4": string or null,
                   "foreign_spend": {"amount": number, "currency": "USD"} or null}]}

Rules:
- Sign convention: negative = money out (purchases, charges, direct debits, payments made),
  positive = money in (refunds, credits, salary, payments received). A "CR" suffix means money in.
- "amount" is in the statement's own currency (GBP); put any foreign currency amount in "foreign_spend".
- Include every transaction line; exclude totals, balances, interest summaries and repeated headers.
- Infer missing years from the statement period (December lines on a statement closing in January
  belong to the previous year).
- "raw_text" is the description exactly as printed (merge continuation lines).
- "card_last4" is the last four digits of the card a line belongs to when the statement has sections
  per card, else null.
- No prose, no code fences, no extra keys. If the page has no transactions return
  {"statement_metadata": {...}, "transactions": []}."""


def chunk_text(text: str, max_chars: int = MAX_CHUNK_CHARS) -> list[str]:
    """Split page text into chunks of at most ``max_chars`` at line boundaries."""
    text = text.strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for line in text.splitlines():
        if size + len(line) + 1 > max_chars and current:
            chunks.append("\n".join(current))
            current, size = [], 0
        while len(line) > max_chars:  # a single absurdly long line
            chunks.append(line[:max_chars])
            line = line[max_chars:]
        current.append(line)
        size += len(line) + 1
    if current:
        chunks.append("\n".join(current))
    return chunks


def _coerce_last4(value: Any) -> str | None:
    if value is None:
        return None
    digits = "".join(ch for ch in str(value) if ch.isdigit())
    return digits[-4:] if len(digits) >= 4 else None


def _coerce_amount(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        try:
            return quantize(Decimal(str(value)))
        except InvalidOperation:
            return None
    amount = parse_amount(str(value))
    return quantize(amount) if amount is not None else None


def _coerce_date(value: Any, ctx: DateContext) -> date | None:
    if value is None:
        return None
    return ctx.parse(str(value).strip())


def coerce_transaction(item: Any, ctx: DateContext, base_currency: str = "GBP") -> ParsedTransaction | None:
    """Validate one transaction object from the model; ``None`` when unusable."""
    if not isinstance(item, dict):
        return None
    txn_date = _coerce_date(item.get("date"), ctx)
    amount = _coerce_amount(item.get("amount"))
    raw_text = " ".join(str(item.get("raw_text") or item.get("description") or "").split())
    if txn_date is None or amount is None or not raw_text:
        return None
    foreign_amount = foreign_currency = None
    fx = item.get("foreign_spend")
    if isinstance(fx, dict):
        fx_amount = _coerce_amount(fx.get("amount"))
        fx_currency = str(fx.get("currency") or "").strip().upper()[:3]
        if fx_amount is not None and len(fx_currency) == 3 and fx_currency != base_currency.upper():
            foreign_amount, foreign_currency = abs(fx_amount), fx_currency
    return ParsedTransaction(
        date=txn_date,
        post_date=_coerce_date(item.get("post_date"), ctx),
        raw_text=raw_text,
        amount=amount,
        card_last4=_coerce_last4(item.get("card_last4")),
        foreign_amount=foreign_amount,
        foreign_currency=foreign_currency,
    )


def coerce_metadata(raw: Any, meta: StatementMetadata) -> StatementMetadata:
    """Fill gaps in ``meta`` from the model's ``statement_metadata`` object."""
    if not isinstance(raw, dict):
        return meta
    if meta.institution is None and raw.get("institution"):
        meta.institution = str(raw["institution"]).strip()[:64] or None
    if meta.account_last4 is None:
        meta.account_last4 = _coerce_last4(raw.get("account_last4"))
    if meta.period_start is None or meta.period_end is None:
        period = raw.get("statement_period")
        if isinstance(period, str):
            start, end = detect_period(period)
            meta.period_start = meta.period_start or start
            meta.period_end = meta.period_end or end
    if meta.closing_date is None:
        closing = raw.get("closing_date")
        meta.closing_date = parse_date(str(closing)) if closing else meta.period_end
    return meta


class LLMLayoutExtractor:
    name = "llm_layout"

    def __init__(
        self,
        llm: LLMClient,
        config: AppConfig | None = None,
        metadata: StatementMetadata | None = None,
        max_chars: int = MAX_CHUNK_CHARS,
    ) -> None:
        self.llm = llm
        self.config = config
        self.metadata = metadata
        self.max_chars = max_chars

    def can_parse(self, doc: StatementDocument) -> bool:
        return bool(self.llm.available) and bool(self._page_texts(doc))

    def _page_texts(self, doc: StatementDocument) -> list[str]:
        if doc.is_pdf:
            return [p for p in doc.text_pages if p.strip()]
        try:
            text = doc.raw_bytes.decode("utf-8", errors="replace")
        except OSError:
            return []
        return [text] if text.strip() else []

    def parse(self, doc: StatementDocument) -> ParsedStatement:
        meta = replace(self.metadata) if self.metadata else detect_metadata(doc, self.config)
        pages = self._page_texts(doc)
        if not pages:
            raise ParseError("document has no extractable text to send to the LLM (scanned image?)")
        base_currency = self.config.app.base_currency if self.config else "GBP"
        known = json.dumps(
            {
                "institution": meta.institution,
                "account_last4": meta.account_last4,
                "statement_period": meta.to_dict()["statement_period"],
                "closing_date": meta.closing_date.isoformat() if meta.closing_date else None,
            }
        )
        transactions: list[ParsedTransaction] = []
        warnings: list[str] = []
        calls = 0
        total_chunks = sum(len(chunk_text(page, self.max_chars)) for page in pages)
        if total_chunks > MAX_LLM_CALLS:
            raise ParseError(
                f"document would need {total_chunks} LLM calls (limit {MAX_LLM_CALLS}); "
                "upload a single statement rather than a bulk export"
            )
        for page_no, page in enumerate(pages, start=1):
            chunks = chunk_text(page, self.max_chars)
            for part_no, chunk in enumerate(chunks, start=1):
                user = (
                    f"Statement file: {doc.filename}\n"
                    f"Known metadata (may contain nulls): {known}\n"
                    f"Page {page_no} of {len(pages)}, part {part_no} of {len(chunks)}:\n\n{chunk}"
                )
                response = self.llm.complete_json(system=SYSTEM_PROMPT, user=user, max_tokens=4096)
                calls += 1
                meta = coerce_metadata(response.get("statement_metadata"), meta)
                ctx = date_context(meta)
                items = response.get("transactions")
                if not isinstance(items, list):
                    warnings.append(f"page {page_no}: LLM response had no transactions list")
                    continue
                for item in items:
                    txn = coerce_transaction(item, ctx, base_currency)
                    if txn is None:
                        warnings.append(f"page {page_no}: skipped malformed transaction {str(item)[:80]!r}")
                        continue
                    transactions.append(txn)
        if not transactions:
            raise ParseError(f"LLM layout extraction returned no transactions after {calls} call(s)")
        fill_gaps(meta, transactions)
        return ParsedStatement(metadata=meta, transactions=transactions, parser_name=self.name, warnings=warnings)
