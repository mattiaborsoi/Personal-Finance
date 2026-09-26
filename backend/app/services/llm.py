"""LiteLLM client wrapper.

All external LLM traffic goes through the local LiteLLM proxy (OpenAI-compatible
``/v1/chat/completions``). The wrapper enforces strict JSON responses and keeps
prompts minimal. Two additional implementations exist:

* :class:`NullLLMClient` - raises :class:`LLMUnavailable`; used when
  ``LLM_PROVIDER=none`` so the pipeline degrades to rules + vector memory.
* :class:`FakeLLMClient` - deterministic canned responses for tests.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

log = logging.getLogger(__name__)


class LLMError(RuntimeError):
    """The proxy returned an error or unparseable output."""


class LLMUnavailable(LLMError):
    """No LLM is configured (``LLM_PROVIDER=none``)."""


@dataclass
class LLMUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    calls: int = 0

    def add(self, usage: dict[str, Any] | None) -> None:
        self.calls += 1
        if usage:
            self.prompt_tokens += int(usage.get("prompt_tokens") or 0)
            self.completion_tokens += int(usage.get("completion_tokens") or 0)


class LLMClient(Protocol):
    """Minimal contract used by the Guesser and Auditor agents."""

    @property
    def available(self) -> bool: ...

    def complete_json(self, *, system: str, user: str, max_tokens: int = 1024) -> dict[str, Any]:
        """Send a system + user prompt and return the parsed JSON object the model produced.

        Raises :class:`LLMError` (or :class:`LLMUnavailable`) on failure.
        """
        ...


_FENCE_RE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL)


def parse_json_object(text: str) -> dict[str, Any]:
    """Parse a JSON object from model output, tolerating code fences and leading prose."""
    if text is None:
        raise LLMError("empty model response")
    s = text.strip()
    m = _FENCE_RE.match(s)
    if m:
        s = m.group(1).strip()
    try:
        obj = json.loads(s)
    except json.JSONDecodeError:
        start, end = s.find("{"), s.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise LLMError(f"model response is not JSON: {text[:200]!r}") from None
        try:
            obj = json.loads(s[start : end + 1])
        except json.JSONDecodeError as exc:
            raise LLMError(f"model response is not JSON: {text[:200]!r}") from exc
    if not isinstance(obj, dict):
        raise LLMError("model response is not a JSON object")
    return obj


class LiteLLMClient:
    """Talks to the LiteLLM proxy over its OpenAI-compatible HTTP API."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None,
        model: str,
        timeout: float = 90.0,
        client: httpx.Client | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self.usage = LLMUsage()
        self._client = client

    @property
    def available(self) -> bool:
        return True

    def _http(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def complete_json(self, *, system: str, user: str, max_tokens: int = 1024) -> dict[str, Any]:
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        }
        try:
            resp = self._http().post(
                f"{self.base_url}/v1/chat/completions", json=payload, headers=self._headers()
            )
        except httpx.HTTPError as exc:
            raise LLMError(f"LiteLLM request failed: {exc}") from exc
        if resp.status_code >= 400:
            raise LLMError(f"LiteLLM returned {resp.status_code}: {resp.text[:300]}")
        try:
            data = resp.json()
        except ValueError as exc:
            raise LLMError(f"LiteLLM returned a non-JSON body: {resp.text[:300]}") from exc
        if not isinstance(data, dict):
            raise LLMError(f"unexpected LiteLLM response shape: {str(data)[:300]}")
        self.usage.add(data.get("usage"))
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError(f"unexpected LiteLLM response shape: {str(data)[:300]}") from exc
        log.debug("llm call model=%s prompt_tokens=%s", self.model, (data.get("usage") or {}).get("prompt_tokens"))
        return parse_json_object(content)


class NullLLMClient:
    """Stands in when no LLM is configured."""

    @property
    def available(self) -> bool:
        return False

    def complete_json(self, *, system: str, user: str, max_tokens: int = 1024) -> dict[str, Any]:
        raise LLMUnavailable("LLM_PROVIDER=none: no language model configured")


@dataclass
class FakeLLMClient:
    """Deterministic stand-in for tests.

    Either supply ``responses`` (consumed in order) or a ``handler`` callable that
    receives ``(system, user)`` and returns the dict to hand back. Every call is
    recorded in ``calls``.
    """

    responses: list[dict[str, Any]] = field(default_factory=list)
    handler: Callable[[str, str], dict[str, Any]] | None = None
    calls: list[dict[str, str]] = field(default_factory=list)
    fail: bool = False

    @property
    def available(self) -> bool:
        return True

    def complete_json(self, *, system: str, user: str, max_tokens: int = 1024) -> dict[str, Any]:
        self.calls.append({"system": system, "user": user})
        if self.fail:
            raise LLMError("simulated LLM failure")
        if self.handler is not None:
            return self.handler(system, user)
        if self.responses:
            return self.responses.pop(0)
        raise LLMError("FakeLLMClient has no response queued")
