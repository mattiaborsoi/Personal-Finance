"""AI setup edited in the app (Settings -> AI).

What the user controls here, in plain terms:

* whether AI is used at all (off = rules and the merchant memory only);
* which proxy model does each job: categorising transactions, reading awkward
  PDFs, writing the monthly summary, and turning merchants into vectors;
* the thresholds behind those jobs (memory confidence, examples per question,
  the auditor's "moved more than X %" rule and its look-back).

Defaults come from ``config.yaml`` (``llm``/``auditor``) and ``.env``
(``LLM_PROVIDER``, ``EMBEDDING_PROVIDER``); a saved document in ``app_settings``
overrides them. The list of models on offer is whatever the LiteLLM proxy exposes
(``litellm/config.yaml``); provider API keys never pass through here.

Changing the embedding model or provider makes the stored merchant vectors
incomparable, so the change is refused while memory rows exist unless the caller
asks for the memory to be cleared.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.config import AppConfig, Settings
from app.models import AppSetting, MerchantMemory
from app.services.embeddings import LiteLLMEmbeddingClient
from app.services.llm import LiteLLMClient, LLMError

log = logging.getLogger(__name__)

SETTINGS_KEY = "ai"
MODEL_LIST_CACHE_SECONDS = 60
TEST_TIMEOUT_SECONDS = 30.0

EmbeddingProvider = Literal["litellm", "hash"]


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #


class AiModels(BaseModel):
    chat: str = Field(min_length=1, max_length=128)
    extraction: str = Field(min_length=1, max_length=128)
    audit: str = Field(min_length=1, max_length=128)
    embedding: str = Field(min_length=1, max_length=128)


class AiThresholds(BaseModel):
    similarity_threshold: float = Field(ge=0.0, le=1.0)
    top_k: int = Field(ge=1, le=20)
    deviation_threshold: float = Field(ge=0.0, le=5.0)
    lookback_periods: int = Field(ge=1, le=24)


class AiProxy(BaseModel):
    """Which LiteLLM proxy to talk to: one of two, nothing in between.

    ``bundled`` is the container that ships with the app (``docker-compose.yml``,
    profile ``bundled-litellm``): ``BUNDLED_LITELLM_URL`` with ``LITELLM_MASTER_KEY``.
    ``external`` is a LiteLLM you already run, at ``url`` with ``api_key`` (stored
    here, never returned to the browser); when nothing is saved they default to
    ``LITELLM_URL`` / ``LITELLM_API_KEY`` from ``.env``, and setting those makes
    ``external`` the default mode.
    """

    mode: Literal["bundled", "external"] = "bundled"
    url: str | None = None
    api_key: str | None = None


MAX_REDACT_WORDS = 50
MAX_REDACT_WORD_LENGTH = 64


class AiSettings(BaseModel):
    enabled: bool
    embedding_provider: EmbeddingProvider
    models: AiModels
    thresholds: AiThresholds
    proxy: AiProxy = Field(default_factory=AiProxy)
    redact_words: list[str] = Field(default_factory=list)
    """Extra words masked before any text goes to a model, besides the names, numbers,
    postcodes, e-mails and phone numbers that are always masked (``app.services.redaction``)."""

    def proxy_url(self, settings: Settings) -> str:
        if self.proxy.mode == "external":
            return (self.proxy.url or settings.litellm_url).rstrip("/")
        return settings.bundled_litellm_url.rstrip("/")

    def proxy_key(self, settings: Settings) -> str:
        if self.proxy.mode == "external":
            return self.proxy.api_key or settings.litellm_api_key
        return settings.litellm_master_key

    def public_dict(self, settings: Settings) -> dict[str, Any]:
        """Everything but the stored key."""
        data = self.model_dump()
        data["proxy"] = {
            "mode": self.proxy.mode,
            "url": self.proxy_url(settings),
            "bundled_url": settings.bundled_litellm_url.rstrip("/"),
            # What .env offers for the external option (LITELLM_URL), if anything.
            "env_url": settings.litellm_url.rstrip("/") or None,
            "has_key": bool(self.proxy_key(settings)),
        }
        return data


class AiModelsUpdate(BaseModel):
    chat: str | None = Field(default=None, min_length=1, max_length=128)
    extraction: str | None = Field(default=None, min_length=1, max_length=128)
    audit: str | None = Field(default=None, min_length=1, max_length=128)
    embedding: str | None = Field(default=None, min_length=1, max_length=128)


class AiThresholdsUpdate(BaseModel):
    """The ranges the UI offers; wider values from ``config.yaml`` still load fine."""

    similarity_threshold: float | None = Field(default=None, ge=0.5, le=0.99)
    top_k: int | None = Field(default=None, ge=1, le=10)
    deviation_threshold: float | None = Field(default=None, ge=0.05, le=1.0)
    lookback_periods: int | None = Field(default=None, ge=1, le=12)


class AiProxyUpdate(BaseModel):
    mode: Literal["bundled", "external"] | None = None
    url: str | None = Field(default=None, max_length=256)
    api_key: str | None = Field(default=None, max_length=512)
    """Empty or omitted keeps the stored key."""


class AiUpdate(BaseModel):
    enabled: bool | None = None
    embedding_provider: EmbeddingProvider | None = None
    models: AiModelsUpdate | None = None
    thresholds: AiThresholdsUpdate | None = None
    proxy: AiProxyUpdate | None = None
    redact_words: list[str] | None = Field(default=None, max_length=MAX_REDACT_WORDS)
    """The whole list; it replaces the saved one. Blank entries are dropped, the rest trimmed."""
    clear_memory: bool = False


class AiModelOption(BaseModel):
    name: str
    mode: Literal["chat", "embedding"] | None = None
    provider: str | None = None
    model: str | None = None


class AiSettingsError(ValueError):
    """Invalid values (HTTP 422)."""


class AiSettingsConflict(ValueError):
    """The change would orphan the merchant memory (HTTP 409)."""


# --------------------------------------------------------------------------- #
# Defaults, load, save, apply
# --------------------------------------------------------------------------- #


def defaults(settings: Settings, config: AppConfig) -> AiSettings:
    llm = config.llm
    return AiSettings(
        enabled=settings.llm_provider != "none",
        embedding_provider=settings.embedding_provider,
        models=AiModels(
            chat=llm.chat_model,
            extraction=llm.extraction_model_name,
            audit=llm.audit_model_name,
            embedding=llm.embedding_model,
        ),
        thresholds=AiThresholds(
            similarity_threshold=llm.similarity_threshold,
            top_k=llm.top_k,
            deviation_threshold=config.auditor.deviation_threshold,
            lookback_periods=config.auditor.lookback_periods,
        ),
        # LITELLM_URL in .env means "I already run one": start from it; a saved choice
        # overrides this, and a saved external proxy without a URL keeps this one.
        proxy=AiProxy(mode="external", url=settings.litellm_url.rstrip("/")) if settings.litellm_url else AiProxy(),
        redact_words=list(config.privacy.redact_words),
    )


def _merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        elif value is not None:
            out[key] = value
    return out


def load(db: Session, settings: Settings, config: AppConfig) -> tuple[AiSettings, bool]:
    """``(settings, stored)``: the effective AI settings and whether a document exists."""
    base = defaults(settings, config)
    row = db.get(AppSetting, SETTINGS_KEY)
    if row is None or not row.value:
        return base, False
    try:
        return AiSettings.model_validate(_merge(base.model_dump(), row.value)), True
    except Exception as exc:  # noqa: BLE001 - a corrupt document must not take the app down
        log.warning("ignoring invalid ai settings document: %s", exc)
        return base, False


def save(db: Session, ai: AiSettings) -> None:
    row = db.get(AppSetting, SETTINGS_KEY)
    if row is None:
        row = AppSetting(key=SETTINGS_KEY, value=ai.model_dump())
        db.add(row)
    else:
        row.value = ai.model_dump()
    db.flush()


def apply(config: AppConfig, ai: AiSettings) -> AppConfig:
    """The file configuration with the AI choices overlaid (models and thresholds)."""
    llm = config.llm.model_copy(
        update={
            "chat_model": ai.models.chat,
            "extraction_model": ai.models.extraction,
            "audit_model": ai.models.audit,
            "embedding_model": ai.models.embedding,
            "similarity_threshold": ai.thresholds.similarity_threshold,
            "top_k": ai.thresholds.top_k,
        }
    )
    auditor = config.auditor.model_copy(
        update={
            "deviation_threshold": ai.thresholds.deviation_threshold,
            "lookback_periods": ai.thresholds.lookback_periods,
        }
    )
    privacy = config.privacy.model_copy(update={"redact_words": list(ai.redact_words)})
    return config.model_copy(update={"llm": llm, "auditor": auditor, "privacy": privacy})


def merged(current: AiSettings, update: AiUpdate) -> AiSettings:
    """``current`` with the fields present in ``update`` replaced (validated)."""
    data = current.model_dump()
    patch = update.model_dump(exclude_unset=True, exclude={"clear_memory"})
    proxy_patch = patch.get("proxy") or {}
    if "api_key" in proxy_patch and not (proxy_patch["api_key"] or "").strip():
        proxy_patch.pop("api_key")  # blank means "keep what is stored"
    if "url" in proxy_patch and proxy_patch["url"] is not None:
        url = proxy_patch["url"].strip().rstrip("/")
        if url and not url.lower().startswith(("http://", "https://")):
            raise AiSettingsError("the proxy URL must start with http:// or https://")
        proxy_patch["url"] = url or None
    if patch.get("redact_words") is not None:
        words = [w.strip() for w in patch["redact_words"] if isinstance(w, str) and w.strip()]
        for word in words:
            if len(word) > MAX_REDACT_WORD_LENGTH:
                raise AiSettingsError(f"a word to redact must be at most {MAX_REDACT_WORD_LENGTH} characters")
        seen: set[str] = set()
        patch["redact_words"] = [w for w in words if not (w.lower() in seen or seen.add(w.lower()))]
    result = AiSettings.model_validate(_merge(data, patch))
    if result.proxy.mode == "external" and not result.proxy.url:
        raise AiSettingsError("enter the URL of your LiteLLM proxy, e.g. http://host.docker.internal:4000")
    return result


def memory_rows(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(MerchantMemory)) or 0)


def embedding_changed(current: AiSettings, proposed: AiSettings) -> bool:
    if current.embedding_provider != proposed.embedding_provider:
        return True
    return proposed.embedding_provider == "litellm" and current.models.embedding != proposed.models.embedding


def update(
    db: Session,
    settings: Settings,
    config: AppConfig,
    body: AiUpdate,
    available: list[AiModelOption],
) -> AiSettings:
    """Validate and persist an update; clears the merchant memory when asked to."""
    current, _ = load(db, settings, config)
    proposed = merged(current, body)
    validate_models(proposed, available)
    if embedding_changed(current, proposed) and memory_rows(db):
        if not body.clear_memory:
            raise AiSettingsConflict(
                "changing how merchants are remembered makes the existing merchant memory unusable; "
                "confirm clearing it to switch"
            )
        db.execute(delete(MerchantMemory))
    save(db, proposed)
    return proposed


def validate_models(ai: AiSettings, available: list[AiModelOption]) -> None:
    """Every chosen model must be one the proxy lists (when it lists anything)."""
    if not available:
        return
    by_name = {m.name: m for m in available}
    jobs = [
        ("chat", ai.models.chat, "chat"),
        ("extraction", ai.models.extraction, "chat"),
        ("audit", ai.models.audit, "chat"),
    ]
    if ai.embedding_provider == "litellm":
        jobs.append(("embedding", ai.models.embedding, "embedding"))
    for job, name, wanted_mode in jobs:
        option = by_name.get(name)
        if option is None:
            raise AiSettingsError(f"{job}: the proxy does not list a model called {name!r}")
        if option.mode is not None and option.mode != wanted_mode:
            raise AiSettingsError(f"{job}: {name!r} is an {option.mode} model, not a {wanted_mode} model")


# --------------------------------------------------------------------------- #
# The proxy's model list
# --------------------------------------------------------------------------- #

PROVIDER_NAMES = {
    "anthropic": "Anthropic",
    "openai": "OpenAI",
    "azure": "Azure OpenAI",
    "gemini": "Google Gemini",
    "vertex_ai": "Google Vertex AI",
    "bedrock": "AWS Bedrock",
    "mistral": "Mistral",
    "groq": "Groq",
    "ollama": "Ollama",
    "openrouter": "OpenRouter",
    "cohere": "Cohere",
    "xai": "xAI",
    "deepseek": "DeepSeek",
    "together_ai": "Together AI",
    "fireworks_ai": "Fireworks AI",
}


def _option(name: str, litellm_model: str | None, mode: str | None) -> AiModelOption:
    provider = model = None
    if litellm_model:
        if "/" in litellm_model:
            head, model = litellm_model.split("/", 1)
            provider = PROVIDER_NAMES.get(head, head.replace("_", " ").title())
        else:
            model = litellm_model
    if mode not in ("chat", "embedding"):
        haystack = f"{name} {litellm_model or ''}".lower()
        mode = "embedding" if "embed" in haystack else None
    return AiModelOption(name=name, mode=mode, provider=provider, model=model)


class ModelCatalogue:
    """Models a LiteLLM proxy offers, cached for a minute per proxy (URL + key)."""

    def __init__(self, transport: httpx.BaseTransport | None = None) -> None:
        self._transport = transport
        self._cached: dict[tuple[str, str], tuple[float, list[AiModelOption], bool]] = {}

    def list(self, url: str, api_key: str, *, force: bool = False) -> tuple[list[AiModelOption], bool]:
        """``(models, reachable)``; an empty list with ``reachable=False`` when the proxy is down."""
        now = time.monotonic()
        key = (url.rstrip("/"), api_key)
        cached = self._cached.get(key)
        if not force and cached and now - cached[0] < MODEL_LIST_CACHE_SECONDS:
            return cached[1], cached[2]
        models, reachable = self._fetch(url, api_key)
        self._cached[key] = (now, models, reachable)
        return models, reachable

    def _fetch(self, url: str, api_key: str) -> tuple[list[AiModelOption], bool]:
        base = url.rstrip("/")
        headers = {"Authorization": f"Bearer {api_key}"}
        try:
            with httpx.Client(timeout=httpx.Timeout(8.0), transport=self._transport) as client:
                resp = client.get(f"{base}/model/info", headers=headers)
                if resp.status_code == 200:
                    options = []
                    for item in resp.json().get("data") or []:
                        name = item.get("model_name")
                        if not name:
                            continue
                        params = item.get("litellm_params") or {}
                        info = item.get("model_info") or {}
                        options.append(_option(str(name), params.get("model"), info.get("mode")))
                    if options:
                        return _dedupe(options), True
                resp = client.get(f"{base}/v1/models", headers=headers)
                resp.raise_for_status()
                options = [_option(str(m.get("id")), None, None) for m in resp.json().get("data") or [] if m.get("id")]
                return _dedupe(options), True
        except Exception as exc:  # noqa: BLE001 - the proxy may be down or not deployed
            log.info("model list unavailable from the proxy: %s", exc)
            return [], False


def _dedupe(options: list[AiModelOption]) -> list[AiModelOption]:
    seen: set[str] = set()
    out: list[AiModelOption] = []
    for option in options:
        if option.name in seen:
            continue
        seen.add(option.name)
        out.append(option)
    return out


# --------------------------------------------------------------------------- #
# Test connection
# --------------------------------------------------------------------------- #


def _timed(fn):
    started = time.perf_counter()
    result = fn()
    return result, int((time.perf_counter() - started) * 1000)


def _ping(client: LiteLLMClient) -> dict[str, Any]:
    return client.complete_json(
        system='Reply with exactly this JSON object and nothing else: {"ok": true}', user="ping", max_tokens=20
    )


def run_tests(
    settings: Settings, ai: AiSettings, *, transport: httpx.BaseTransport | None = None
) -> dict[str, Any]:
    """Call each configured model once with a trivial request; never raises.

    ``transport`` lets tests answer the calls in-process instead of over the network.
    """
    results: dict[str, Any] = {"chat": None, "extraction": None, "audit": None, "embedding": None}

    def http() -> httpx.Client | None:
        return httpx.Client(timeout=httpx.Timeout(TEST_TIMEOUT_SECONDS), transport=transport) if transport else None

    if ai.enabled:
        for job in ("chat", "extraction", "audit"):
            model = getattr(ai.models, job)
            client = LiteLLMClient(
                base_url=ai.proxy_url(settings),
                api_key=ai.proxy_key(settings),
                model=model,
                timeout=TEST_TIMEOUT_SECONDS,
                client=http(),
            )
            try:
                answer, ms = _timed(lambda c=client: _ping(c))
                ok = isinstance(answer, dict)
                results[job] = {"ok": ok, "ms": ms, "model": model, "error": None if ok else "unexpected reply"}
            except (LLMError, Exception) as exc:  # noqa: BLE001
                results[job] = {"ok": False, "ms": None, "model": model, "error": _describe(exc)}
    if ai.embedding_provider == "hash":
        results["embedding"] = {
            "ok": True,
            "ms": 0,
            "model": "offline",
            "dimensions": settings.embedding_dimensions,
            "error": None,
        }
    else:
        model = ai.models.embedding
        embedder = LiteLLMEmbeddingClient(
            base_url=ai.proxy_url(settings),
            api_key=ai.proxy_key(settings),
            model=model,
            dimensions=settings.embedding_dimensions,
            timeout=TEST_TIMEOUT_SECONDS,
            client=http(),
        )
        try:
            vectors, ms = _timed(lambda: embedder.embed(["waitrose 1234 london"]))
            dims = len(vectors[0]) if vectors else 0
            ok = dims == settings.embedding_dimensions
            results["embedding"] = {
                "ok": ok,
                "ms": ms,
                "model": model,
                "dimensions": dims,
                "error": None if ok else f"returned {dims} dimensions, expected {settings.embedding_dimensions}",
            }
        except Exception as exc:  # noqa: BLE001
            results["embedding"] = {
                "ok": False, "ms": None, "model": model, "dimensions": None, "error": _describe(exc)
            }
    return results


def _describe(exc: Exception) -> str:
    text = str(exc).strip() or exc.__class__.__name__
    return text[:300]
