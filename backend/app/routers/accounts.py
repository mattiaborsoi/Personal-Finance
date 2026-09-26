"""Accounts are managed here; ``config.yaml`` only seeds them on first start."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.config import AppConfig
from app.database import get_db
from app.deps import get_effective_config
from app.models import Account, Transaction
from app.schemas import AccountCreate, AccountOut, AccountUpdate
from app.services import accounts as accounts_service

router = APIRouter(prefix="/accounts", tags=["accounts"], dependencies=[Depends(require_primary)])


def _counts(db: Session) -> dict[str, int]:
    rows = db.execute(
        select(Transaction.account_id, func.count(Transaction.id)).group_by(Transaction.account_id)
    ).all()
    return {account_id: int(n) for account_id, n in rows if account_id}


def _to_out(row: Account, count: int) -> AccountOut:
    out = AccountOut.model_validate(row)
    out.transaction_count = count
    return out


def _get_or_404(db: Session, account_id: str) -> Account:
    row = db.get(Account, account_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "account not found")
    return row


@router.get("", response_model=list[AccountOut])
def list_accounts(db: Session = Depends(get_db)) -> list[AccountOut]:
    counts = _counts(db)
    rows = db.scalars(select(Account).order_by(Account.is_active.desc(), Account.created_at, Account.id)).all()
    return [_to_out(row, counts.get(row.id, 0)) for row in rows]


@router.post("", response_model=AccountOut, status_code=status.HTTP_201_CREATED)
def create_account(
    body: AccountCreate,
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_effective_config),
) -> AccountOut:
    try:
        row = accounts_service.create_account(db, config, body.model_dump())
    except accounts_service.AccountConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except accounts_service.AccountError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    db.commit()
    db.refresh(row)
    return _to_out(row, 0)


@router.patch("/{account_id}", response_model=AccountOut)
def update_account(
    account_id: str,
    body: AccountUpdate,
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_effective_config),
) -> AccountOut:
    row = _get_or_404(db, account_id)
    try:
        accounts_service.update_account(db, config, row, body.model_dump(exclude_unset=True))
    except accounts_service.AccountConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except accounts_service.AccountError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    db.commit()
    db.refresh(row)
    return _to_out(row, accounts_service.transaction_count(db, row.id))


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(
    account_id: str,
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_effective_config),
) -> Response:
    row = _get_or_404(db, account_id)
    try:
        accounts_service.delete_account(db, config, row)
    except accounts_service.AccountConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
