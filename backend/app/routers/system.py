"""Settings -> System: version information, self-update and reset."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.config import AppConfig, Settings
from app.database import get_db
from app.deps import get_config, get_settings
from app.schemas import ResetCounts, ResetOut, ResetRequest
from app.services import reset as reset_service
from app.services.updates import (
    GitHubClient,
    UpdateAlreadyRunning,
    UpdaterClient,
    UpdaterUnavailable,
    system_info,
)

router = APIRouter(prefix="/system", tags=["system"], dependencies=[Depends(require_primary)])


_github: GitHubClient | None = None


def get_github(settings: Settings = Depends(get_settings)) -> GitHubClient:
    """One client per process so its ten-minute cache of the GitHub answer is shared."""
    global _github
    if _github is None or _github.settings is not settings:
        _github = GitHubClient(settings)
    return _github


def get_updater(settings: Settings = Depends(get_settings)) -> UpdaterClient:
    return UpdaterClient(settings)


@router.get("")
def get_system(
    settings: Settings = Depends(get_settings),
    github: GitHubClient = Depends(get_github),
    updater: UpdaterClient = Depends(get_updater),
) -> dict:
    return system_info(settings, github, updater)


@router.post("/check")
def check_for_updates(
    settings: Settings = Depends(get_settings),
    github: GitHubClient = Depends(get_github),
    updater: UpdaterClient = Depends(get_updater),
) -> dict:
    return system_info(settings, github, updater, force_check=True)


@router.post("/update", status_code=status.HTTP_202_ACCEPTED)
def start_update(updater: UpdaterClient = Depends(get_updater)) -> dict:
    try:
        return updater.start_update()
    except UpdateAlreadyRunning as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except UpdaterUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


@router.post("/reset", response_model=ResetOut)
def reset(
    body: ResetRequest,
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_config),
) -> ResetOut:
    """Wipe the ledger (``scope: transactions``) or the whole installation (``scope: everything``).

    ``transactions`` (confirm with ``DELETE TRANSACTIONS``) deletes every transaction
    (split parts and mirror legs included), every transfer-buffer row, statement
    upload, audit report and settlement snapshot, and every ledger period that no
    partner claim files under, closed ones included. It keeps partner claims (and
    their periods), merchant memory, accounts and the app settings (AI, household,
    categories, rules).

    ``everything`` (confirm with ``DELETE EVERYTHING``) also deletes partner claims,
    every period, merchant memory, the app settings and the accounts, then seeds the
    accounts from ``config.yaml`` again exactly as on first start. Logins stay valid
    (the passwords live in ``.env``).

    One database transaction; ``deleted`` counts the rows removed. **422** when
    ``confirm`` (trimmed, case-sensitive) is not the scope's phrase.
    """
    try:
        reset_service.check_confirmation(body.scope, body.confirm)
    except reset_service.ResetNotConfirmed as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    try:
        counts = reset_service.reset(db, body.scope, config)
    except Exception:
        db.rollback()
        raise
    db.commit()
    return ResetOut(scope=body.scope, deleted=ResetCounts(**counts))
