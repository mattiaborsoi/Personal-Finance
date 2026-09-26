"""Settl updater: pulls the latest code from GitHub and rebuilds the stack on request.

Runs as a small sidecar container with the Docker socket and the repository
directory mounted (at the same path as on the host, so Compose's relative bind
mounts keep resolving). It exposes two endpoints on the Compose network only:

    GET  /status  -> {"state", "commit", "branch", "started_at", "finished_at", "log", "error"}
    POST /update  -> 202 when an update was started, 409 while one is running

Every request must carry ``X-Updater-Token`` matching ``sha256("settl-updater:" + SECRET_KEY)``,
which the backend computes from the same ``SECRET_KEY``; nothing else can trigger a
rebuild. An update is ``git pull --ff-only`` followed by ``docker compose up -d
--build`` for the application services (the updater itself is left alone so the
command it is running is not killed halfway).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import subprocess
import threading
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO_DIR = os.environ.get("REPO_DIR", "/repo")
BRANCH = os.environ.get("UPDATE_BRANCH", "main")
SERVICES = os.environ.get("COMPOSE_SERVICES", "backend frontend").split()
PORT = int(os.environ.get("PORT", "9000"))
SECRET_KEY = os.environ.get("SECRET_KEY", "")
TOKEN = hashlib.sha256(f"settl-updater:{SECRET_KEY}".encode()).hexdigest()
LOG_TAIL = 6000

_lock = threading.Lock()
_state: dict[str, object] = {"state": "idle", "started_at": None, "finished_at": None, "log": "", "error": None}


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _run(cmd: list[str], log: list[str]) -> None:
    log.append(f"$ {' '.join(cmd)}\n")
    proc = subprocess.Popen(cmd, cwd=REPO_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert proc.stdout is not None
    for line in proc.stdout:
        log.append(line)
        with _lock:
            _state["log"] = "".join(log)[-LOG_TAIL:]
    if proc.wait() != 0:
        raise RuntimeError(f"{cmd[0]} exited with status {proc.returncode}")


def current_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", REPO_DIR, "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10, check=True
        )
        return out.stdout.strip() or None
    except Exception:  # noqa: BLE001 - a missing checkout simply reads as unknown
        return None


def _update() -> None:
    log: list[str] = []
    try:
        _run(["git", "-C", REPO_DIR, "fetch", "--prune", "origin", BRANCH], log)
        _run(["git", "-C", REPO_DIR, "pull", "--ff-only", "origin", BRANCH], log)
        compose = ["docker", "compose", "--project-directory", REPO_DIR]
        _run([*compose, "up", "-d", "--build", "--remove-orphans", *SERVICES], log)
        with _lock:
            _state.update(state="succeeded", finished_at=_now(), error=None, log="".join(log)[-LOG_TAIL:])
    except Exception as exc:  # noqa: BLE001 - reported to the UI, never crashes the server
        with _lock:
            _state.update(state="failed", finished_at=_now(), error=str(exc), log="".join(log)[-LOG_TAIL:])


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorised(self) -> bool:
        return bool(SECRET_KEY) and hmac.compare_digest(self.headers.get("X-Updater-Token", ""), TOKEN)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/status":
            self._json(404, {"detail": "not found"})
            return
        if not self._authorised():
            self._json(401, {"detail": "bad token"})
            return
        with _lock:
            body = dict(_state)
        body.update(commit=current_commit(), branch=BRANCH)
        self._json(200, body)

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/update":
            self._json(404, {"detail": "not found"})
            return
        if not self._authorised():
            self._json(401, {"detail": "bad token"})
            return
        with _lock:
            if _state["state"] == "running":
                self._json(409, {"detail": "an update is already running"})
                return
            _state.update(state="running", started_at=_now(), finished_at=None, log="", error=None)
            started = _state["started_at"]
        threading.Thread(target=_update, daemon=True).start()
        self._json(202, {"state": "running", "started_at": started})

    def log_message(self, *args: object) -> None:  # quieter container logs
        return


if __name__ == "__main__":
    if not SECRET_KEY:
        raise SystemExit("SECRET_KEY is not set; refusing to start the updater without a shared secret")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
