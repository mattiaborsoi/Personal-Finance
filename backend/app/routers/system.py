"""Settings -> System: version information and self-update."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.auth import require_primary
from app.config import Settings
from app.deps import get_settings
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
