"""Settings -> AI: which models do what, thresholds, a connection test, how the AI is doing, learnt layouts."""

from __future__ import annotations

import uuid
from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.config import AppConfig, Settings
from app.database import get_db
from app.deps import get_config, get_settings
from app.services import ai_accuracy, ai_settings, layouts
from app.services.ai_settings import AiUpdate, ModelCatalogue

router = APIRouter(prefix="/ai", tags=["ai"], dependencies=[Depends(require_primary)])

_catalogue = ModelCatalogue()


def get_catalogue() -> ModelCatalogue:
    return _catalogue


def _payload(
    db: Session, settings: Settings, config: AppConfig, catalogue: ModelCatalogue, *, force: bool = False
) -> dict:
    ai, stored = ai_settings.load(db, settings, config)
    models, reachable = catalogue.list(ai.proxy_url(settings), ai.proxy_key(settings), force=force)
    data = ai.public_dict(settings)
    data["proxy"]["reachable"] = reachable
    data["available_models"] = [m.model_dump() for m in models]
    data["memory_rows"] = ai_settings.memory_rows(db)
    data["stored"] = stored
    data["stats"] = asdict(ai_accuracy.stats(db))
    data["layouts"] = [layouts.layout_out(row) for row in layouts.list_layouts(db)]
    return data


@router.get("")
def get_ai(
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    config: AppConfig = Depends(get_config),
    catalogue: ModelCatalogue = Depends(get_catalogue),
) -> dict:
    return _payload(db, settings, config, catalogue)


@router.put("")
def update_ai(
    body: AiUpdate,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    config: AppConfig = Depends(get_config),
    catalogue: ModelCatalogue = Depends(get_catalogue),
) -> dict:
    try:
        current, _ = ai_settings.load(db, settings, config)
        proposed = ai_settings.merged(current, body)
        models, _ = catalogue.list(proposed.proxy_url(settings), proposed.proxy_key(settings))
        ai_settings.update(db, settings, config, body, models)
    except ai_settings.AiSettingsConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except ai_settings.AiSettingsError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    db.commit()
    return _payload(db, settings, config, catalogue)


@router.post("/test")
def test_ai(
    body: AiUpdate,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    config: AppConfig = Depends(get_config),
) -> dict:
    """Try the proposed setup (saved or not) with one trivial call per job."""
    current, _ = ai_settings.load(db, settings, config)
    proposed = ai_settings.merged(current, body)
    return ai_settings.run_tests(settings, proposed)


@router.delete("/layouts/{layout_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_layout(layout_id: uuid.UUID, db: Session = Depends(get_db)) -> Response:
    """Forget a learnt PDF layout; the next statement of that kind goes to the model again."""
    if not layouts.delete_layout(db, layout_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "layout not found")
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
