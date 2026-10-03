"""LiteLLM client wrapper.

All external LLM traffic goes through the local LiteLLM proxy (OpenAI-compatible
``/v1/chat/completions``). The wrapper enforces strict JSON responses and keeps
prompts minimal. Failures are typed so callers can tell a one-off bad answer
(:class:`LLMError`) from an outage that will recur on every call
(:class:`LLMUnreachable` for transport errors, :class:`LLMStatusError` for HTTP
error statuses). Two additional implementations exist:

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

from app.services import ai_usage

log = logging.getLogger(__name__)


class LLMError(RuntimeError):
    """The proxy returned an error or unparseable output."""


class LLMUnavailable(LLMError):
    """No LLM is configured (``LLM_PROVIDER=none``)."""


class LLMUnreachable(LLMError):
    """The proxy could not be reached or did not answer in time (an httpx transport error).

    ``reason`` is a short, human-readable cause (``"connection refused"``,
    ``"no answer within 20 s"``) for user-facing warnings. Unlike a bad answer, this
    will recur for every call of the same upload, so callers may stop retrying.
    """

    def __init__(self, message: str, reason: str = "unreachable") -> None:
        super().__init__(message)
        self.reason = reason


class LLMStatusError(LLMError):
    """The proxy answered with an HTTP error status: reachable, but failing."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code

    @property
    def reason(self) -> str:
        return f"proxy returned HTTP {self.status_code}"


def unreachable_reason(exc: httpx.TransportError, timeout: float | None) -> str:
    """Short cause of a transport error, for :class:`LLMUnreachable`."""
    if isinstance(exc, httpx.ConnectTimeout):
        return "connection timed out"
    if isinstance(exc, httpx.ConnectError):
        return "connection refused" if "refused" in str(exc).lower() else "cannot connect"
    if isinstance(exc, httpx.TimeoutException):
        return f"no answer within {timeout:g} s" if timeout else "no answer in time"
    return "network error"


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
        job: str = "chat",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self._client = client
        self.job = job
        """Which job the calls are counted under (``app.services.ai_usage``)."""

    @property
    def available(self) -> bool:
        return True

    def _http(self) -> httpx.Client:
        # One client per instance, shared by the threads that classify batches side by side
        # (httpx.Client is thread-safe and pools the connections).
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
        except httpx.TransportError as exc:
            ai_usage.record_failure(self.job)
            raise LLMUnreachable(f"LiteLLM request failed: {exc}", unreachable_reason(exc, self.timeout)) from exc
        except httpx.HTTPError as exc:
            ai_usage.record_failure(self.job)
            raise LLMError(f"LiteLLM request failed: {exc}") from exc
        if resp.status_code >= 400:
            ai_usage.record_failure(self.job)
            raise LLMStatusError(f"LiteLLM returned {resp.status_code}: {resp.text[:300]}", resp.status_code)
        try:
            data = resp.json()
        except ValueError as exc:
            ai_usage.record_failure(self.job)
            raise LLMError(f"LiteLLM returned a non-JSON body: {resp.text[:300]}") from exc
        if not isinstance(data, dict):
            ai_usage.record_failure(self.job)
            raise LLMError(f"unexpected LiteLLM response shape: {str(data)[:300]}")
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else None
        ai_usage.record(self.job, usage)
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError(f"unexpected LiteLLM response shape: {str(data)[:300]}") from exc
        log.debug("llm call job=%s model=%s prompt_tokens=%s", self.job, self.model, (usage or {}).get("prompt_tokens"))
        return parse_json_object(content)


class NullLLMClient:
    """Stands in when no LLM is configured."""

    job = "none"

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
    recorded in ``calls``. ``fail`` raises a plain :class:`LLMError` (a bad answer),
    ``unreachable`` raises :class:`LLMUnreachable` (connection refused) and
    ``http_status`` raises :class:`LLMStatusError` with that status.
    """

    responses: list[dict[str, Any]] = field(default_factory=list)
    handler: Callable[[str, str], dict[str, Any]] | None = None
    calls: list[dict[str, str]] = field(default_factory=list)
    fail: bool = False
    unreachable: bool = False
    http_status: int | None = None
    job: str = "chat"

    @property
    def available(self) -> bool:
        return True

    def complete_json(self, *, system: str, user: str, max_tokens: int = 1024) -> dict[str, Any]:
        self.calls.append({"system": system, "user": user})
        if self.unreachable:
            raise LLMUnreachable("simulated unreachable proxy", "connection refused")
        if self.http_status is not None:
            raise LLMStatusError(f"simulated LiteLLM error {self.http_status}", self.http_status)
        if self.fail:
            raise LLMError("simulated LLM failure")
        if self.handler is not None:
            return self.handler(system, user)
        if self.responses:
            return self.responses.pop(0)
        raise LLMError("FakeLLMClient has no response queued")
