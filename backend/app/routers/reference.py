from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.auth import require_any_role, require_primary
from app.config import AppConfig, Settings
from app.database import get_db
from app.deps import get_config, get_settings
from app.models import Account
from app.schemas import AccountOut, HealthOut

router = APIRouter(tags=["reference"])


@router.get("/health", response_model=HealthOut)
def health(db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> HealthOut:
    try:
        db.execute(text("SELECT 1"))
        database = "ok"
    except Exception as exc:  # pragma: no cover - only when the DB is down
        database = f"error: {exc.__class__.__name__}"
    return HealthOut(
        status="ok" if database == "ok" else "degraded",
        database=database,
        llm_provider=settings.llm_provider,
        embedding_provider=settings.embedding_provider,
    )


@router.get("/config", dependencies=[Depends(require_any_role)])
def public_config(config: AppConfig = Depends(get_config)) -> dict:
    return config.public_dict()


@router.get("/accounts", response_model=list[AccountOut], dependencies=[Depends(require_primary)])
def list_accounts(db: Session = Depends(get_db)) -> list[Account]:
    return list(db.scalars(select(Account).order_by(Account.id)).all())
