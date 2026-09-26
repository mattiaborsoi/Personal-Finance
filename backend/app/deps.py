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


def get_effective_config(db: Session = Depends(get_db), base: AppConfig = Depends(get_config)) -> AppConfig:
    """The file configuration with ``accounts`` replaced by the database rows.

    Accounts are edited in the app, so routers must see the current rows rather than
    whatever ``config.yaml`` said on first start. Everything else (users, split
    strategy, rules, categories) still comes from the file.
    """
    from app.services.accounts import load_account_configs

    return base.with_accounts(load_account_configs(db))


def reset_caches() -> None:
    get_settings.cache_clear()
    get_config.cache_clear()
    from app.services.providers import get_embedder, get_llm

    get_llm.cache_clear()
    get_embedder.cache_clear()
