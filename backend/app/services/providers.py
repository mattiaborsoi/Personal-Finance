"""Factories wiring settings to concrete LLM / embedding clients (FastAPI dependencies)."""

from __future__ import annotations

from functools import lru_cache

from fastapi import Depends

from app.config import AppConfig, Settings
from app.deps import get_config, get_settings
from app.services.embeddings import EmbeddingClient, HashingEmbeddingClient, LiteLLMEmbeddingClient
from app.services.llm import LiteLLMClient, LLMClient, NullLLMClient


def build_llm(settings: Settings, config: AppConfig) -> LLMClient:
    if settings.llm_provider == "none":
        return NullLLMClient()
    return LiteLLMClient(
        base_url=settings.litellm_url,
        api_key=settings.litellm_api_key,
        model=config.llm.chat_model,
        timeout=settings.llm_timeout_seconds,
    )


def build_embedder(settings: Settings, config: AppConfig) -> EmbeddingClient:
    if settings.embedding_provider == "hash":
        return HashingEmbeddingClient(dimensions=settings.embedding_dimensions)
    return LiteLLMEmbeddingClient(
        base_url=settings.litellm_url,
        api_key=settings.litellm_api_key,
        model=config.llm.embedding_model,
        dimensions=settings.embedding_dimensions,
        timeout=settings.llm_timeout_seconds,
    )


@lru_cache(maxsize=1)
def _cached_llm() -> LLMClient:
    return build_llm(get_settings(), get_config())


@lru_cache(maxsize=1)
def _cached_embedder() -> EmbeddingClient:
    return build_embedder(get_settings(), get_config())


def get_llm(
    settings: Settings = Depends(get_settings), config: AppConfig = Depends(get_config)
) -> LLMClient:
    return _cached_llm()


def get_embedder(
    settings: Settings = Depends(get_settings), config: AppConfig = Depends(get_config)
) -> EmbeddingClient:
    return _cached_embedder()


get_llm.cache_clear = _cached_llm.cache_clear  # type: ignore[attr-defined]
get_embedder.cache_clear = _cached_embedder.cache_clear  # type: ignore[attr-defined]
