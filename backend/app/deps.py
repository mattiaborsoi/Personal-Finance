"""FastAPI dependency providers.

Everything that routers need (settings, user config, DB session, LLM and embedding
clients) is resolved through these functions so tests can override them with
``app.dependency_overrides``.
"""

from __future__ import annotations

from functools import lru_cache

from app.config import AppConfig, Settings, load_config


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


@lru_cache(maxsize=1)
def get_config() -> AppConfig:
    return load_config(get_settings().config_path)


def reset_caches() -> None:
    get_settings.cache_clear()
    get_config.cache_clear()
    from app.services.providers import get_embedder, get_llm

    get_llm.cache_clear()
    get_embedder.cache_clear()
