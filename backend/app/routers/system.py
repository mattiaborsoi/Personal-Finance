"""Settings -> System: version information, self-update, database backups and reset."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.config import AppConfig, Settings
from app.database import get_db
from app.deps import get_config, get_settings
from app.schemas import ResetCounts, ResetOut, ResetRequest
from app.services import backups as backups_service
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
    return {**system_info(settings, github, updater), "backups": backups_service.summary(settings)}


@router.post("/check")
def check_for_updates(
    settings: Settings = Depends(get_settings),
    github: GitHubClient = Depends(get_github),
    updater: UpdaterClient = Depends(get_updater),
) -> dict:
    info = system_info(settings, github, updater, force_check=True)
    return {**info, "backups": backups_service.summary(settings)}


PRE_UPDATE_BACKUP_FAILED = "The backup before updating failed, so the update was not started"


@router.post("/update", status_code=status.HTTP_202_ACCEPTED)
def start_update(
    skip_backup: bool = Query(False, description="Update without taking a pre-update backup first."),
    settings: Settings = Depends(get_settings),
    updater: UpdaterClient = Depends(get_updater),
) -> dict:
    """Take a ``pre-update`` dump, then ask the updater to pull and rebuild.

    **409** when an update is already running, or when the dump fails (nothing is
    started; ``?skip_backup=true`` updates without one). **503** when the updater is
    not reachable.
    """
    current = updater.status()
    if not current.available:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "the updater is not reachable")
    if current.state == "running":
        raise HTTPException(status.HTTP_409_CONFLICT, "an update is already running")
    if not skip_backup:
        try:
            backups_service.create_backup(settings, "pre-update")
        except Exception as exc:  # noqa: BLE001 - any failure refuses the update
            raise HTTPException(status.HTTP_409_CONFLICT, f"{PRE_UPDATE_BACKUP_FAILED}: {exc}") from exc
    try:
        return updater.start_update()
    except UpdateAlreadyRunning as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except UpdaterUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


@router.get("/backups")
def list_backups(settings: Settings = Depends(get_settings)) -> list[dict]:
    """Every backup in ``BACKUP_DIR``, newest first."""
    return [b.to_dict() for b in backups_service.list_backups(settings)]


@router.post("/backups", status_code=status.HTTP_201_CREATED)
def create_backup(settings: Settings = Depends(get_settings)) -> dict:
    """Take a ``manual`` dump now (waits for a dump already running); **500** when ``pg_dump`` fails."""
    try:
        made = backups_service.create_backup(settings, "manual")
    except backups_service.BackupError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"The backup failed: {exc}") from exc
    backups_service.prune_backups(settings)
    return made.to_dict()


def _backup_path(settings: Settings, name: str) -> Path:
    try:
        return backups_service.resolve_backup(settings, name)
    except backups_service.InvalidBackupName as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such backup") from exc
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such backup") from exc


@router.get("/backups/{name}", response_class=FileResponse)
def download_backup(name: str, settings: Settings = Depends(get_settings)) -> FileResponse:
    """The dump file itself (``application/octet-stream``, as an attachment)."""
    path = _backup_path(settings, name)
    return FileResponse(path, media_type="application/octet-stream", filename=path.name)


@router.delete("/backups/{name}", status_code=status.HTTP_204_NO_CONTENT)
def delete_backup(name: str, settings: Settings = Depends(get_settings)) -> Response:
    backups_service.delete_backup(settings, _backup_path(settings, name).name)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
