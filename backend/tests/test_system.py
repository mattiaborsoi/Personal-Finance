"""Settings -> System: version lookup against GitHub and the updater sidecar.

Both collaborators are faked with ``httpx.MockTransport`` so no network is used.
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.config import Settings
from app.services import updates
from app.services.updates import GitHubClient, UpdaterClient, system_info, updater_token

RUNNING = "2cb7f15116ea34f432581aca12a1b500396bfe9f"
LATEST = "9f1c0d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d"
MIDDLE = "5e5e5e5e6f6f6f6f7a7a7a7a8b8b8b8b9c9c9c9c"
OLDER = "1a1a1a1a2b2b2b2b3c3c3c3c4d4d4d4d5e5e5e5e"
UNKNOWN = "0000000000000000000000000000000000000000"

# What GitHub lists for the branch, newest first: the server runs the third one.
COMMITS = [
    (LATEST, "Split transactions into parts\n\nLonger body.", "2026-09-26T15:13:00Z"),
    (MIDDLE, "Settings: AI tab", "2026-09-25T09:30:00Z"),
    (RUNNING, "Editable accounts", "2026-09-24T18:00:00Z"),
    (OLDER, "First commit", "2026-09-20T10:00:00Z"),
]


def _settings(**overrides) -> Settings:
    base = dict(
        secret_key="unit-test-only",
        primary_password="primary-pass",
        secondary_password="secondary-pass",
        updater_url="http://updater:9000",
        update_repo="example/settl",
        update_branch="main",
        update_check=True,
        github_api_url="https://api.github.test",
        _env_file=None,
    )
    base.update(overrides)
    return Settings(**base)


def _github_transport(status: int = 200) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/example/settl/commits"
        assert request.url.params["sha"] == "main" and request.url.params["per_page"] == "30"
        assert request.headers["Accept"] == "application/vnd.github+json"
        if status != 200:
            return httpx.Response(status, json={"message": "rate limited"})
        listed = [
            {"sha": sha, "commit": {"message": message, "committer": {"date": date}}} for sha, message, date in COMMITS
        ]
        return httpx.Response(200, json=listed)

    return httpx.MockTransport(handler)


class FakeUpdater:
    """In-memory stand-in for updater/updater.py."""

    def __init__(self, settings: Settings, commit: str | None = RUNNING) -> None:
        self.token = updater_token(settings.secret_key)
        self.commit = commit
        self.state = {"state": "idle", "started_at": None, "finished_at": None, "log": "", "error": None}
        self.calls: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(f"{request.method} {request.url.path}")
        if request.headers.get("X-Updater-Token") != self.token:
            return httpx.Response(401, json={"detail": "bad token"})
        if request.method == "GET" and request.url.path == "/status":
            return httpx.Response(200, json={**self.state, "commit": self.commit, "branch": "main"})
        if request.method == "POST" and request.url.path == "/update":
            if self.state["state"] == "running":
                return httpx.Response(409, json={"detail": "an update is already running"})
            self.state.update(state="running", started_at="2026-09-26T16:00:00+00:00")
            return httpx.Response(202, json={"state": "running", "started_at": self.state["started_at"]})
        return httpx.Response(404, json={"detail": "not found"})

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


def test_token_is_derived_from_the_secret_and_never_the_secret_itself():
    token = updater_token("abc")
    assert len(token) == 64 and token != "abc" and token == updater_token("abc")
    assert updater_token("abd") != token


def test_system_info_reports_an_available_update():
    settings = _settings()
    fake = FakeUpdater(settings)
    github = GitHubClient(settings, transport=_github_transport())
    info = system_info(settings, github, UpdaterClient(settings, transport=fake.transport))
    assert info["running"] == {"commit": RUNNING, "short": RUNNING[:7]}
    assert info["latest"]["short"] == LATEST[:7]
    assert info["latest"]["message"] == "Split transactions into parts"
    assert info["latest"]["date"].startswith("2026-09-26T15:13:00")
    assert info["update_available"] is True
    # Every commit newer than the running one, newest first: the changelog of the skipped updates.
    assert [c["short"] for c in info["changes"]] == [LATEST[:7], MIDDLE[:7]]
    assert info["changes"][1]["message"] == "Settings: AI tab"
    assert info["changes"][1]["date"].startswith("2026-09-25T09:30:00")
    assert info["changes_truncated"] is False
    assert info["updater"]["available"] is True and info["updater"]["state"] == "idle"
    assert info["update_check_enabled"] is True


def test_changes_are_everything_fetched_when_the_running_commit_is_older_still():
    settings = _settings()
    fake = FakeUpdater(settings, commit=UNKNOWN)
    github = GitHubClient(settings, transport=_github_transport())
    info = system_info(settings, github, UpdaterClient(settings, transport=fake.transport))
    assert info["update_available"] is True
    assert [c["short"] for c in info["changes"]] == [LATEST[:7], MIDDLE[:7], RUNNING[:7], OLDER[:7]]
    assert info["changes_truncated"] is True

    assert updates.changes_since(None, RUNNING) == ([], False)
    assert updates.changes_since([], None) == ([], False)


def test_up_to_date_and_cached_lookup():
    settings = _settings()
    fake = FakeUpdater(settings, commit=LATEST)
    calls = {"n": 0}

    def counting(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return _github_transport().handler(request)

    github = GitHubClient(settings, transport=httpx.MockTransport(counting))
    updater = UpdaterClient(settings, transport=fake.transport)
    info = system_info(settings, github, updater)
    assert info["update_available"] is False
    assert info["changes"] == [] and info["changes_truncated"] is False
    system_info(settings, github, updater)
    assert calls["n"] == 1  # second call served from the cache
    system_info(settings, github, updater, force_check=True)
    assert calls["n"] == 2


def test_offline_or_disabled_degrades_to_unknown():
    settings = _settings()
    fake = FakeUpdater(settings)
    github = GitHubClient(settings, transport=_github_transport(status=403))
    info = system_info(settings, github, UpdaterClient(settings, transport=fake.transport))
    assert info["latest"] is None and info["update_available"] is None
    assert info["changes"] == [] and info["changes_truncated"] is False

    disabled = _settings(update_check=False)
    github = GitHubClient(disabled, transport=_github_transport())
    info = system_info(disabled, github, UpdaterClient(disabled, transport=fake.transport))
    assert info["latest"] is None and info["update_check_enabled"] is False

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    info = system_info(settings, GitHubClient(settings, transport=_github_transport()),
                       UpdaterClient(settings, transport=httpx.MockTransport(down)))
    assert info["updater"] == {
        "available": False, "state": "idle", "started_at": None, "finished_at": None, "log": None, "error": None
    }
    assert info["running"] == {"commit": None, "short": None} and info["update_available"] is None
    # Nothing to compare against, so the whole fetched list is offered as "recent changes".
    assert len(info["changes"]) == len(COMMITS) and info["changes_truncated"] is False


def test_start_update_and_conflicts():
    settings = _settings()
    fake = FakeUpdater(settings)
    client = UpdaterClient(settings, transport=fake.transport)
    assert client.start_update()["state"] == "running"
    with pytest.raises(updates.UpdateAlreadyRunning):
        client.start_update()
    assert client.status().state == "running"

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(updates.UpdaterUnavailable):
        UpdaterClient(settings, transport=httpx.MockTransport(down)).start_update()
    wrong = UpdaterClient(_settings(secret_key="unit-test-other"), transport=fake.transport)
    with pytest.raises(updates.UpdaterUnavailable):
        wrong.start_update()  # a 401 from the updater is reported as unavailable, never retried


def test_default_github_dependency_is_a_shared_client():
    from app.routers import system as system_router

    settings = _settings()
    first = system_router.get_github(settings)
    assert isinstance(first, GitHubClient)
    assert system_router.get_github(settings) is first  # the cache lives across requests
    assert system_router.get_github(_settings()) is not first  # new settings object, new client
    assert isinstance(system_router.get_updater(settings), UpdaterClient)


def test_system_endpoints_are_primary_only(client, primary_headers, secondary_headers):
    from app.routers import system as system_router

    settings = _settings()
    fake = FakeUpdater(settings)
    client.app.dependency_overrides[system_router.get_github] = lambda: GitHubClient(
        settings, transport=_github_transport()
    )
    client.app.dependency_overrides[system_router.get_updater] = lambda: UpdaterClient(
        settings, transport=fake.transport
    )
    assert client.get("/api/system", headers=secondary_headers).status_code == 403
    info = client.get("/api/system", headers=primary_headers).json()
    assert info["app"]["name"] == "Settl" and info["update_available"] is True
    assert client.post("/api/system/check", headers=primary_headers).status_code == 200
    started = client.post("/api/system/update", headers=primary_headers)
    assert started.status_code == 202, started.text
    assert json.loads(started.text)["state"] == "running"
    assert client.post("/api/system/update", headers=primary_headers).status_code == 409
    assert client.get("/api/system", headers=primary_headers).json()["updater"]["state"] == "running"
