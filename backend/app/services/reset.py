"""Settings -> System -> Reset: wipe the ledger, or the whole installation.

Two scopes:

* ``transactions``: every transaction (split parts and mirror legs included), every
  transfer-buffer row, statement upload, audit report and settlement snapshot, and
  every ledger period no partner claim or settlement entry files under (closed ones
  included: the ledger is being wiped). Partner claims, settlement entries (payments,
  adjustments and agreed balances), merchant memory, accounts and the settings
  documents are kept.
* ``everything``: all of the above plus partner claims, settlement entries, every ledger period,
  merchant memory, the ``app_settings`` documents (AI, household, categories,
  rules) and the accounts, which are then seeded again from ``config.yaml`` exactly
  as on first start, so the installation looks like day one. Logins are unaffected
  (the passwords live in ``.env``).

Rows are removed with ``DELETE`` statements in foreign-key order (see schema.sql),
all inside the caller's transaction; nothing is committed here.
"""

from __future__ import annotations

from sqlalchemy import delete, exists, select
from sqlalchemy.orm import Session

from app.config import AppConfig
from app.models import (
    Account,
    AppSetting,
    AuditReport,
    LedgerPeriod,
    MerchantMemory,
    PartnerClaim,
    SettlementEntry,
    SettlementSnapshot,
    StatementUpload,
    Transaction,
    TransferBuffer,
)
from app.services.accounts import seed_accounts

CONFIRM_PHRASES = {"transactions": "DELETE TRANSACTIONS", "everything": "DELETE EVERYTHING"}
COUNT_KEYS = ("transactions", "uploads", "claims", "periods", "memory", "accounts", "settings")


class ResetNotConfirmed(ValueError):
    """The confirmation phrase does not match the scope (HTTP 422)."""


def check_confirmation(scope: str, confirm: str | None) -> None:
    phrase = CONFIRM_PHRASES[scope]
    if (confirm or "").strip() != phrase:
        raise ResetNotConfirmed(f"type {phrase} to confirm")


def _delete(db: Session, stmt) -> int:
    return int(db.execute(stmt).rowcount or 0)


def reset(db: Session, scope: str, config: AppConfig) -> dict[str, int]:
    """Delete what ``scope`` covers and return ``{table group: rows deleted}``.

    ``config`` is the file configuration (``config.yaml`` or the built-in defaults)
    that the accounts are seeded from after an ``everything`` reset.
    """
    if scope not in CONFIRM_PHRASES:
        raise ValueError(f"unknown reset scope {scope!r}")
    everything = scope == "everything"
    counts = dict.fromkeys(COUNT_KEYS, 0)
    db.flush()

    # transfer_buffer -> transactions (a single statement, so the linked_transfer_id
    # self-reference and the split parts never block it) -> statement_uploads.
    _delete(db, delete(TransferBuffer))
    counts["transactions"] = _delete(db, delete(Transaction))
    counts["uploads"] = _delete(db, delete(StatementUpload))
    _delete(db, delete(AuditReport))
    _delete(db, delete(SettlementSnapshot))
    if everything:
        counts["claims"] = _delete(db, delete(PartnerClaim))
        _delete(db, delete(SettlementEntry))

    # Every table filing under a period is empty now, apart from the claims and
    # settlement entries kept by a ``transactions`` reset: their periods stay.
    periods = select(LedgerPeriod.period_key)
    if not everything:
        periods = periods.where(
            ~exists().where(PartnerClaim.period_key == LedgerPeriod.period_key),
            ~exists().where(SettlementEntry.period_key == LedgerPeriod.period_key),
        )
    keys = list(db.scalars(periods))
    if keys:
        counts["periods"] = _delete(db, delete(LedgerPeriod).where(LedgerPeriod.period_key.in_(keys)))

    if everything:
        counts["memory"] = _delete(db, delete(MerchantMemory))
        counts["settings"] = _delete(db, delete(AppSetting))
        counts["accounts"] = _delete(db, delete(Account))
        seed_accounts(db, config)
    db.flush()
    return counts
