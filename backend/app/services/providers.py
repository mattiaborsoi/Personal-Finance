"""Factories wiring settings to concrete LLM / embedding clients (FastAPI dependencies).

Which model does what, and whether AI is used at all, is decided by the AI settings
(Settings -> AI in the app, falling back to ``config.yaml`` / ``.env``), so the
clients are built per request from the effective configuration and cached by their
parameters. A change saved in the app therefore applies to the next request without
a restart.
"""

from __future__ import annotations

from fastapi import Depends

from app.config import AppConfig, Settings
from app.deps import get_ai_settings, get_effective_config, get_settings
from app.services.ai_settings import AiSettings
from app.services.embeddings import EmbeddingClient, HashingEmbeddingClient, LiteLLMEmbeddingClient
from app.services.llm import LiteLLMClient, LLMClient, NullLLMClient

_llm_clients: dict[tuple, LLMClient] = {}
_embedders: dict[tuple, EmbeddingClient] = {}
_null_llm = NullLLMClient()

# Each job waits only as long as its answer is worth waiting for. Classification is
# one call per unseen merchant, so a hung proxy must give up quickly (the Guesser's
# circuit breaker then skips the rest of the file); PDF extraction and the audit are
# single, longer calls. ``LLM_TIMEOUT_SECONDS`` (default 90) is the ceiling for all
# three and the extraction timeout itself.
CLASSIFY_TIMEOUT_SECONDS = 20.0
AUDIT_TIMEOUT_SECONDS = 60.0


def reset_caches() -> None:
    _llm_clients.clear()
    _embedders.clear()


def build_llm(settings: Settings, ai: AiSettings, model: str, timeout: float | None = None) -> LLMClient:
    """A cached proxy client for ``model``; ``timeout`` (seconds) is capped by ``LLM_TIMEOUT_SECONDS``."""
    if not ai.enabled:
        return _null_llm
    url, api_key = ai.proxy_url(settings), ai.proxy_key(settings)
    ceiling = settings.llm_timeout_seconds
    timeout = ceiling if timeout is None else min(timeout, ceiling)
    key = (url, api_key, model, timeout)
    client = _llm_clients.get(key)
    if client is None:
        client = LiteLLMClient(base_url=url, api_key=api_key, model=model, timeout=timeout)
        _llm_clients[key] = client
    return client


def build_embedder(settings: Settings, ai: AiSettings, model: str) -> EmbeddingClient:
    url, api_key = ai.proxy_url(settings), ai.proxy_key(settings)
    key = (ai.embedding_provider, url, api_key, model, settings.embedding_dimensions)
    client = _embedders.get(key)
    if client is None:
        if ai.embedding_provider == "hash":
            client = HashingEmbeddingClient(dimensions=settings.embedding_dimensions)
        else:
            client = LiteLLMEmbeddingClient(
                base_url=url,
                api_key=api_key,
                model=model,
                dimensions=settings.embedding_dimensions,
                timeout=settings.llm_timeout_seconds,
            )
        _embedders[key] = client
    return client


def get_llm(
    settings: Settings = Depends(get_settings),
    config: AppConfig = Depends(get_effective_config),
    ai: AiSettings = Depends(get_ai_settings),
) -> LLMClient:
    """The model that categorises transactions."""
    return build_llm(settings, ai, config.llm.chat_model, timeout=CLASSIFY_TIMEOUT_SECONDS)


def get_extraction_llm(
    settings: Settings = Depends(get_settings),
    config: AppConfig = Depends(get_effective_config),
    ai: AiSettings = Depends(get_ai_settings),
) -> LLMClient:
    """The model that reads PDFs the deterministic parsers cannot (full ``LLM_TIMEOUT_SECONDS``)."""
    return build_llm(settings, ai, config.llm.extraction_model_name)


def get_audit_llm(
    settings: Settings = Depends(get_settings),
    config: AppConfig = Depends(get_effective_config),
    ai: AiSettings = Depends(get_ai_settings),
) -> LLMClient:
    """The model that writes the monthly summary."""
    return build_llm(settings, ai, config.llm.audit_model_name, timeout=AUDIT_TIMEOUT_SECONDS)


def get_embedder(
    settings: Settings = Depends(get_settings),
    config: AppConfig = Depends(get_effective_config),
    ai: AiSettings = Depends(get_ai_settings),
) -> EmbeddingClient:
    return build_embedder(settings, ai, config.llm.embedding_model)
