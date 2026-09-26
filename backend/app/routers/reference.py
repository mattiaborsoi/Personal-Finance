from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.auth import require_any_role
from app.config import AppConfig, Settings
from app.database import get_db
from app.deps import get_effective_config, get_settings
from app.schemas import HealthOut

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
def public_config(config: AppConfig = Depends(get_effective_config)) -> dict:
    return config.public_dict()
