"""FastAPI dependency providers.

Everything that routers need (settings, user config, DB session, LLM and embedding
clients) is resolved through these functions so tests can override them with
``app.dependency_overrides``.
"""

from __future__ import annotations

from functools import lru_cache

from fastapi import Depends
from sqlalchemy.orm import Session

from app.config import AppConfig, Settings, load_config
from app.database import get_db


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


@lru_cache(maxsize=1)
def get_config() -> AppConfig:
    """``config.yaml`` as loaded at startup (built-in defaults when there is no file).

    Only the defaults: what the app manages (accounts, household, categories, rules,
    AI) is overlaid per request by :func:`get_effective_config`.
    """
    return load_config(get_settings().config_path)


def get_ai_settings(
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    base: AppConfig = Depends(get_config),
):
    """The AI setup (Settings -> AI), falling back to ``config.yaml`` / ``.env``."""
    from app.services import ai_settings

    return ai_settings.load(db, settings, base)[0]


def get_effective_config(
    db: Session = Depends(get_db),
    base: AppConfig = Depends(get_config),
    ai=Depends(get_ai_settings),
) -> AppConfig:
    """The file configuration with what the app manages overlaid.

    ``accounts`` come from the database rows (Settings -> Accounts); the household
    (names, incomes, split, currency), the category taxonomy and the deterministic
    rules from their ``app_settings`` documents (Settings -> Household / Categories /
    Rules); the ``llm`` / ``auditor`` choices from the AI settings (Settings -> AI).
    Routers therefore always see the current values. The accounts go on first so the
    rules are checked against the real account list.
    """
    from app.services import ai_settings, site_settings
    from app.services.accounts import load_account_configs

    config = site_settings.apply_all(db, base.with_accounts(load_account_configs(db)))
    return ai_settings.apply(config, ai)


def reset_caches() -> None:
    get_settings.cache_clear()
    get_config.cache_clear()
    from app.services.providers import reset_caches as reset_provider_caches

    reset_provider_caches()
