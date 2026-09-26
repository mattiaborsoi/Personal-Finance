"""Local token/session authentication.

Two roles exist. ``primary`` has full access; ``secondary`` may only submit and view
partner claims (the mobile ``/claim`` form) and read the settlement summary.
Passwords come from the environment; sessions are signed, time-limited tokens so the
server keeps no session table. Each token also carries a short tag of the password it
was issued for, so rotating a password logs that role out everywhere.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import Literal

from fastapi import Depends, Header, HTTPException, status
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app.config import ConfigError, Settings
from app.deps import get_settings

Role = Literal["primary", "secondary"]
ROLES: tuple[Role, ...] = ("primary", "secondary")

_SALT = "financemaster-session"

# Placeholder values shipped in .env.example / Settings defaults; never accepted at startup.
INSECURE_SECRETS = frozenset({"change-me-to-a-long-random-string", "change-me", "changeme", "secret"})
INSECURE_PASSWORDS = frozenset(
    {"change-me-primary", "change-me-secondary", "password", "primary", "secondary", "changeme", "change-me"}
)
MIN_SECRET_LENGTH = 32
MIN_PASSWORD_LENGTH = 8


def validate_security_settings(settings: Settings) -> None:
    """Refuse to run with placeholder or weak secrets (called at application startup)."""
    problems: list[str] = []
    if settings.secret_key in INSECURE_SECRETS or len(settings.secret_key) < MIN_SECRET_LENGTH:
        problems.append(
            f"SECRET_KEY must be a random string of at least {MIN_SECRET_LENGTH} characters (openssl rand -hex 32)"
        )
    for name, password in (
        ("PRIMARY_PASSWORD", settings.primary_password),
        ("SECONDARY_PASSWORD", settings.secondary_password),
    ):
        if password in INSECURE_PASSWORDS or len(password) < MIN_PASSWORD_LENGTH:
            problems.append(f"{name} must be at least {MIN_PASSWORD_LENGTH} characters and not a placeholder")
    if settings.primary_password == settings.secondary_password:
        problems.append("PRIMARY_PASSWORD and SECONDARY_PASSWORD must differ")
    if problems:
        raise ConfigError("insecure runtime settings: " + "; ".join(problems))


def password_tag(password: str) -> str:
    """Short, non-reversible tag identifying the password a token was issued for."""
    return hashlib.sha256(password.encode("utf-8")).hexdigest()[:12]


def _password_for(settings: Settings, role: Role) -> str:
    return settings.primary_password if role == "primary" else settings.secondary_password


def _serializer(secret_key: str) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(secret_key, salt=_SALT)


def authenticate_password(settings: Settings, password: str) -> Role | None:
    """Return the role whose password matches, using constant-time comparison."""
    if password and hmac.compare_digest(password.encode(), settings.primary_password.encode()):
        return "primary"
    if password and hmac.compare_digest(password.encode(), settings.secondary_password.encode()):
        return "secondary"
    return None


def create_token(settings: Settings, role: Role) -> str:
    payload = {"role": role, "pw": password_tag(_password_for(settings, role)), "nonce": secrets.token_hex(8)}
    return _serializer(settings.secret_key).dumps(payload)


def verify_token(settings: Settings, token: str) -> Role:
    try:
        data = _serializer(settings.secret_key).loads(token, max_age=settings.session_ttl_seconds)
    except SignatureExpired as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session expired") from exc
    except BadSignature as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid session token") from exc
    role = data.get("role") if isinstance(data, dict) else None
    if role not in ROLES:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid session token")
    expected_tag = password_tag(_password_for(settings, role))
    if not hmac.compare_digest(str(data.get("pw", "")), expected_tag):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session no longer valid; please log in again")
    return role  # type: ignore[return-value]


def get_current_role(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> Role:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    return verify_token(settings, authorization.split(" ", 1)[1].strip())


def require_primary(role: Role = Depends(get_current_role)) -> Role:
    if role != "primary":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "primary role required")
    return role


def require_any_role(role: Role = Depends(get_current_role)) -> Role:
    return role
