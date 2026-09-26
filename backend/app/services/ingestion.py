"""Statement ingestion orchestrator.

``ingest_statement`` runs the blueprint pipeline for one uploaded file::

    parse (Agent 1) -> per-line account resolution -> deterministic rules / Agent 2
    -> insert into the master ledger (pending_review or auto_approved)
    -> transfer buffer registration (+ mirror rows for configured transfer targets)
    -> cross-ledger matching

Design notes
------------
* **Periods**: every transaction is filed under the calendar month of its own
  ``transaction_date``; the span of months the file touched is recorded on the
  ``statement_uploads`` row (``period_from`` / ``period_to``, with ``period_key``
  still the newest month for compatibility). Uploading *new* lines into a closed
  period is refused; lines that already exist (a re-upload) are simply skipped, so
  a statement overlapping an already-closed month still goes through.
* **AI outages**: one :class:`~app.services.guesser.UploadState` is shared by the
  file's ``classify`` calls. It memoises answers for duplicate lines and carries the
  LLM circuit breaker; when the breaker trips (or a model answer was unusable) the
  result says so in ``warnings`` so uncategorised lines are not a silent surprise.
  No warning is raised when AI is switched off: that is the user's choice.
* **Idempotency**: each line gets a fingerprint ``sha256(account|date|amount|raw|n)``
  where ``n`` is the occurrence index of identical lines within the same file, so
  re-uploading a statement inserts nothing new while two genuinely identical
  purchases on one day are both kept. A file whose sha256 was already ingested is
  rejected outright.
* **Account resolution**: an explicit ``account_id`` is the default for the file, but
  a line printed under a card section that resolves to one account of the same
  institution (a supplementary card) keeps that account. Without an explicit
  account each line is mapped via its ``card_last4`` and finally the statement's
  ``account_last4`` / institution. Ambiguity raises :class:`AccountResolutionError`
  listing the candidates so the UI can ask.
* **Sign convention**: the chosen account's type is handed to the parser so a card
  export with a bare "Amount" column (charges printed positive) is read correctly
  even when the file name reveals nothing.
* **Investment mirrors**: a rule with ``transfer_to_account`` creates the inverse
  transaction on the target (e.g. investment) account and links the pair, which is
  what drives net-invested-capital tracking without a broker statement. Mirror rows
  are recognisable by ``raw_description`` starting with :data:`MIRROR_PREFIX`.
"""

from __future__ import annotations

import hashlib
import logging
from collections import Counter
from datetime import date
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import AccountConfig, AppConfig
from app.models import LedgerPeriod, StatementUpload, Transaction, TransferBuffer
from app.schemas import UploadResult
from app.services import guesser, settlement, transfers
from app.services.embeddings import EmbeddingClient
from app.services.llm import LLMClient
from app.services.parsers.base import ParsedStatement, ParsedTransaction
from app.services.parsers.registry import parse_statement
from app.services.periods import PeriodClosedError, get_or_create_period, period_key_for

log = logging.getLogger(__name__)

MIRROR_PREFIX = "MIRROR "
TWO_PLACES = Decimal("0.01")


class IngestionError(ValueError):
    """Base class for ingestion failures that map to 4xx responses."""


class DuplicateUploadError(IngestionError):
    def __init__(self, upload: StatementUpload) -> None:
        super().__init__(f"this file was already ingested as {upload.filename} on {upload.created_at}")
        self.upload = upload


class AccountResolutionError(IngestionError):
    def __init__(self, message: str, candidates: list[str]) -> None:
        super().__init__(message)
        self.candidates = candidates


def file_sha256(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fingerprint(account_id: str, txn_date: date, amount: Decimal, raw_text: str, occurrence: int) -> str:
    key = f"{account_id}|{txn_date.isoformat()}|{Decimal(amount):.2f}|{' '.join(raw_text.split()).upper()}|{occurrence}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def is_mirror(txn: Transaction) -> bool:
    """True for the inverse leg written by :func:`create_mirror`."""
    return txn.classification_source == "transfer" and (txn.raw_description or "").startswith(MIRROR_PREFIX)


def _resolve_default_account(
    parsed: ParsedStatement, config: AppConfig, account_id: str | None
) -> AccountConfig | None:
    if account_id:
        acc = config.get_account(account_id)
        if acc is None:
            raise AccountResolutionError(f"unknown account_id {account_id!r}", [a.id for a in config.accounts])
        return acc
    meta = parsed.metadata
    if meta.account_last4:
        matches = config.accounts_by_last4(meta.account_last4, meta.institution)
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise AccountResolutionError(
                f"several accounts end in {meta.account_last4}; pass account_id", [a.id for a in matches]
            )
    if meta.institution:
        inst = [a for a in config.accounts if a.institution.lower() == meta.institution.lower()]
        if len(inst) == 1:
            return inst[0]
    return None


def _resolve_line_account(
    line: ParsedTransaction,
    parsed: ParsedStatement,
    config: AppConfig,
    default: AccountConfig | None,
    explicit: bool,
) -> AccountConfig:
    if explicit and default is not None:
        # A multi-card statement keeps its card sections even when an account was chosen:
        # the explicit account is the default, a supplementary card of the same
        # institution stays on its own account.
        if line.card_last4:
            same_institution = [
                a
                for a in config.accounts_by_last4(line.card_last4, default.institution)
                if a.institution.lower() == default.institution.lower()
            ]
            if len(same_institution) == 1:
                return same_institution[0]
        return default
    if line.card_last4:
        matches = config.accounts_by_last4(line.card_last4, parsed.metadata.institution)
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1 and default is not None and default in matches:
            return default
        if len(matches) > 1:
            raise AccountResolutionError(
                f"several accounts end in {line.card_last4}; pass account_id", [a.id for a in matches]
            )
    if default is not None:
        return default
    raise AccountResolutionError(
        "could not determine which account this statement belongs to; pass account_id",
        [a.id for a in config.accounts],
    )


def _closed_periods(db: Session, keys: set[str]) -> list[str]:
    if not keys:
        return []
    rows = db.scalars(select(LedgerPeriod).where(LedgerPeriod.period_key.in_(keys))).all()
    return sorted(p.period_key for p in rows if p.is_closed)


def ingest_statement(
    db: Session,
    config: AppConfig,
    embedder: EmbeddingClient,
    llm: LLMClient,
    path: str | Path,
    filename: str,
    account_id: str | None = None,
    extraction_llm: LLMClient | None = None,
) -> UploadResult:
    """``llm`` classifies merchants; ``extraction_llm`` (default: the same client) reads PDFs."""
    path = Path(path)
    sha = file_sha256(path)
    dup = db.scalars(select(StatementUpload).where(StatementUpload.sha256 == sha)).first()
    if dup is not None:
        raise DuplicateUploadError(dup)

    explicit_account = config.get_account(account_id) if account_id else None
    if account_id and explicit_account is None:
        raise AccountResolutionError(f"unknown account_id {account_id!r}", [a.id for a in config.accounts])

    parsed = parse_statement(path, config, llm=extraction_llm or llm, filename=filename, account=explicit_account)
    warnings = list(parsed.warnings)
    default_account = _resolve_default_account(parsed, config, account_id)

    # Resolve accounts and fingerprints up front: only lines that are actually new
    # decide whether a closed period blocks the file.
    occurrences: Counter[tuple] = Counter()
    resolved: list[tuple[ParsedTransaction, AccountConfig, str]] = []
    for line in parsed.transactions:
        acc = _resolve_line_account(line, parsed, config, default_account, explicit=account_id is not None)
        occ_key = (
            acc.id,
            line.date,
            Decimal(line.amount).quantize(TWO_PLACES),
            " ".join(line.raw_text.split()).upper(),
        )
        occurrence = occurrences[occ_key]
        occurrences[occ_key] += 1
        resolved.append((line, acc, fingerprint(acc.id, line.date, line.amount, line.raw_text, occurrence)))

    existing = (
        set(
            db.scalars(
                select(Transaction.fingerprint).where(Transaction.fingerprint.in_([fp for _, _, fp in resolved]))
            ).all()
        )
        if resolved
        else set()
    )
    new_lines = [(line, acc, fp) for line, acc, fp in resolved if fp not in existing]
    skipped = len(resolved) - len(new_lines)

    period_keys = {period_key_for(line.date) for line, _, _ in new_lines}
    closed = _closed_periods(db, period_keys)
    if closed:
        raise PeriodClosedError(f"period(s) {', '.join(closed)} are closed; reopen them before uploading")
    for key in sorted(period_keys):
        get_or_create_period(db, key)

    inserted = pending = auto = 0
    state = guesser.UploadState()
    for line, acc, fp in new_lines:
        cls = guesser.classify(db, config, embedder, llm, line.raw_text, acc, amount=line.amount, state=state)
        alloc_p, alloc_s = settlement.allocate(line.amount, cls.claim_type, acc.owner, config)
        txn = Transaction(
            period_key=period_key_for(line.date),
            account_id=acc.id,
            transaction_date=line.date,
            post_date=line.post_date,
            raw_description=line.raw_text,
            cleaned_merchant=cls.cleaned_merchant[:255],
            amount=Decimal(line.amount).quantize(TWO_PLACES),
            currency=config.app.base_currency,
            original_currency=line.foreign_currency,
            foreign_amount=line.foreign_amount,
            category=cls.category,
            subcategory=cls.subcategory,
            claim_type=cls.claim_type,
            allocated_primary_amount=alloc_p,
            allocated_secondary_amount=alloc_s,
            review_status=cls.review_status,
            is_internal_transfer=cls.is_internal_transfer,
            classification_source=cls.source,
            classification_confidence=Decimal(str(round(cls.confidence, 3))),
            fingerprint=fp,
            source_file=filename[:255],
        )
        db.add(txn)
        db.flush()
        inserted += 1
        if txn.review_status == "pending_review":
            pending += 1
        else:
            auto += 1

        is_transfer = cls.is_internal_transfer or transfers.is_transfer_description(line.raw_text, config)
        if is_transfer and txn.amount != 0:
            entry = transfers.register_transfer(db, txn)
            if cls.transfer_to_account:
                create_mirror(db, config, txn, cls.transfer_to_account, filename, entry)
        elif is_transfer:
            warnings.append(f"{line.date}: zero-amount transfer line {line.raw_text!r} left out of the buffer")

    matched = transfers.match_pending(db, config)
    warnings.extend(ai_warnings(state))

    all_keys = {period_key_for(line.date) for line, _, _ in resolved}
    provenance_key = max(all_keys) if all_keys else None
    upload = StatementUpload(
        account_id=default_account.id if default_account else (resolved[0][1].id if resolved else None),
        period_key=provenance_key,
        period_from=min(all_keys) if all_keys else None,
        period_to=provenance_key,
        filename=filename[:255],
        sha256=sha,
        parser=parsed.parser_name[:64],
        transaction_count=inserted,
    )
    if provenance_key:
        get_or_create_period(db, provenance_key)
    db.add(upload)
    db.flush()

    return UploadResult(
        upload_id=upload.id,
        account_id=upload.account_id,
        period_key=upload.period_key,
        period_from=upload.period_from,
        period_to=upload.period_to,
        parser=parsed.parser_name,
        inserted=inserted,
        skipped_duplicates=skipped,
        pending_review=pending,
        auto_approved=auto,
        transfers_matched=matched,
        warnings=warnings,
    )


def _lines(n: int) -> tuple[str, str]:
    """``("3 lines", "them")`` or ``("1 line", "it")`` for the warning text."""
    return ("1 line", "it") if n == 1 else (f"{n} lines", "them")


def ai_warnings(state: guesser.UploadState) -> list[str]:
    """User-facing warnings about lines the AI could not classify during this upload.

    An outage (the circuit breaker tripped: connection refused, timed out, HTTP error
    from the proxy) and unusable answers are reported separately; AI being switched
    off is not reported, since the fallback is then what the user asked for.
    """
    out: list[str] = []
    if state.llm_outage is not None:
        count, pronoun = _lines(state.outage_lines)
        out.append(
            f"AI unavailable ({state.llm_outage}): {count} left uncategorised; "
            f"approve {pronoun} in the queue or retry the upload later"
        )
    if state.bad_answers:
        count, pronoun = _lines(state.bad_answers)
        out.append(
            f"AI gave an unusable answer for {count}, left uncategorised; "
            f"approve {pronoun} in the queue or retry the upload later"
        )
    return out


def create_mirror(
    db: Session,
    config: AppConfig,
    txn: Transaction,
    target_account_id: str,
    filename: str,
    source_entry: TransferBuffer,
) -> Transaction | None:
    """Write the inverse leg of a transfer on ``target_account_id`` and link the pair.

    Idempotent: the mirror's fingerprint derives from the source fingerprint, so a
    second call for the same ``txn`` finds the existing row and only re-links it.
    Ingestion calls this for every rule with ``transfer_to_account``; the transactions
    router calls it again when a user re-flags such a line as an internal transfer
    after un-flagging it (which deleted the mirror).
    """
    target = config.get_account(target_account_id)
    if target is None:
        log.warning("transfer target %s not configured; skipping mirror", target_account_id)
        return None
    mirror_amount = -Decimal(txn.amount)
    # Keyed on the source fingerprint so two identical same-day transfers get two mirrors.
    fp = fingerprint(target.id, txn.transaction_date, mirror_amount, f"{MIRROR_PREFIX}{txn.fingerprint}", 0)
    mirror = db.scalars(select(Transaction).where(Transaction.fingerprint == fp)).first()
    if mirror is None:
        alloc_p, alloc_s = settlement.allocate(mirror_amount, "personal", target.owner, config)
        mirror = Transaction(
            period_key=txn.period_key,
            account_id=target.id,
            transaction_date=txn.transaction_date,
            post_date=txn.post_date,
            raw_description=f"{MIRROR_PREFIX}{txn.raw_description}",
            cleaned_merchant=txn.cleaned_merchant,
            amount=mirror_amount,
            currency=txn.currency,
            category=txn.category,
            subcategory=txn.subcategory,
            claim_type="personal",
            allocated_primary_amount=alloc_p,
            allocated_secondary_amount=alloc_s,
            review_status="auto_approved",
            is_internal_transfer=True,
            classification_source="transfer",
            classification_confidence=Decimal("1.000"),
            fingerprint=fp,
            source_file=filename[:255],
        )
        db.add(mirror)
        db.flush()
    if mirror.linked_transfer_id is None:
        mirror_entry = transfers.register_transfer(db, mirror)
        transfers.link(db, source_entry, mirror_entry)
    return mirror


_create_mirror = create_mirror  # former name, kept for callers that still use it
