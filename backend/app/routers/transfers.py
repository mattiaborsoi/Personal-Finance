from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.config import AppConfig
from app.database import get_db
from app.deps import get_effective_config
from app.models import Transaction, TransferBuffer
from app.schemas import ManualMatchRequest, RematchOut, TransferBufferOut
from app.services import transfers

router = APIRouter(prefix="/transfers", tags=["transfers"], dependencies=[Depends(require_primary)])


def _to_out(entry: TransferBuffer, db: Session) -> TransferBufferOut:
    description = None
    if entry.transaction_id:
        txn = db.get(Transaction, entry.transaction_id)
        if txn is not None:
            description = txn.raw_description
    out = TransferBufferOut.model_validate(entry)
    out.description = description
    return out


@router.get("/unmatched", response_model=list[TransferBufferOut])
def list_unmatched(db: Session = Depends(get_db)) -> list[TransferBufferOut]:
    return [_to_out(e, db) for e in transfers.unmatched(db)]


@router.post("/rematch", response_model=RematchOut)
def rematch(db: Session = Depends(get_db), config: AppConfig = Depends(get_effective_config)) -> RematchOut:
    matched = transfers.match_pending(db, config)
    db.commit()
    return RematchOut(matched=matched)


@router.post("/match", response_model=list[TransferBufferOut])
def manual_match(body: ManualMatchRequest, db: Session = Depends(get_db)) -> list[TransferBufferOut]:
    a = db.get(TransferBuffer, body.buffer_id_a)
    b = db.get(TransferBuffer, body.buffer_id_b)
    if a is None or b is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "buffer entry not found")
    if a.id == b.id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "cannot match an entry with itself")
    if a.match_status != "unmatched" or b.match_status != "unmatched":
        raise HTTPException(status.HTTP_409_CONFLICT, "both entries must be unmatched")
    try:
        transfers.manual_link(db, a.id, b.id)
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "buffer entry not found") from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    db.commit()
    db.refresh(a)
    db.refresh(b)
    return [_to_out(a, db), _to_out(b, db)]


@router.post("/{buffer_id}/ignore", response_model=TransferBufferOut)
def ignore_entry(buffer_id: uuid.UUID, db: Session = Depends(get_db)) -> TransferBufferOut:
    entry = db.get(TransferBuffer, buffer_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "buffer entry not found")
    if entry.match_status == "matched":
        raise HTTPException(status.HTTP_409_CONFLICT, "entry is already matched")
    try:
        transfers.ignore(db, buffer_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    db.commit()
    db.refresh(entry)
    return _to_out(entry, db)


@router.get("", response_model=list[TransferBufferOut])
def list_all(db: Session = Depends(get_db)) -> list[TransferBufferOut]:
    rows = db.scalars(select(TransferBuffer).order_by(TransferBuffer.transaction_date.desc())).all()
    return [_to_out(e, db) for e in rows]
