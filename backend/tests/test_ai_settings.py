"""Settings -> AI: stored choices overlay config.yaml / .env, the proxy's model list, tests, guards."""

from __future__ import annotations

import json

import httpx
import pytest

from app.config import Settings
from app.models import AppSetting, MerchantMemory
from app.services import ai_settings, providers
from app.services.ai_settings import AiUpdate, ModelCatalogue
from app.services.embeddings import HashingEmbeddingClient, LiteLLMEmbeddingClient
from app.services.llm import LiteLLMClient, NullLLMClient
from tests.conftest import requires_db


def _settings(**overrides) -> Settings:
    base = dict(
        secret_key="unit-test-only",
        primary_password="primary-pass",
        secondary_password="secondary-pass",
        litellm_url="http://litellm.test:4000",
        litellm_master_key="bundled-master",
        llm_provider="litellm",
        embedding_provider="litellm",
        _env_file=None,
    )
    base.update(overrides)
    return Settings(**base)


def _model(name: str, litellm_model: str, mode: str | None) -> dict:
    info = {"mode": mode} if mode else {}
    return {"model_name": name, "litellm_params": {"model": litellm_model}, "model_info": info}


MODEL_INFO = {
    "data": [
        _model("default-chat", "anthropic/claude-opus-5", "chat"),
        _model("cheap-chat", "anthropic/claude-haiku-4-5", None),
        _model("default-embedding", "openai/text-embedding-3-small", "embedding"),
        _model("local-llama", "ollama/llama3", "chat"),
    ]
}


def _proxy_transport(*, info: bool = True, dims: int = 1536, fail_chat: set[str] | None = None) -> httpx.MockTransport:
    """A fake LiteLLM: model listing, chat completions and embeddings."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(f"{request.method} {request.url.path} {request.headers.get('Authorization')}")
        if request.url.path == "/model/info":
            return httpx.Response(200, json=MODEL_INFO) if info else httpx.Response(404, json={})
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": m["model_name"]} for m in MODEL_INFO["data"]]})
        if request.url.path == "/v1/chat/completions":
            payload = json.loads(request.read().decode())
            if fail_chat and payload["model"] in fail_chat:
                return httpx.Response(500, json={"error": "boom"})
            return httpx.Response(
                200, json={"choices": [{"message": {"content": '{"ok": true}'}}], "usage": {"prompt_tokens": 1}}
            )
        if request.url.path == "/v1/embeddings":
            return httpx.Response(200, json={"data": [{"embedding": [0.1] * dims, "index": 0}]})
        return httpx.Response(404, json={"detail": "not found"})

    transport = httpx.MockTransport(handler)
    transport.seen = seen  # type: ignore[attr-defined]
    return transport


# --------------------------------------------------------------------------- #
# Pure logic
# --------------------------------------------------------------------------- #


def test_defaults_come_from_env_and_config(config):
    ai = ai_settings.defaults(_settings(), config)
    assert ai.enabled is True and ai.embedding_provider == "litellm"
    assert ai.models.chat == "default-chat" and ai.models.extraction == "default-chat"
    assert ai.models.audit == "default-chat" and ai.models.embedding == "default-embedding"
    assert ai.thresholds.similarity_threshold == 0.82 and ai.thresholds.top_k == 3
    assert ai.thresholds.deviation_threshold == 0.15 and ai.thresholds.lookback_periods == 3
    off = ai_settings.defaults(_settings(llm_provider="none", embedding_provider="hash"), config)
    assert off.enabled is False and off.embedding_provider == "hash"


def test_apply_overlays_models_and_thresholds(config):
    ai = ai_settings.defaults(_settings(), config)
    ai = ai_settings.merged(
        ai,
        AiUpdate(
            models={"chat": "cheap-chat", "audit": "default-chat"},
            thresholds={"similarity_threshold": 0.9, "deviation_threshold": 0.25, "lookback_periods": 6},
        ),
    )
    effective = ai_settings.apply(config, ai)
    assert effective.llm.chat_model == "cheap-chat"
    assert effective.llm.extraction_model_name == "default-chat"  # untouched job keeps its model
    assert effective.llm.similarity_threshold == 0.9 and effective.llm.top_k == 3
    assert effective.auditor.deviation_threshold == 0.25 and effective.auditor.lookback_periods == 6
    assert config.llm.chat_model == "default-chat"  # the file configuration is never mutated


def test_proxy_resolution_and_key_handling(config):
    settings = _settings(litellm_api_key="")
    ai = ai_settings.defaults(settings, config)
    assert ai.proxy_url(settings) == "http://litellm.test:4000" and ai.proxy_key(settings) == "bundled-master"

    external = ai_settings.merged(
        ai, AiUpdate(proxy={"mode": "external", "url": "http://host.docker.internal:4000/", "api_key": "sk-mine"})
    )
    assert external.proxy_url(settings) == "http://host.docker.internal:4000"
    assert external.proxy_key(settings) == "sk-mine"
    # A blank key on a later update keeps the stored one; the browser never sees it.
    again = ai_settings.merged(external, AiUpdate(proxy={"url": "http://other:4000", "api_key": ""}))
    assert again.proxy.api_key == "sk-mine" and again.proxy.url == "http://other:4000"
    public = again.public_dict(settings)
    assert public["proxy"] == {
        "mode": "external",
        "url": "http://other:4000",
        "bundled_url": "http://litellm.test:4000",
        "has_key": True,
    }
    assert "api_key" not in str(public)

    with pytest.raises(ai_settings.AiSettingsError, match="http://"):
        ai_settings.merged(ai, AiUpdate(proxy={"mode": "external", "url": "litellm.local:4000"}))
    with pytest.raises(ai_settings.AiSettingsError, match="URL"):
        ai_settings.merged(ai, AiUpdate(proxy={"mode": "external"}))


def test_model_catalogue_parses_model_info_and_falls_back():
    transport = _proxy_transport()
    catalogue = ModelCatalogue(transport=transport)
    models, reachable = catalogue.list("http://litellm.test:4000/", "k")
    assert reachable is True
    by_name = {m.name: m for m in models}
    assert by_name["default-chat"].provider == "Anthropic" and by_name["default-chat"].model == "claude-opus-5"
    assert by_name["cheap-chat"].mode is None  # no mode given and nothing in the name: usable anywhere
    assert by_name["default-embedding"].mode == "embedding"
    assert by_name["local-llama"].provider == "Ollama"
    catalogue.list("http://litellm.test:4000", "k")
    assert len([s for s in transport.seen if "/model/info" in s]) == 1  # cached per proxy

    fallback = ModelCatalogue(transport=_proxy_transport(info=False))
    models, reachable = fallback.list("http://litellm.test:4000", "k")
    assert reachable and [m.name for m in models] == [m["model_name"] for m in MODEL_INFO["data"]]
    assert all(m.provider is None for m in models)

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    assert ModelCatalogue(transport=httpx.MockTransport(down)).list("http://x", "k") == ([], False)


def test_validate_models_against_the_catalogue(config):
    models, _ = ModelCatalogue(transport=_proxy_transport()).list("http://litellm.test:4000", "k")
    ai = ai_settings.defaults(_settings(), config)
    ai_settings.validate_models(ai, models)
    ai_settings.validate_models(ai, [])  # nothing listed: anything goes
    with pytest.raises(ai_settings.AiSettingsError, match="does not list"):
        ai_settings.validate_models(ai_settings.merged(ai, AiUpdate(models={"chat": "gpt-9"})), models)
    with pytest.raises(ai_settings.AiSettingsError, match="embedding model"):
        ai_settings.validate_models(ai_settings.merged(ai, AiUpdate(models={"audit": "default-embedding"})), models)


def test_run_tests_reports_each_job(config):
    settings = _settings()
    ai = ai_settings.merged(ai_settings.defaults(settings, config), AiUpdate(models={"audit": "cheap-chat"}))
    transport = _proxy_transport(dims=768, fail_chat={"cheap-chat"})
    results = ai_settings.run_tests(settings, ai, transport=transport)
    assert results["chat"]["ok"] is True and results["chat"]["model"] == "default-chat"
    assert results["audit"]["ok"] is False and results["audit"]["error"]
    assert results["embedding"]["ok"] is False and "768" in results["embedding"]["error"]

    off = ai_settings.merged(ai, AiUpdate(enabled=False, embedding_provider="hash"))
    results = ai_settings.run_tests(settings, off, transport=transport)
    assert results["chat"] is None and results["embedding"]["model"] == "offline"


def test_providers_follow_the_ai_settings(config):
    settings = _settings()
    providers.reset_caches()
    ai = ai_settings.defaults(settings, config)
    effective = ai_settings.apply(config, ai)
    llm = providers.get_llm(settings, effective, ai)
    assert isinstance(llm, LiteLLMClient) and llm.model == "default-chat"
    assert providers.get_llm(settings, effective, ai) is llm  # cached by proxy + model
    cheaper = ai_settings.merged(ai, AiUpdate(models={"chat": "cheap-chat"}, embedding_provider="hash"))
    assert providers.get_llm(settings, ai_settings.apply(config, cheaper), cheaper).model == "cheap-chat"
    assert isinstance(providers.get_embedder(settings, effective, cheaper), HashingEmbeddingClient)
    assert isinstance(providers.get_embedder(settings, effective, ai), LiteLLMEmbeddingClient)
    disabled = ai_settings.merged(ai, AiUpdate(enabled=False))
    assert isinstance(providers.get_llm(settings, effective, disabled), NullLLMClient)


# --------------------------------------------------------------------------- #
# Persistence and the API
# --------------------------------------------------------------------------- #


@requires_db
def test_load_and_save_round_trip(db, config):
    settings = _settings()
    ai, stored = ai_settings.load(db, settings, config)
    assert stored is False
    ai_settings.save(db, ai_settings.merged(ai, AiUpdate(models={"chat": "cheap-chat"})))
    loaded, stored = ai_settings.load(db, settings, config)
    assert stored is True and loaded.models.chat == "cheap-chat" and loaded.models.audit == "default-chat"
    # A corrupt document falls back to the defaults instead of breaking every request.
    db.get(AppSetting, ai_settings.SETTINGS_KEY).value = {"thresholds": {"top_k": "many"}}
    db.flush()
    loaded, stored = ai_settings.load(db, settings, config)
    assert stored is False and loaded.models.chat == "default-chat"


@requires_db
def test_embedding_change_guards_the_memory(db, config, embedder):
    settings = _settings()
    db.add(MerchantMemory(raw_pattern="waitrose", normalized_merchant="Waitrose", category="Groceries",
                          default_claim_type="personal", embedding=embedder.embed_one("waitrose")))
    db.flush()
    with pytest.raises(ai_settings.AiSettingsConflict):
        ai_settings.update(db, settings, config, AiUpdate(embedding_provider="hash"), [])
    assert ai_settings.memory_rows(db) == 1
    saved = ai_settings.update(db, settings, config, AiUpdate(embedding_provider="hash", clear_memory=True), [])
    assert saved.embedding_provider == "hash" and ai_settings.memory_rows(db) == 0
    # Changing chat models never touches the memory.
    ai_settings.update(db, settings, config, AiUpdate(models={"chat": "cheap-chat"}), [])


@requires_db
def test_api_get_put_and_test(client, primary_headers, secondary_headers):
    from app.routers import ai as ai_router

    transport = _proxy_transport()
    client.app.dependency_overrides[ai_router.get_catalogue] = lambda: ModelCatalogue(transport=transport)
    assert client.get("/api/ai", headers=secondary_headers).status_code == 403

    info = client.get("/api/ai", headers=primary_headers).json()
    assert info["stored"] is False and info["enabled"] is False  # the test settings run with LLM_PROVIDER=none
    assert info["proxy"]["mode"] == "bundled" and info["proxy"]["reachable"] is True
    assert {m["name"] for m in info["available_models"]} >= {"default-chat", "cheap-chat", "default-embedding"}
    assert "api_key" not in info["proxy"]

    resp = client.put("/api/ai", json={"enabled": True, "models": {"chat": "cheap-chat"}}, headers=primary_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["enabled"] is True and resp.json()["models"]["chat"] == "cheap-chat" and resp.json()["stored"]

    bad = client.put("/api/ai", json={"models": {"audit": "no-such-model"}}, headers=primary_headers)
    assert bad.status_code == 422 and "does not list" in bad.json()["detail"]
    bad = client.put("/api/ai", json={"thresholds": {"similarity_threshold": 1.5}}, headers=primary_headers)
    assert bad.status_code == 422

    resp = client.put(
        "/api/ai",
        json={"proxy": {"mode": "external", "url": "http://host.docker.internal:4000", "api_key": "sk-mine"}},
        headers=primary_headers,
    )
    assert resp.status_code == 200, resp.text
    proxy = resp.json()["proxy"]
    assert proxy["mode"] == "external" and proxy["url"] == "http://host.docker.internal:4000" and proxy["has_key"]
    assert "sk-mine" not in resp.text

    body = {"enabled": False, "embedding_provider": "hash"}
    results = client.post("/api/ai/test", json=body, headers=primary_headers)
    assert results.status_code == 200
    assert results.json()["chat"] is None and results.json()["embedding"]["ok"] is True
