"""Database backups: ``pg_dump`` files in ``BACKUP_DIR`` (Settings -> System -> Backups).

Each backup is one custom-format dump (``pg_dump -Fc``) named
``settl-YYYYMMDD-HHMMSS-<kind>.dump`` (UTC), where ``kind`` says why it was taken:

* ``nightly``: by the scheduler below, when the newest nightly dump is older than
  ``BACKUP_INTERVAL_HOURS``;
* ``manual``: "Back up now" in the app;
* ``pre-update``: taken by ``POST /api/system/update`` before the updater is asked
  to pull and rebuild.

A dump is written under a hidden temporary name and renamed into place once
``pg_dump`` succeeds, so a listed file is always complete. One process-wide lock
makes sure two dumps never run at the same time. The database password is passed
to ``pg_dump`` through ``PGPASSWORD`` and never appears on a command line or in a
log line.

Retention (``prune_backups``): the newest nightly dump of each of the last 14
days, of each of the last 8 ISO weeks and of each of the last 12 months, and the
10 newest pre-update and manual dumps. The newest file of every kind is never
deleted, and files that do not follow the naming scheme are never touched.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import sys
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from app.config import Settings

log = logging.getLogger(__name__)

KINDS = ("nightly", "manual", "pre-update")
NAME_RE = re.compile(r"^settl-(\d{8})-(\d{6})-(nightly|manual|pre-update)\.dump$")
STALE_AFTER = timedelta(hours=36)
"""The System tab warns when the newest backup is older than this (or there is none)."""
DUMP_TIMEOUT_SECONDS = 3600
SCHEDULER_WAKE_SECONDS = 30 * 60

KEEP_DAILY = 14
KEEP_WEEKLY = 8
KEEP_MONTHLY = 12
KEEP_PRE_UPDATE = 10
KEEP_MANUAL = 10

_dump_lock = threading.Lock()


class BackupError(RuntimeError):
    """``pg_dump`` (or writing its output) failed."""


class InvalidBackupName(ValueError):
    """A name that is not ``settl-YYYYMMDD-HHMMSS-<kind>.dump``: nothing is looked up for it."""


@dataclass(frozen=True)
class Backup:
    name: str
    kind: str
    created_at: datetime
    bytes: int
    path: Path

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "kind": self.kind, "created_at": self.created_at.isoformat(), "bytes": self.bytes}


# --------------------------------------------------------------------------- #
# Names and listing
# --------------------------------------------------------------------------- #


def backup_dir(settings: Settings) -> Path:
    return Path(settings.backup_dir)


def backup_name(kind: str, when: datetime) -> str:
    if kind not in KINDS:
        raise ValueError(f"unknown backup kind {kind!r}")
    return f"settl-{when.astimezone(UTC):%Y%m%d-%H%M%S}-{kind}.dump"


def parse_name(name: str) -> tuple[str, datetime] | None:
    """``(kind, created_at)`` for a well-formed backup name, else ``None``."""
    match = NAME_RE.fullmatch(name)
    if not match:
        return None
    try:
        created = datetime.strptime(match.group(1) + match.group(2), "%Y%m%d%H%M%S").replace(tzinfo=UTC)
    except ValueError:
        return None
    return match.group(3), created


def list_backups(settings: Settings) -> list[Backup]:
    """Every complete backup in ``BACKUP_DIR``, newest first."""
    directory = backup_dir(settings)
    if not directory.is_dir():
        return []
    found: list[Backup] = []
    for entry in directory.iterdir():
        parsed = parse_name(entry.name)
        if parsed is None or not entry.is_file():
            continue
        try:
            size = entry.stat().st_size
        except OSError:
            continue
        found.append(Backup(name=entry.name, kind=parsed[0], created_at=parsed[1], bytes=size, path=entry))
    found.sort(key=lambda b: (b.created_at, b.name), reverse=True)
    return found


def resolve_backup(settings: Settings, name: str) -> Path:
    """The path of an existing backup. ``InvalidBackupName`` for anything but a strict backup name
    (so ``..``, slashes and other files in the folder can never be reached); ``FileNotFoundError``
    when a well-formed name does not exist."""
    if parse_name(name) is None:
        raise InvalidBackupName("not a backup name")
    directory = backup_dir(settings).resolve()
    path = (directory / name).resolve()
    if path.parent != directory or not path.is_file():
        raise FileNotFoundError(name)
    return path


def delete_backup(settings: Settings, name: str) -> None:
    resolve_backup(settings, name).unlink()
    log.info("backup deleted: %s", name)


def summary(settings: Settings, *, now: datetime | None = None, recent: int = 5) -> dict[str, Any]:
    """The ``backups`` block of ``GET /api/system``."""
    now = now or datetime.now(UTC)
    backups = list_backups(settings)
    last = backups[0] if backups else None
    return {
        "enabled": settings.backups_enabled,
        "count": len(backups),
        "last": last.to_dict() if last else None,
        "stale": last is None or now - last.created_at > STALE_AFTER,
        "recent": [b.to_dict() for b in backups[:recent]],
    }


def human_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1000 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1000
    return f"{size} B"  # pragma: no cover


# --------------------------------------------------------------------------- #
# Dumping
# --------------------------------------------------------------------------- #


def pg_connection(database_url: str) -> tuple[dict[str, str], str | None]:
    """``PG*`` environment variables for ``DATABASE_URL``, and the password on its own.

    The password goes into ``PGPASSWORD`` only; the returned dict holds the rest.
    """
    parts = urlsplit(database_url)
    if not parts.scheme.startswith("postgres"):
        raise BackupError("DATABASE_URL is not a PostgreSQL URL")
    env: dict[str, str] = {}
    if parts.hostname:
        env["PGHOST"] = parts.hostname
    if parts.port:
        env["PGPORT"] = str(parts.port)
    if parts.username:
        env["PGUSER"] = unquote(parts.username)
    database = unquote(parts.path.lstrip("/"))
    if database:
        env["PGDATABASE"] = database
    password = unquote(parts.password) if parts.password is not None else None
    return env, password


def pg_env(database_url: str) -> dict[str, str]:
    """The process environment for ``pg_dump`` / ``pg_restore`` against ``database_url``."""
    conn, password = pg_connection(database_url)
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    env.update(conn)
    if password is not None:
        env["PGPASSWORD"] = password
    return env


def _scrub(text: str, secret: str | None) -> str:
    return text.replace(secret, "***") if secret else text


def _run_pg_dump(target: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    """Runs ``pg_dump`` into ``target`` (tests replace this)."""
    return subprocess.run(
        ["pg_dump", "-Fc", "--file", str(target)],
        env=env,
        capture_output=True,
        text=True,
        timeout=DUMP_TIMEOUT_SECONDS,
        check=False,
    )


def create_backup(settings: Settings, kind: str, *, now: datetime | None = None) -> Backup:
    """Dump the database into ``BACKUP_DIR``; raises ``BackupError`` when that fails.

    Waits for a dump already running (single flight), then writes to a temporary name
    and renames it into place, so a half-written file is never listed.
    """
    if kind not in KINDS:
        raise ValueError(f"unknown backup kind {kind!r}")
    with _dump_lock:
        directory = backup_dir(settings)
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise BackupError(f"cannot create the backup folder {directory}: {exc.strerror or exc}") from exc
        when = now or datetime.now(UTC)
        name = backup_name(kind, when)
        while (directory / name).exists():  # two in the same second
            when += timedelta(seconds=1)
            name = backup_name(kind, when)
        partial = directory / f".{name}.partial"
        _, password = pg_connection(settings.database_url)
        try:
            result = _run_pg_dump(partial, pg_env(settings.database_url))
        except FileNotFoundError as exc:
            partial.unlink(missing_ok=True)
            raise BackupError("pg_dump is not installed in this container") from exc
        except subprocess.TimeoutExpired as exc:
            partial.unlink(missing_ok=True)
            raise BackupError(f"pg_dump took longer than {DUMP_TIMEOUT_SECONDS} seconds") from exc
        if result.returncode != 0 or not partial.is_file() or partial.stat().st_size == 0:
            partial.unlink(missing_ok=True)
            detail = _scrub((result.stderr or result.stdout or "").strip(), password)
            detail = detail.splitlines()[-1] if detail else f"exit status {result.returncode}"
            log.error("backup failed (%s): %s", kind, detail)
            raise BackupError(f"pg_dump failed: {detail[:300]}")
        final = directory / name
        os.replace(partial, final)
        size = final.stat().st_size
        log.info("backup written: %s (%s)", name, human_size(size))
        return Backup(name=name, kind=kind, created_at=when.astimezone(UTC).replace(microsecond=0), bytes=size,
                      path=final)


# --------------------------------------------------------------------------- #
# Retention
# --------------------------------------------------------------------------- #


def _newest_per(backups: list[Backup], key, limit: int) -> set[str]:
    """The newest backup of each of the ``limit`` newest ``key`` buckets (``backups`` newest first)."""
    kept: dict[object, str] = {}
    for backup in backups:
        bucket = key(backup.created_at)
        if bucket not in kept:
            if len(kept) >= limit:
                break
            kept[bucket] = backup.name
    return set(kept.values())


def retained(backups: list[Backup]) -> set[str]:
    """The names ``prune_backups`` keeps, from a newest-first list."""
    keep: set[str] = set()
    by_kind = {kind: [b for b in backups if b.kind == kind] for kind in KINDS}
    nightly = by_kind["nightly"]
    keep |= _newest_per(nightly, lambda d: d.date(), KEEP_DAILY)
    keep |= _newest_per(nightly, lambda d: d.isocalendar()[:2], KEEP_WEEKLY)
    keep |= _newest_per(nightly, lambda d: (d.year, d.month), KEEP_MONTHLY)
    keep |= {b.name for b in by_kind["pre-update"][:KEEP_PRE_UPDATE]}
    keep |= {b.name for b in by_kind["manual"][:KEEP_MANUAL]}
    keep |= {items[0].name for items in by_kind.values() if items}  # never the newest of any kind
    return keep


def prune_backups(settings: Settings) -> list[str]:
    """Delete the backups the retention policy no longer keeps; returns their names."""
    backups = list_backups(settings)
    keep = retained(backups)
    deleted: list[str] = []
    for backup in backups:
        if backup.name in keep:
            continue
        try:
            backup.path.unlink()
            deleted.append(backup.name)
        except OSError as exc:
            log.warning("could not delete old backup %s: %s", backup.name, exc.strerror or exc)
    if deleted:
        log.info("pruned %d old backup(s)", len(deleted))
    return deleted


# --------------------------------------------------------------------------- #
# Scheduler
# --------------------------------------------------------------------------- #


def nightly_due(settings: Settings, *, now: datetime | None = None) -> bool:
    now = now or datetime.now(UTC)
    newest = next((b for b in list_backups(settings) if b.kind == "nightly"), None)
    return newest is None or now - newest.created_at >= timedelta(hours=settings.backup_interval_hours)


def run_scheduled(settings: Settings, *, now: datetime | None = None) -> Backup | None:
    """One scheduler tick: a nightly dump when one is due, then pruning. Never raises."""
    made: Backup | None = None
    try:
        if nightly_due(settings, now=now):
            made = create_backup(settings, "nightly", now=now)
    except Exception as exc:  # noqa: BLE001 - logged; the next tick tries again
        log.error("scheduled backup failed: %s", exc)
    try:
        prune_backups(settings)
    except Exception as exc:  # noqa: BLE001
        log.warning("pruning backups failed: %s", exc)
    return made


class BackupScheduler:
    """A daemon thread that wakes every 30 minutes and calls ``run_scheduled``.

    Due-ness is worked out from the files on disk, so a restart neither loses a
    backup nor takes an extra one.
    """

    def __init__(self, settings: Settings, wake_seconds: float = SCHEDULER_WAKE_SECONDS) -> None:
        self.settings = settings
        self.wake_seconds = wake_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="settl-backups", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            run_scheduled(self.settings)
            self._stop.wait(self.wake_seconds)


def scheduler_wanted(settings: Settings) -> bool:
    """False when ``BACKUPS_ENABLED=false`` or under pytest."""
    return settings.backups_enabled and "pytest" not in sys.modules and not os.environ.get("PYTEST_CURRENT_TEST")
