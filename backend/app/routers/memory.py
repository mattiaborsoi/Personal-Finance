from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.database import get_db
from app.schemas import MemoryOut
from app.services import memory

router = APIRouter(prefix="/memory", tags=["memory"], dependencies=[Depends(require_primary)])


@router.get("", response_model=list[MemoryOut])
def list_memory(limit: int = Query(default=200, ge=1, le=2000), db: Session = Depends(get_db)):
    return memory.list_memories(db, limit=limit)


@router.delete("/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_memory(memory_id: uuid.UUID, db: Session = Depends(get_db)) -> Response:
    if not memory.forget(db, memory_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "memory entry not found")
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
