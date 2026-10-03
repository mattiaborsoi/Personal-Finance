"""Learnt PDF layouts: ask the model once, replay deterministically ever after.

When the LLM fallback has read a PDF the parsers could not, one cheap follow-up
call asks the model, on the redacted page text only, to describe the layout as a
:mod:`app.services.parsers.template` (which regular expression picks out a line,
where the date and the amount sit, the sign convention, the card headings, what to
skip). The template is tried on the same document at once and kept only when it
reproduces the model's own lines exactly. It is stored under a *fingerprint* of the
statement: a SHA-256 of the institution and the words of the first page's lines
that carry no digits (the headings and labels a bank prints on every statement),
after redaction, so never a name, a number, a date or an amount. The next PDF with
the same fingerprint is parsed with the template and no AI call is made.

Settings -> AI lists the learnt layouts (institution, when learnt, times used) and
can delete one; the next statement of that kind then goes to the model again.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import AppConfig
from app.models import PdfLayout
from app.services.llm import LLMClient, LLMError
from app.services.parsers.base import ParsedStatement, StatementDocument, StatementMetadata
from app.services.parsers.template import TemplateError, TemplateParser, clean_template, reproduces
from app.services.redaction import Redactor, strip_placeholders

log = logging.getLogger(__name__)

FINGERPRINT_LINES = 80  # first-page lines looked at
FINGERPRINT_TOKENS = 80  # distinct words kept (sorted), so a stray extra heading changes little
LAYOUT_PAGE_CHARS = 3500  # how much of the (redacted) first page the model sees
LAYOUT_EXAMPLES = 6  # extracted lines shown as the ground truth
LAYOUT_MAX_TOKENS = 700

LAYOUT_PROMPT = """\
You describe the layout of a UK bank or credit-card statement so a regular-expression parser can read it
without you next time. You receive the (redacted) text of the first page and a few transactions that were
extracted from it. Bracketed tokens such as [name#1], [number#2] or [card#3:1234] stand for details removed
for privacy: treat each as an opaque word.

Return ONLY a JSON object of exactly this shape:
{"line": "<Python regex matched against one text line, with named groups>",
 "sign": "unsigned_is_debit" | "signed" | "debit_credit",
 "day_first": true | false,
 "card_section": "<Python regex with a named group last4>" | null,
 "skip": ["<Python regex>", ...],
 "continuation": true | false}

Rules:
- "line" must have the named groups date and description, plus amount (or both debit and credit when
  sign is debit_credit); it may also have post_date, cr (matching anything means money in) and card.
  Anchor it with ^ and $ where possible and keep it simple: no nested quantifiers.
- "sign": unsigned_is_debit when a bare amount is money out and CR, a minus or parentheses mark money in
  (card statements); signed when a minus means money out (bank exports); debit_credit for two columns.
- "day_first": whether numeric dates read day first (31/07/2026).
- "card_section": the heading that starts a card's section, if the statement has sections per card, else null.
- "skip": patterns for lines to ignore (totals, balances, page footers); at most 10.
- "continuation": true when a description can run onto a following line without a date or amount.
No prose, no code fences, no extra keys."""


# --------------------------------------------------------------------------- #
# Fingerprints
# --------------------------------------------------------------------------- #


def layout_fingerprint(first_page: str, institution: str | None, redactor: Redactor) -> str:
    """SHA-256 of the institution and the first page's digit-free words, after redaction."""
    tokens: set[str] = set()
    for line in (first_page or "").splitlines()[:FINGERPRINT_LINES]:
        if any(ch.isdigit() for ch in line):
            continue  # dates, amounts, references and addresses never enter the fingerprint
        clean = strip_placeholders(redactor.redact(line))
        tokens.update(t.lower() for t in re.findall(r"[A-Za-z]{3,}", clean))
    words = " ".join(sorted(tokens)[:FINGERPRINT_TOKENS])
    return hashlib.sha256(f"{(institution or '').strip().lower()}|{words}".encode()).hexdigest()


# --------------------------------------------------------------------------- #
# Stores
# --------------------------------------------------------------------------- #


class LayoutStore(Protocol):
    """What the parser registry needs: a lookup, a save and a use counter."""

    def find(self, fingerprint: str) -> dict | None: ...

    def learned(self, fingerprint: str, institution: str | None, template: dict) -> None: ...

    def used(self, fingerprint: str) -> None: ...


@dataclass(slots=True)
class MemoryLayoutStore:
    """In-memory store (tests, and callers without a database)."""

    templates: dict[str, dict] | None = None
    uses: dict[str, int] | None = None

    def __post_init__(self) -> None:
        self.templates = self.templates if self.templates is not None else {}
        self.uses = self.uses if self.uses is not None else {}

    def find(self, fingerprint: str) -> dict | None:
        return self.templates.get(fingerprint)

    def learned(self, fingerprint: str, institution: str | None, template: dict) -> None:
        self.templates[fingerprint] = template

    def used(self, fingerprint: str) -> None:
        self.uses[fingerprint] = self.uses.get(fingerprint, 0) + 1


class DbLayoutStore:
    def __init__(self, db: Session) -> None:
        self.db = db

    def find(self, fingerprint: str) -> dict | None:
        row = self.db.scalars(select(PdfLayout).where(PdfLayout.fingerprint == fingerprint)).first()
        return dict(row.template) if row is not None else None

    def learned(self, fingerprint: str, institution: str | None, template: dict) -> None:
        row = self.db.scalars(select(PdfLayout).where(PdfLayout.fingerprint == fingerprint)).first()
        if row is None:
            row = PdfLayout(fingerprint=fingerprint, institution=(institution or None), template=template)
            self.db.add(row)
        else:
            row.template = template
            row.institution = institution or row.institution
        self.db.flush()

    def used(self, fingerprint: str) -> None:
        row = self.db.scalars(select(PdfLayout).where(PdfLayout.fingerprint == fingerprint)).first()
        if row is not None:
            row.times_used = (row.times_used or 0) + 1
            row.last_used_at = datetime.now(UTC)
            self.db.flush()


def list_layouts(db: Session) -> list[PdfLayout]:
    return list(db.scalars(select(PdfLayout).order_by(PdfLayout.created_at.desc(), PdfLayout.fingerprint)))


def delete_layout(db: Session, layout_id: uuid.UUID) -> bool:
    row = db.get(PdfLayout, layout_id)
    if row is None:
        return False
    db.delete(row)
    db.flush()
    return True


# --------------------------------------------------------------------------- #
# Learning
# --------------------------------------------------------------------------- #


def learn_layout(
    doc: StatementDocument,
    extracted: ParsedStatement,
    llm: LLMClient,
    config: AppConfig | None,
    metadata: StatementMetadata,
    store: LayoutStore,
) -> dict | None:
    """Ask for a template, check it reproduces ``extracted`` and keep it. Never raises.

    Returns the template kept, or ``None`` when the model gave none, it was unusable,
    or it did not reproduce the model's own lines.
    """
    try:
        redactor = Redactor.from_config(config)
        pages = doc.text_pages
        first_page = next((p for p in pages if p.strip()), "")
        if not first_page:
            return None
        redacted_page, _ = redactor.redact_indexed(first_page[:LAYOUT_PAGE_CHARS])
        examples = [
            {"date": t.date.isoformat(), "raw_text": redactor.redact(t.raw_text), "amount": str(t.amount)}
            for t in extracted.transactions[:LAYOUT_EXAMPLES]
        ]
        user = (
            f"Transactions already extracted from this page (the ground truth):\n{json.dumps(examples)}\n\n"
            f"First page text:\n{redacted_page}"
        )
        answer = llm.complete_json(system=LAYOUT_PROMPT, user=user, max_tokens=LAYOUT_MAX_TOKENS)
        template = clean_template(answer)
        replay = TemplateParser(template, config, metadata).parse(doc)
        if not reproduces(replay, extracted.transactions):
            log.info("layout template for %s did not reproduce the extracted lines; not kept", doc.filename)
            return None
        # The fingerprint uses the institution detected before any model call (what the
        # replay will see); the label shown in Settings may come from the model's answer.
        fingerprint = layout_fingerprint(first_page, metadata.institution, redactor)
        store.learned(fingerprint, extracted.metadata.institution or metadata.institution, template)
        log.info("learnt a PDF layout for %s (%s)", metadata.institution or "unknown institution", fingerprint[:12])
        return template
    except (LLMError, TemplateError, ValueError) as exc:
        log.info("no layout learnt for %s: %s", doc.filename, exc)
        return None
    except Exception:  # noqa: BLE001 - learning is a bonus; the upload must not fail for it
        log.exception("layout learning failed for %s", doc.filename)
        return None


def replay_layout(
    doc: StatementDocument, config: AppConfig | None, metadata: StatementMetadata, store: LayoutStore
) -> ParsedStatement | None:
    """Parse ``doc`` with a stored template matching its fingerprint, or ``None``."""
    try:
        pages = doc.text_pages
        first_page = next((p for p in pages if p.strip()), "")
        if not first_page:
            return None
        fingerprint = layout_fingerprint(first_page, metadata.institution, Redactor.from_config(config))
        template = store.find(fingerprint)
        if template is None:
            return None
        result = TemplateParser(template, config, metadata).parse(doc)
        if not result.transactions:
            return None
        store.used(fingerprint)
        return result
    except Exception as exc:  # noqa: BLE001 - a stale template must fall through to the model
        log.info("learnt layout not usable for %s: %s", doc.filename, exc)
        return None


def layout_out(row: PdfLayout) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "institution": row.institution,
        "created_at": row.created_at,
        "last_used_at": row.last_used_at,
        "times_used": row.times_used or 0,
    }
