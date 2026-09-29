"""Database backups (Settings -> System -> Backups).

``pg_dump`` is faked by replacing ``subprocess.run`` in the service, so these run
anywhere; only ``test_real_dump_of_the_test_database`` needs the real binary and
is skipped without it.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from app.config import Settings
from app.services import backups
from app.services.backups import BackupError, InvalidBackupName
from tests.conftest import requires_db
from tests.test_system import FakeUpdater, _github_transport
from tests.test_system import _settings as _system_settings

NOW = datetime(2026, 9, 29, 12, 0, 0, tzinfo=UTC)
SECRET = "s3cr3t:p@ss/word"
DB_URL = "postgresql://settl:s3cr3t%3Ap%40ss%2Fword@dbhost:5433/ledger"


def _settings(tmp_path: Path, **overrides) -> Settings:
    base = dict(
        database_url=DB_URL,
        backup_dir=str(tmp_path / "backups"),
        secret_key="unit-test-only",
        primary_password="primary-pass",
        secondary_password="secondary-pass",
        _env_file=None,
    )
    base.update(overrides)
    return Settings(**base)


def _touch(directory: Path, name: str, size: int = 10) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_bytes(b"PGDMP" + b"x" * max(0, size - 5))
    return path


class FakePgDump:
    """Stands in for ``subprocess.run(["pg_dump", ...])``: records the call and writes the file."""

    def __init__(self, returncode: int = 0, stderr: str = "", content: bytes = b"PGDMP-synthetic") -> None:
        self.returncode = returncode
        self.stderr = stderr
        self.content = content
        self.calls: list[tuple[list[str], dict[str, str]]] = []

    def __call__(self, cmd, env=None, **kwargs):
        self.calls.append((list(cmd), dict(env or {})))
        target = Path(cmd[cmd.index("--file") + 1])
        if self.returncode == 0:
            target.write_bytes(self.content)
        else:
            target.write_bytes(b"half")
        return subprocess.CompletedProcess(cmd, self.returncode, stdout="", stderr=self.stderr)


@pytest.fixture
def fake_dump(monkeypatch) -> FakePgDump:
    fake = FakePgDump()
    monkeypatch.setattr(backups.subprocess, "run", fake)
    return fake


# --------------------------------------------------------------------------- #
# Names, connection details
# --------------------------------------------------------------------------- #


def test_names_round_trip_and_reject_anything_else():
    name = backups.backup_name("pre-update", NOW)
    assert name == "settl-20260929-120000-pre-update.dump"
    assert backups.parse_name(name) == ("pre-update", NOW)
    for bad in [
        "settl-20260929-120000-weekly.dump",
        "settl-20260929-120000-nightly.dump.partial",
        ".settl-20260929-120000-nightly.dump.partial",
        "../settl-20260929-120000-nightly.dump",
        "settl-2026092-120000-nightly.dump",
        "settl-20261399-120000-nightly.dump",  # well-shaped but not a date
        "SETTL-20260929-120000-nightly.dump",
        "settl-20260929-120000-nightly.dump/",
    ]:
        assert backups.parse_name(bad) is None, bad
    with pytest.raises(ValueError):
        backups.backup_name("weekly", NOW)


def test_connection_details_come_from_the_url_and_the_password_only_via_pgpassword(monkeypatch):
    monkeypatch.setenv("PGSERVICE", "should-not-leak")
    conn, password = backups.pg_connection(DB_URL)
    assert conn == {"PGHOST": "dbhost", "PGPORT": "5433", "PGUSER": "settl", "PGDATABASE": "ledger"}
    assert password == SECRET
    env = backups.pg_env("postgresql+psycopg://settl:pw@db:5432/ledger")
    assert env["PGPASSWORD"] == "pw" and env["PGHOST"] == "db" and "PGSERVICE" not in env
    with pytest.raises(BackupError):
        backups.pg_connection("sqlite:///x.db")


# --------------------------------------------------------------------------- #
# Creating and listing
# --------------------------------------------------------------------------- #


def test_create_backup_writes_a_complete_file_without_the_password_on_the_command_line(tmp_path, fake_dump, caplog):
    settings = _settings(tmp_path)
    caplog.set_level("INFO")
    made = backups.create_backup(settings, "manual", now=NOW)
    assert made.name == "settl-20260929-120000-manual.dump"
    assert made.kind == "manual" and made.created_at == NOW and made.bytes == len(fake_dump.content)
    directory = tmp_path / "backups"
    assert sorted(p.name for p in directory.iterdir()) == [made.name]  # no temporary file left behind
    cmd, env = fake_dump.calls[0]
    assert cmd[:2] == ["pg_dump", "-Fc"]
    assert Path(cmd[cmd.index("--file") + 1]).name.endswith(".partial")  # written under a temporary name
    assert SECRET not in " ".join(cmd) and env["PGPASSWORD"] == SECRET
    assert env["PGDATABASE"] == "ledger" and env["PGHOST"] == "dbhost"
    assert SECRET not in caplog.text and "settl-20260929-120000-manual.dump (15 B)" in caplog.text

    # A second one in the same second gets the next second rather than overwriting.
    again = backups.create_backup(settings, "manual", now=NOW)
    assert again.name == "settl-20260929-120001-manual.dump"
    assert [b.name for b in backups.list_backups(settings)] == [again.name, made.name]
    with pytest.raises(ValueError):
        backups.create_backup(settings, "weekly")


def test_a_failed_dump_leaves_nothing_and_never_reports_the_password(tmp_path, monkeypatch, caplog):
    settings = _settings(tmp_path)
    fake = FakePgDump(returncode=1, stderr=f"pg_dump: error: connection failed for password {SECRET}")
    monkeypatch.setattr(backups.subprocess, "run", fake)
    with pytest.raises(BackupError) as excinfo:
        backups.create_backup(settings, "nightly", now=NOW)
    assert SECRET not in str(excinfo.value) and "connection failed" in str(excinfo.value)
    assert SECRET not in caplog.text
    assert list((tmp_path / "backups").iterdir()) == []


def test_missing_pg_dump_is_a_backup_error(tmp_path, monkeypatch):
    def missing(*args, **kwargs):
        raise FileNotFoundError("pg_dump")

    monkeypatch.setattr(backups.subprocess, "run", missing)
    with pytest.raises(BackupError, match="not installed"):
        backups.create_backup(_settings(tmp_path), "manual")


def test_list_ignores_other_files_and_sorts_newest_first(tmp_path):
    settings = _settings(tmp_path)
    directory = tmp_path / "backups"
    assert backups.list_backups(settings) == []  # no folder yet
    _touch(directory, "settl-20260901-010000-nightly.dump")
    _touch(directory, "settl-20260915-010000-pre-update.dump", size=2_100_000)
    _touch(directory, ".settl-20260920-010000-manual.dump.partial")
    _touch(directory, "notes.txt")
    (directory / "settl-20260910-010000-manual.dump").mkdir()
    listed = backups.list_backups(settings)
    assert [b.name for b in listed] == ["settl-20260915-010000-pre-update.dump", "settl-20260901-010000-nightly.dump"]
    assert listed[0].to_dict() == {
        "name": "settl-20260915-010000-pre-update.dump",
        "kind": "pre-update",
        "created_at": "2026-09-15T01:00:00+00:00",
        "bytes": 2_100_000,
    }
    assert backups.human_size(2_100_000) == "2.1 MB" and backups.human_size(512) == "512 B"


def test_summary_is_stale_without_a_backup_or_when_the_newest_is_older_than_36_hours(tmp_path):
    settings = _settings(tmp_path)
    empty = backups.summary(settings, now=NOW)
    assert empty == {"enabled": True, "count": 0, "last": None, "stale": True, "recent": []}
    _touch(tmp_path / "backups", "settl-20260928-010000-nightly.dump")  # 35 h before NOW
    fresh = backups.summary(settings, now=NOW)
    assert fresh["count"] == 1 and fresh["stale"] is False and fresh["last"]["kind"] == "nightly"
    assert backups.summary(settings, now=NOW + timedelta(hours=2))["stale"] is True
    assert backups.summary(_settings(tmp_path, backups_enabled=False), now=NOW)["enabled"] is False


# --------------------------------------------------------------------------- #
# Retention
# --------------------------------------------------------------------------- #


def test_prune_keeps_14_daily_8_weekly_12_monthly_and_10_of_each_other_kind(tmp_path):
    settings = _settings(tmp_path)
    directory = tmp_path / "backups"
    end = date(2026, 9, 29)  # a Tuesday
    for offset in range(400):
        day = end - timedelta(days=offset)
        _touch(directory, f"settl-{day:%Y%m%d}-020000-nightly.dump")
        if offset == 0:
            _touch(directory, f"settl-{day:%Y%m%d}-010000-nightly.dump")  # an earlier one the same day
    for n in range(15):
        _touch(directory, f"settl-202609{n + 1:02d}-120000-pre-update.dump")
    for n in range(12):
        _touch(directory, f"settl-202608{n + 1:02d}-120000-manual.dump")
    _touch(directory, "keep-me.txt")

    deleted = backups.prune_backups(settings)
    left = {b.name: b for b in backups.list_backups(settings)}
    nightly = sorted(n for n, b in left.items() if b.kind == "nightly")
    days = sorted(n[6:14] for n in nightly)

    # The last 14 days, the Sundays that close the five weeks before those (the current
    # week and the two before are already covered), and the last day of 11 earlier months.
    expected_days = [f"{end - timedelta(days=d):%Y%m%d}" for d in range(14)]
    expected_days += ["20260913", "20260906", "20260830", "20260823", "20260816"]
    expected_days += ["20260831", "20260731", "20260630", "20260531", "20260430", "20260331", "20260228",
                      "20260131", "20251231", "20251130", "20251031"]
    assert days == sorted(expected_days)
    assert len(nightly) == 30
    assert "settl-20260929-010000-nightly.dump" not in left  # only the newest of a day is kept
    assert sorted(n for n, b in left.items() if b.kind == "pre-update") == [
        f"settl-202609{n:02d}-120000-pre-update.dump" for n in range(6, 16)
    ]
    assert len([b for b in left.values() if b.kind == "manual"]) == 10
    assert "settl-20260801-120000-manual.dump" not in left
    assert (directory / "keep-me.txt").exists()  # other files are never touched
    assert len(deleted) == 401 + 15 + 12 - 30 - 10 - 10
    assert backups.prune_backups(settings) == []  # idempotent


def test_prune_never_deletes_the_newest_backup_of_a_kind(tmp_path, monkeypatch):
    settings = _settings(tmp_path)
    directory = tmp_path / "backups"
    _touch(directory, "settl-20200101-000000-manual.dump")
    _touch(directory, "settl-20190101-000000-manual.dump")
    _touch(directory, "settl-20200101-000000-pre-update.dump")
    monkeypatch.setattr(backups, "KEEP_MANUAL", 0)
    monkeypatch.setattr(backups, "KEEP_PRE_UPDATE", 0)
    backups.prune_backups(settings)
    assert sorted(b.name for b in backups.list_backups(settings)) == [
        "settl-20200101-000000-manual.dump",
        "settl-20200101-000000-pre-update.dump",
    ]


# --------------------------------------------------------------------------- #
# Scheduler
# --------------------------------------------------------------------------- #


def test_scheduled_dump_only_when_the_newest_nightly_is_old_enough(tmp_path, fake_dump):
    settings = _settings(tmp_path)
    directory = tmp_path / "backups"
    _touch(directory, "settl-20260929-080000-manual.dump")  # other kinds do not count
    assert backups.nightly_due(settings, now=NOW) is True
    made = backups.run_scheduled(settings, now=NOW)
    assert made is not None and made.name == "settl-20260929-120000-nightly.dump"
    # After a restart, the file on disk says it is not due again for 24 hours.
    assert backups.run_scheduled(settings, now=NOW + timedelta(hours=23)) is None
    assert backups.run_scheduled(settings, now=NOW + timedelta(hours=24)) is not None
    assert len(fake_dump.calls) == 2
    assert backups.nightly_due(_settings(tmp_path, backup_interval_hours=100), now=NOW + timedelta(hours=30)) is False


def test_scheduled_failure_is_logged_not_raised(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(backups.subprocess, "run", FakePgDump(returncode=1, stderr="could not connect"))
    assert backups.run_scheduled(_settings(tmp_path), now=NOW) is None
    assert "scheduled backup failed" in caplog.text


def test_the_scheduler_thread_is_off_under_tests_and_when_disabled(tmp_path):
    assert backups.scheduler_wanted(_settings(tmp_path)) is False  # pytest is loaded
    assert backups.scheduler_wanted(_settings(tmp_path, backups_enabled=False)) is False


def test_dumps_never_overlap(tmp_path, monkeypatch):
    import threading

    settings = _settings(tmp_path)
    running = {"now": 0, "max": 0}
    gate = threading.Event()

    def slow(cmd, env=None, **kwargs):
        running["now"] += 1
        running["max"] = max(running["max"], running["now"])
        gate.wait(0.2)
        Path(cmd[cmd.index("--file") + 1]).write_bytes(b"PGDMP")
        running["now"] -= 1
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(backups.subprocess, "run", slow)
    threads = [threading.Thread(target=backups.create_backup, args=(settings, kind)) for kind in ("manual", "nightly")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert running["max"] == 1 and len(backups.list_backups(settings)) == 2


def test_resolve_rejects_names_outside_the_scheme(tmp_path):
    settings = _settings(tmp_path)
    _touch(tmp_path / "backups", "settl-20260929-120000-manual.dump")
    _touch(tmp_path, "settl-20260929-120000-nightly.dump")  # outside BACKUP_DIR
    assert backups.resolve_backup(settings, "settl-20260929-120000-manual.dump").name.endswith("manual.dump")
    for bad in ["../settl-20260929-120000-nightly.dump", "/etc/passwd", "..", "notes.txt"]:
        with pytest.raises(InvalidBackupName):
            backups.resolve_backup(settings, bad)
    with pytest.raises(FileNotFoundError):
        backups.resolve_backup(settings, "settl-20260929-120000-nightly.dump")


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #


@pytest.fixture
def api(client, tmp_path):
    """The test client with BACKUP_DIR in a temporary folder and the GitHub / updater fakes."""
    from app.deps import get_settings
    from app.routers import system as system_router

    current = client.app.dependency_overrides[get_settings]()
    settings = current.model_copy(update={"backup_dir": str(tmp_path / "backups")})
    client.app.dependency_overrides[get_settings] = lambda: settings
    fake_settings = _system_settings()
    fake = FakeUpdater(fake_settings)
    client.app.dependency_overrides[system_router.get_github] = lambda: system_router.GitHubClient(
        fake_settings, transport=_github_transport()
    )
    client.app.dependency_overrides[system_router.get_updater] = lambda: system_router.UpdaterClient(
        fake_settings, transport=fake.transport
    )
    client.updater = fake  # type: ignore[attr-defined]
    client.backup_dir = tmp_path / "backups"  # type: ignore[attr-defined]
    client.backup_settings = settings  # type: ignore[attr-defined]
    return client


@requires_db
def test_system_payload_reports_backups(api, primary_headers):
    info = api.get("/api/system", headers=primary_headers).json()
    assert set(info["backups"]) == {"enabled", "count", "last", "stale", "recent"}
    assert info["backups"]["count"] == 0 and info["backups"]["last"] is None and info["backups"]["stale"] is True
    name = backups.backup_name("nightly", datetime.now(UTC) - timedelta(hours=6))
    _touch(api.backup_dir, name, size=2_100_000)
    info = api.post("/api/system/check", headers=primary_headers).json()
    assert info["backups"]["last"]["name"] == name and info["backups"]["last"]["bytes"] == 2_100_000
    assert info["backups"]["stale"] is False and info["backups"]["count"] == 1


@requires_db
def test_backup_endpoints_are_primary_only(api, secondary_headers):
    name = "settl-20260929-120000-manual.dump"
    _touch(api.backup_dir, name)
    for method, url in [
        ("GET", "/api/system/backups"),
        ("POST", "/api/system/backups"),
        ("GET", f"/api/system/backups/{name}"),
        ("DELETE", f"/api/system/backups/{name}"),
    ]:
        assert api.request(method, url, headers=secondary_headers).status_code == 403, url
    assert api.get("/api/system/backups").status_code == 401
    assert (api.backup_dir / name).exists()


@requires_db
def test_manual_backup_list_download_and_delete(api, primary_headers, fake_dump):
    made = api.post("/api/system/backups", headers=primary_headers)
    assert made.status_code == 201, made.text
    item = made.json()
    assert item["kind"] == "manual" and item["bytes"] == len(fake_dump.content)
    assert backups.parse_name(item["name"]) is not None
    _touch(api.backup_dir, "settl-20200101-000000-nightly.dump")
    listed = api.get("/api/system/backups", headers=primary_headers).json()
    assert [b["name"] for b in listed] == [item["name"], "settl-20200101-000000-nightly.dump"]

    download = api.get(f"/api/system/backups/{item['name']}", headers=primary_headers)
    assert download.status_code == 200
    assert download.content == fake_dump.content
    assert download.headers["content-type"] == "application/octet-stream"
    assert item["name"] in download.headers["content-disposition"]

    assert api.delete(f"/api/system/backups/{item['name']}", headers=primary_headers).status_code == 204
    assert not (api.backup_dir / item["name"]).exists()
    assert api.delete(f"/api/system/backups/{item['name']}", headers=primary_headers).status_code == 404


@requires_db
def test_download_and_delete_refuse_anything_but_a_backup_name(api, primary_headers, tmp_path):
    _touch(api.backup_dir, "notes.txt")
    _touch(tmp_path, "settl-20260929-120000-nightly.dump")  # beside BACKUP_DIR, not in it
    (tmp_path / "secret.txt").write_text("synthetic")
    for bad in [
        "notes.txt",
        "..%2Fsecret.txt",
        "..%2Fsettl-20260929-120000-nightly.dump",
        "%2E%2E%2Fsettl-20260929-120000-nightly.dump",
        "settl-20260929-120000-nightly.dump%00.txt",
        "settl-20260929-120000-weekly.dump",
        "settl-20260929-120000-nightly.dump",  # well formed, but not in BACKUP_DIR
        "%2E%2E",
    ]:
        for method in ("GET", "DELETE"):
            resp = api.request(method, f"/api/system/backups/{bad}", headers=primary_headers)
            assert resp.status_code in (404, 405), (method, bad, resp.status_code)
            assert b"synthetic" not in resp.content and b"PGDMP" not in resp.content
    assert (api.backup_dir / "notes.txt").exists() and (tmp_path / "secret.txt").exists()
    assert (tmp_path / "settl-20260929-120000-nightly.dump").exists()


@requires_db
def test_update_takes_a_pre_update_backup_first(api, primary_headers, fake_dump):
    started = api.post("/api/system/update", headers=primary_headers)
    assert started.status_code == 202, started.text
    assert [b.kind for b in backups.list_backups(api.backup_settings)] == ["pre-update"]
    assert "POST /update" in api.updater.calls


@requires_db
def test_update_is_refused_when_the_backup_fails(api, primary_headers, monkeypatch):
    from app.routers import system as system_router

    def failing(settings, kind, **kwargs):
        raise BackupError("pg_dump failed: could not connect")

    monkeypatch.setattr(system_router.backups_service, "create_backup", failing)
    refused = api.post("/api/system/update", headers=primary_headers)
    assert refused.status_code == 409
    detail = refused.json()["detail"]
    assert detail.startswith("The backup before updating failed, so the update was not started")
    assert "could not connect" in detail
    assert "POST /update" not in api.updater.calls

    skipped = api.post("/api/system/update", params={"skip_backup": "true"}, headers=primary_headers)
    assert skipped.status_code == 202, skipped.text
    assert "POST /update" in api.updater.calls


@requires_db
def test_update_does_not_back_up_when_the_updater_cannot_run_it(api, primary_headers, fake_dump):
    from app.routers import system as system_router

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    fake_settings = _system_settings()
    api.app.dependency_overrides[system_router.get_updater] = lambda: system_router.UpdaterClient(
        fake_settings, transport=httpx.MockTransport(down)
    )
    assert api.post("/api/system/update", headers=primary_headers).status_code == 503
    assert fake_dump.calls == []


def _pg_dump_major() -> int | None:
    if shutil.which("pg_dump") is None:
        return None
    try:
        out = subprocess.run(["pg_dump", "--version"], capture_output=True, text=True, timeout=10).stdout
        match = re.search(r"\(PostgreSQL\) (\d+)", out)
        return int(match.group(1)) if match else None
    except (OSError, subprocess.SubprocessError):
        return None


@pytest.mark.skipif((_pg_dump_major() or 0) < 16, reason="needs pg_dump 16 or newer (the backend image has it)")
@requires_db
def test_real_dump_of_the_test_database(engine, settings, tmp_path):
    local = settings.model_copy(update={"backup_dir": str(tmp_path / "backups")})
    made = backups.create_backup(local, "manual")
    assert made.bytes > 0
    assert made.path.read_bytes()[:5] == b"PGDMP"
    listed = subprocess.run(["pg_restore", "--list", str(made.path)], capture_output=True, text=True, check=True)
    assert "TABLE public transactions" in listed.stdout
