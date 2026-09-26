"""Keep the ``accounts`` table in sync with ``config.yaml``."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import AppConfig
from app.models import Account


def sync_accounts(db: Session, config: AppConfig) -> int:
    """Upsert every configured account; returns the number of rows created or updated.

    Accounts removed from the config are kept (their transactions still exist) but
    are no longer offered for uploads.
    """
    changed = 0
    existing = {a.id: a for a in db.scalars(select(Account)).all()}
    for cfg in config.accounts:
        row = existing.get(cfg.id)
        if row is None:
            db.add(
                Account(
                    id=cfg.id,
                    institution=cfg.institution,
                    account_type=cfg.account_type,
                    owner_user_id=cfg.owner,
                    identifier_last4=cfg.identifier_last4,
                )
            )
            changed += 1
            continue
        if (
            row.institution != cfg.institution
            or row.account_type != cfg.account_type
            or row.owner_user_id != cfg.owner
            or row.identifier_last4 != cfg.identifier_last4
        ):
            row.institution = cfg.institution
            row.account_type = cfg.account_type
            row.owner_user_id = cfg.owner
            row.identifier_last4 = cfg.identifier_last4
            changed += 1
    db.flush()
    return changed
