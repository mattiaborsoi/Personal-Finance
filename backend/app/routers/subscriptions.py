"""Recurring payments and price changes, detected from the ledger without AI."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.database import get_db
from app.schemas import SubscriptionsOut
from app.services import subscriptions

router = APIRouter(prefix="/subscriptions", tags=["subscriptions"], dependencies=[Depends(require_primary)])


@router.get("", response_model=SubscriptionsOut, response_model_by_alias=True)
def list_subscriptions(db: Session = Depends(get_db)) -> SubscriptionsOut:
    return subscriptions.find_subscriptions(db)
