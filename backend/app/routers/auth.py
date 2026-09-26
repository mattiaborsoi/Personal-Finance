from __future__ import annotations

import threading
import time
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from app.auth import Role, authenticate_password, create_token, get_current_role
from app.config import AppConfig, Settings
from app.deps import get_effective_config, get_settings
from app.schemas import LoginRequest, LoginResponse, SessionInfo

router = APIRouter(prefix="/auth", tags=["auth"])

# --------------------------------------------------------------------------- #
# Login throttling: after MAX_FAILURES wrong passwords from one client address the
# address is locked out, doubling the lockout on each repeat (in-process state, which
# is plenty for a two-user LAN app).
# --------------------------------------------------------------------------- #

MAX_FAILURES = 5
FAILURE_WINDOW_SECONDS = 15 * 60
BASE_LOCKOUT_SECONDS = 60
MAX_LOCKOUT_SECONDS = 15 * 60


@dataclass
class _Attempts:
    failures: int = 0
    first_failure: float = 0.0
    locked_until: float = 0.0
    lockouts: int = 0


_attempts: dict[str, _Attempts] = {}
_lock = threading.Lock()


def reset_login_throttle() -> None:
    """Forget all failed attempts (used by the test-suite)."""
    with _lock:
        _attempts.clear()


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip() or "unknown"
    return request.client.host if request.client else "unknown"


def _seconds_locked(ip: str, now: float) -> int:
    with _lock:
        entry = _attempts.get(ip)
        if entry is None or entry.locked_until <= now:
            return 0
        return int(entry.locked_until - now) + 1


def _record_failure(ip: str, now: float) -> None:
    with _lock:
        entry = _attempts.setdefault(ip, _Attempts())
        if now - entry.first_failure > FAILURE_WINDOW_SECONDS:
            entry.failures = 0
            entry.first_failure = now
        entry.failures += 1
        if entry.failures >= MAX_FAILURES:
            lockout = min(BASE_LOCKOUT_SECONDS * (2**entry.lockouts), MAX_LOCKOUT_SECONDS)
            entry.locked_until = now + lockout
            entry.lockouts += 1
            entry.failures = 0
            entry.first_failure = now


def _record_success(ip: str) -> None:
    with _lock:
        _attempts.pop(ip, None)


def _session_info(role: Role, config: AppConfig) -> SessionInfo:
    user = config.users.primary if role == "primary" else config.users.secondary
    return SessionInfo(role=role, user_id=user.id, display_name=user.display_name)


@router.post("/login", response_model=LoginResponse)
def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    settings: Settings = Depends(get_settings),
    config: AppConfig = Depends(get_effective_config),
) -> LoginResponse:
    ip = _client_ip(request)
    now = time.monotonic()
    locked = _seconds_locked(ip, now)
    if locked:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"too many failed logins; try again in {locked} seconds",
            headers={"Retry-After": str(locked)},
        )
    role = authenticate_password(settings, body.password)
    if role is None:
        _record_failure(ip, now)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid password")
    _record_success(ip)
    response.headers["Cache-Control"] = "no-store"
    info = _session_info(role, config)
    return LoginResponse(token=create_token(settings, role), **info.model_dump())


@router.get("/me", response_model=SessionInfo)
def me(role: Role = Depends(get_current_role), config: AppConfig = Depends(get_effective_config)) -> SessionInfo:
    return _session_info(role, config)
