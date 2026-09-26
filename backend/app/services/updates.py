"""Version information and self-update (Settings -> System).

Two collaborators, both optional at runtime:

* **GitHub** tells us the newest commits on the configured branch (one
  unauthenticated ``GET /repos/{repo}/commits?sha={branch}``; answers are cached
  for a few minutes so the public API's rate limit is never an issue). The first
  is "the latest"; the ones newer than the running commit are "the changes", so
  someone who skipped several updates sees every message, not only the last.
  ``UPDATE_CHECK=false`` disables the call entirely.
* **The updater sidecar** (``updater/updater.py``) knows which commit is checked
  out on disk and can run ``git pull`` + ``docker compose up -d --build``. It is
  authenticated with a token derived from ``SECRET_KEY``; when it is not deployed
  the System tab shows the manual commands instead.

Everything here degrades to "unknown" rather than raising: a home server without
internet access must still show the page.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx

from app.config import Settings

log = logging.getLogger(__name__)

APP_NAME = "Settl"
APP_VERSION = "0.1.0"
CACHE_SECONDS = 600
TIMEOUT = httpx.Timeout(8.0)
COMMIT_LIST_SIZE = 30
"""How many commits are fetched from GitHub: the changelog is complete up to this many updates skipped."""


def updater_token(secret_key: str) -> str:
    """Shared secret between the backend and the updater, never sent to browsers."""
    return hashlib.sha256(f"settl-updater:{secret_key}".encode()).hexdigest()


@dataclass
class Commit:
    commit: str
    date: datetime | None
    message: str
    """The first line of the commit message, as a changelog entry."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "commit": self.commit,
            "short": self.commit[:7],
            "date": self.date.isoformat() if self.date else None,
            "message": self.message,
        }


def _parse_commit(data: dict[str, Any]) -> Commit | None:
    sha = str(data.get("sha") or "")
    if len(sha) < 7:
        return None
    commit = data.get("commit") or {}
    date_text = ((commit.get("committer") or {}).get("date")) or ((commit.get("author") or {}).get("date"))
    date = datetime.fromisoformat(date_text.replace("Z", "+00:00")) if date_text else None
    message = str(commit.get("message") or "").splitlines()[0] if commit.get("message") else ""
    return Commit(commit=sha, date=date, message=message[:200])


class GitHubClient:
    """The newest commits on ``branch`` of ``repo``, newest first (cached)."""

    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None) -> None:
        self.settings = settings
        self._transport = transport
        self._cached: tuple[float, list[Commit] | None] | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.settings.update_check and self.settings.update_repo)

    def commits(self, *, force: bool = False) -> list[Commit] | None:
        """``None`` when GitHub could not be asked (checks off, offline, rate limited)."""
        if not self.enabled:
            return None
        now = time.monotonic()
        if not force and self._cached and now - self._cached[0] < CACHE_SECONDS:
            return self._cached[1]
        result = self._fetch()
        self._cached = (now, result)
        return result

    def latest(self, *, force: bool = False) -> Commit | None:
        commits = self.commits(force=force)
        return commits[0] if commits else None

    def _fetch(self) -> list[Commit] | None:
        base = self.settings.github_api_url.rstrip("/")
        url = f"{base}/repos/{self.settings.update_repo}/commits"
        params = {"sha": self.settings.update_branch, "per_page": COMMIT_LIST_SIZE}
        headers = {"Accept": "application/vnd.github+json", "User-Agent": f"{APP_NAME}/{APP_VERSION}"}
        try:
            with httpx.Client(timeout=TIMEOUT, transport=self._transport) as client:
                resp = client.get(url, params=params, headers=headers)
            resp.raise_for_status()
            commits = [c for c in (_parse_commit(item) for item in resp.json()) if c is not None]
            return commits or None
        except Exception as exc:  # noqa: BLE001 - offline or rate limited: show "unknown"
            log.warning("update check against GitHub failed: %s", exc)
            return None


def changes_since(commits: list[Commit] | None, running: str | None) -> tuple[list[Commit], bool]:
    """The commits newer than ``running``, newest first, and whether the list is cut short.

    With no running commit to compare against, everything fetched is returned (the
    page then calls it "recent changes"). When the running commit is older than
    everything fetched, everything is returned and ``truncated`` is true.
    """
    if not commits:
        return [], False
    if running is None:
        return list(commits), False
    for index, commit in enumerate(commits):
        if commit.commit == running:
            return commits[:index], False
    return list(commits), True


@dataclass
class UpdaterStatus:
    available: bool
    state: str = "idle"
    commit: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    log: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "state": self.state,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "log": self.log,
            "error": self.error,
        }


class UpdaterUnavailable(RuntimeError):
    """The updater sidecar did not answer."""


class UpdateAlreadyRunning(RuntimeError):
    """The updater refused because an update is in progress."""


@dataclass
class UpdaterClient:
    settings: Settings
    transport: httpx.BaseTransport | None = None
    _headers: dict[str, str] = field(init=False)

    def __post_init__(self) -> None:
        self._headers = {"X-Updater-Token": updater_token(self.settings.secret_key)}

    @property
    def enabled(self) -> bool:
        return bool(self.settings.updater_url)

    def status(self) -> UpdaterStatus:
        if not self.enabled:
            return UpdaterStatus(available=False)
        try:
            with httpx.Client(timeout=TIMEOUT, transport=self.transport) as client:
                resp = client.get(f"{self.settings.updater_url.rstrip('/')}/status", headers=self._headers)
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:  # noqa: BLE001 - not deployed, or mid-restart
            log.info("updater not reachable: %s", exc)
            return UpdaterStatus(available=False)
        return UpdaterStatus(
            available=True,
            state=str(data.get("state") or "idle"),
            commit=data.get("commit") or None,
            started_at=data.get("started_at"),
            finished_at=data.get("finished_at"),
            log=data.get("log") or None,
            error=data.get("error") or None,
        )

    def start_update(self) -> dict[str, Any]:
        if not self.enabled:
            raise UpdaterUnavailable("self-update is not configured")
        try:
            with httpx.Client(timeout=TIMEOUT, transport=self.transport) as client:
                resp = client.post(f"{self.settings.updater_url.rstrip('/')}/update", headers=self._headers)
        except Exception as exc:  # noqa: BLE001
            raise UpdaterUnavailable(f"the updater is not reachable: {exc.__class__.__name__}") from exc
        if resp.status_code == 409:
            raise UpdateAlreadyRunning("an update is already running")
        if resp.status_code >= 400:
            raise UpdaterUnavailable(f"the updater answered {resp.status_code}")
        return resp.json()


def system_info(settings: Settings, github: GitHubClient, updater: UpdaterClient, *, force_check: bool = False) -> dict:
    """The payload behind ``GET /api/system``."""
    status = updater.status()
    commits = github.commits(force=force_check)
    latest = commits[0] if commits else None
    running = status.commit
    update_available: bool | None
    if running and latest:
        update_available = running != latest.commit
    else:
        update_available = None
    changes, truncated = changes_since(commits, running)
    return {
        "app": {"name": APP_NAME, "version": APP_VERSION},
        "repository": settings.update_repo,
        "branch": settings.update_branch,
        "running": {"commit": running, "short": running[:7] if running else None},
        "latest": latest.to_dict() if latest else None,
        "changes": [c.to_dict() for c in changes],
        "changes_truncated": truncated,
        "update_available": update_available,
        "update_check_enabled": github.enabled,
        "updater": status.to_dict(),
        "checked_at": datetime.now(UTC).isoformat(),
    }
