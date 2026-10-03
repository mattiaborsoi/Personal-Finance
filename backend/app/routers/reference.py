from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.auth import require_any_role
from app.config import AppConfig
from app.database import get_db
from app.deps import get_ai_settings, get_effective_config
from app.schemas import HealthOut

router = APIRouter(tags=["reference"])


@router.get("/health", response_model=HealthOut)
def health(db: Session = Depends(get_db)) -> HealthOut:
    """Liveness for the Compose healthcheck and the reverse proxy.

    Unauthenticated and, through nginx, reachable from anywhere that can reach the
    web port, so it says only whether the app and its database are up: nothing about
    the configured providers, models or accounts.
    """
    try:
        db.execute(text("SELECT 1"))
        database = "ok"
    except Exception as exc:  # pragma: no cover - only when the DB is down
        database = f"error: {exc.__class__.__name__}"
    return HealthOut(status="ok" if database == "ok" else "degraded", database=database)


@router.get("/config", dependencies=[Depends(require_any_role)])
def public_config(config: AppConfig = Depends(get_effective_config), ai=Depends(get_ai_settings)) -> dict:
    data = config.public_dict()
    data["ai_enabled"] = bool(ai.enabled)  # the Ask box only shows while a model can answer
    return data
