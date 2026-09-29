"""Category picker helpers (primary only)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.config import AppConfig
from app.database import get_db
from app.deps import get_effective_config
from app.schemas import CategorySuggestionsOut
from app.services import category_suggestions

router = APIRouter(prefix="/categories", tags=["categories"], dependencies=[Depends(require_primary)])


@router.get("/suggestions", response_model=CategorySuggestionsOut)
def suggestions(
    merchant: str = Query(..., description="The cleaned merchant name, matched ignoring case"),
    limit: int = Query(default=3, ge=1, le=10),
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_effective_config),
) -> CategorySuggestionsOut:
    """Categories this merchant was filed under before, and the most used ones this last year."""
    if not merchant.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "merchant must not be empty")
    return category_suggestions.suggestions(db, config, merchant, limit)
