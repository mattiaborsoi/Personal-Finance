"""Accounts live in the database and are managed in the app.

``config.yaml`` only *seeds* the ``accounts`` table the first time Settl starts
(when the table is empty). From then on the rows are the source of truth: the
Accounts page adds, edits, archives and deletes them, and every request builds its
:class:`~app.config.AppConfig` view of the accounts from the rows
(:func:`app.deps.get_effective_config`).

An archived account (``is_active = false``) keeps its history and still resolves
for old transactions, but is no longer offered for uploads.
"""

from __future__ import annotations

import re

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import ACCOUNT_TYPES, CLAIM_TYPES, AccountConfig, AppConfig
from app.models import Account, StatementUpload, Transaction

ACCOUNT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")


class AccountError(ValueError):
    """Invalid account data (HTTP 422)."""


class AccountConflict(ValueError):
    """The change clashes with existing data (HTTP 409)."""


# --------------------------------------------------------------------------- #
# Config <-> rows
# --------------------------------------------------------------------------- #


def account_config_from_row(row: Account) -> AccountConfig:
    return AccountConfig(
        id=row.id,
        institution=row.institution,
        label=row.label,
        account_type=row.account_type,
        owner=row.owner_user_id,
        identifier_last4=row.identifier_last4,
        default_claim_type=row.default_claim_type or "personal",
        billed_to=row.billed_to,
        is_active=bool(row.is_active),
    )


def load_account_configs(db: Session) -> list[AccountConfig]:
    """Every account row (archived included) as configuration objects."""
    rows = db.scalars(select(Account).order_by(Account.sort_order, Account.created_at, Account.id)).all()
    return [account_config_from_row(row) for row in rows]


def seed_accounts(db: Session, config: AppConfig) -> int:
    """Copy the accounts from ``config.yaml`` into an *empty* ``accounts`` table.

    Returns the number of rows created; ``0`` when the table already had rows (the
    app owns them from then on, so nothing in the config is applied again). The one
    exception is a database created before accounts had ``label``,
    ``default_claim_type`` and ``billed_to`` columns: see
    :func:`backfill_account_details`.
    """
    rows = db.scalars(select(Account)).all()
    if rows:
        return backfill_account_details(db, config, rows)
    for position, cfg in enumerate(config.accounts):
        row = _row_from_config(cfg)
        row.sort_order = position
        db.add(row)
    db.flush()
    return len(config.accounts)


def backfill_account_details(db: Session, config: AppConfig, rows: list[Account]) -> int:
    """Upgrade path: fill the detail columns from ``config.yaml`` exactly once.

    Older versions synced only the identity columns, so an upgraded database has
    every ``label`` and ``billed_to`` empty and every ``default_claim_type`` at the
    server default. That signature (all rows, all three columns untouched) can only
    come from an upgrade, never from the app, so it is safe to copy the details from
    the matching config entries; as soon as anything sets one of those columns the
    signature is gone and this never runs again. Returns the number of rows filled.
    """
    untouched = all(r.label is None and r.billed_to is None and r.default_claim_type == "personal" for r in rows)
    if not untouched:
        return 0
    by_id = {cfg.id: (position, cfg) for position, cfg in enumerate(config.accounts)}
    filled = 0
    for row in rows:
        match = by_id.get(row.id)
        if match is None:
            continue
        position, cfg = match
        if cfg.label is None and cfg.billed_to is None and cfg.default_claim_type == "personal":
            continue
        row.label = cfg.label
        row.billed_to = cfg.billed_to
        row.default_claim_type = cfg.default_claim_type
        row.sort_order = position
        filled += 1
    db.flush()
    return filled


def sync_accounts(db: Session, config: AppConfig) -> int:
    """Backwards-compatible alias for :func:`seed_accounts`."""
    return seed_accounts(db, config)


def _row_from_config(cfg: AccountConfig) -> Account:
    return Account(
        id=cfg.id,
        institution=cfg.institution,
        label=cfg.label,
        account_type=cfg.account_type,
        owner_user_id=cfg.owner,
        identifier_last4=cfg.identifier_last4,
        default_claim_type=cfg.default_claim_type,
        billed_to=cfg.billed_to,
        is_active=cfg.is_active,
    )


# --------------------------------------------------------------------------- #
# Editing
# --------------------------------------------------------------------------- #


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")


def generate_account_id(db: Session, institution: str, account_type: str, last4: str) -> str:
    """``acc_<institution>_<type>_<last4>``, suffixed with a counter if taken."""
    base = "_".join(part for part in ("acc", _slug(institution), _slug(account_type), _slug(last4)) if part)[:56]
    candidate = base
    n = 2
    while db.get(Account, candidate) is not None:
        candidate = f"{base}_{n}"
        n += 1
    return candidate


def _clean_text(value: str | None, field: str, max_len: int, required: bool) -> str | None:
    text = (value or "").strip()
    if not text:
        if required:
            raise AccountError(f"{field} must not be empty")
        return None
    return text[:max_len]


def _check_user(config: AppConfig, user_id: str | None, field: str) -> None:
    if user_id is not None and user_id not in config.user_ids:
        raise AccountError(f"{field} {user_id!r} is not one of the configured users")


def _check_unique_last4(db: Session, institution: str, last4: str, account_type: str, exclude_id: str | None) -> None:
    """Two active accounts at the same institution with the same digits would make
    statement uploads ambiguous, unless they are a main card and its supplementary."""
    stmt = select(Account).where(
        func.lower(Account.institution) == institution.lower(),
        Account.identifier_last4 == last4,
        Account.is_active.is_(True),
    )
    for other in db.scalars(stmt):
        if other.id == exclude_id:
            continue
        pair = {other.account_type, account_type}
        if pair == {"credit", "credit_supplementary"}:
            continue
        raise AccountError(
            f"an active {other.institution} account already ends in {last4}; archive it first or use different digits"
        )


def create_account(db: Session, config: AppConfig, data: dict) -> Account:
    """Insert a new account from an ``AccountCreate`` payload (``model_dump``)."""
    institution = _clean_text(data.get("institution"), "institution", 64, required=True)
    last4 = _clean_text(data.get("identifier_last4"), "identifier_last4", 8, required=True)
    account_type = data.get("account_type")
    if account_type not in ACCOUNT_TYPES:
        raise AccountError("invalid account_type")
    owner = data.get("owner")
    if not owner:
        raise AccountError("owner must not be empty")
    _check_user(config, owner, "owner")
    billed_to = data.get("billed_to") or None
    _check_user(config, billed_to, "billed_to")
    claim_type = data.get("default_claim_type") or "personal"
    if claim_type not in CLAIM_TYPES:
        raise AccountError("invalid default_claim_type")

    account_id = (data.get("id") or "").strip().lower()
    if account_id:
        if not ACCOUNT_ID_RE.match(account_id):
            raise AccountError("id must be 2-64 characters of lowercase letters, digits, '_' or '-'")
        if db.get(Account, account_id) is not None:
            raise AccountConflict(f"an account with id {account_id!r} already exists")
    else:
        account_id = generate_account_id(db, institution, account_type, last4)
    _check_unique_last4(db, institution, last4, account_type, exclude_id=None)

    next_position = int(db.scalar(select(func.coalesce(func.max(Account.sort_order), -1))) or 0) + 1
    row = Account(
        id=account_id,
        sort_order=next_position,
        institution=institution,
        label=_clean_text(data.get("label"), "label", 128, required=False),
        account_type=account_type,
        owner_user_id=owner,
        identifier_last4=last4,
        default_claim_type=claim_type,
        billed_to=billed_to,
        is_active=True,
    )
    db.add(row)
    db.flush()
    return row


def update_account(db: Session, config: AppConfig, row: Account, data: dict) -> Account:
    """Apply an ``AccountUpdate`` payload (``model_dump(exclude_unset=True)``)."""
    if "institution" in data:
        row.institution = _clean_text(data["institution"], "institution", 64, required=True)
    if "label" in data:
        row.label = _clean_text(data["label"], "label", 128, required=False)
    if "account_type" in data:
        if data["account_type"] not in ACCOUNT_TYPES:
            raise AccountError("invalid account_type")
        row.account_type = data["account_type"]
    if "owner" in data:
        if not data["owner"]:
            raise AccountError("owner must not be empty")
        _check_user(config, data["owner"], "owner")
        row.owner_user_id = data["owner"]
    if "identifier_last4" in data:
        row.identifier_last4 = _clean_text(data["identifier_last4"], "identifier_last4", 8, required=True)
    if "default_claim_type" in data:
        if data["default_claim_type"] not in CLAIM_TYPES:
            raise AccountError("invalid default_claim_type")
        row.default_claim_type = data["default_claim_type"]
    if "billed_to" in data:
        billed_to = data["billed_to"] or None
        _check_user(config, billed_to, "billed_to")
        row.billed_to = billed_to
    if "is_active" in data:
        row.is_active = bool(data["is_active"])
    if row.is_active:
        _check_unique_last4(db, row.institution, row.identifier_last4, row.account_type, exclude_id=row.id)
    db.flush()
    return row


def transaction_count(db: Session, account_id: str) -> int:
    stmt = select(func.count()).select_from(Transaction).where(Transaction.account_id == account_id)
    return int(db.scalar(stmt) or 0)


def delete_account(db: Session, config: AppConfig, row: Account) -> None:
    """Remove an account that has no history; otherwise raise :class:`AccountConflict`."""
    if transaction_count(db, row.id):
        raise AccountConflict("this account has transactions; archive it instead of deleting it")
    uploads = db.scalar(select(func.count()).select_from(StatementUpload).where(StatementUpload.account_id == row.id))
    if uploads:
        raise AccountConflict("statements have been uploaded to this account; archive it instead of deleting it")
    for rule in config.deterministic_rules:
        if rule.transfer_to_account == row.id:
            raise AccountConflict(f"a rule in config.yaml ({rule.pattern!r}) sends transfers to this account")
    db.delete(row)
    db.flush()
