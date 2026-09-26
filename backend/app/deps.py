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
    """The configuration file as loaded at startup (users, rules, categories...)."""
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

    ``accounts`` come from the database rows (edited under Settings -> Accounts) and
    the ``llm`` / ``auditor`` choices from the AI settings (Settings -> AI), so routers
    always see the current values. Users, split strategy, rules and categories still
    come from the file.
    """
    from app.services import ai_settings
    from app.services.accounts import load_account_configs

    return ai_settings.apply(base.with_accounts(load_account_configs(db)), ai)


def reset_caches() -> None:
    get_settings.cache_clear()
    get_config.cache_clear()
    from app.services.providers import reset_caches as reset_provider_caches

    reset_provider_caches()
