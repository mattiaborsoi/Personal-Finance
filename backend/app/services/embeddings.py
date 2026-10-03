"""Embedding providers for the merchant memory store.

* :class:`LiteLLMEmbeddingClient` - ``/v1/embeddings`` on the LiteLLM proxy
  (e.g. ``text-embedding-3-small``, 1536 dims).
* :class:`HashingEmbeddingClient` - deterministic, offline character n-gram feature
  hashing into the same 1536-dim space. Used by the test-suite and available as
  ``EMBEDDING_PROVIDER=hash`` for fully local operation. Similar merchant strings
  map to nearby vectors, so cosine similarity remains meaningful.

The two providers produce incompatible vector spaces; do not mix them in one
``merchant_memory`` table.
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Protocol

import httpx

from app.services.llm import LLMError


class EmbeddingClient(Protocol):
    @property
    def dimensions(self) -> int: ...

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Return one vector per input text (each of length ``dimensions``)."""
        ...


def normalise_merchant_text(text: str) -> str:
    """Canonical form used for both embedding and memory lookups.

    Upper-cases, strips digits/punctuation (store numbers, card refs) and collapses
    whitespace so ``"WAITROSE 1234 LONDON GB"`` and ``"WAITROSE LONDON"`` are close.
    """
    s = (text or "").upper()
    s = re.sub(r"[0-9]+", " ", s)
    s = re.sub(r"[^A-Z& ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


class HashingEmbeddingClient:
    """Feature-hashed character n-gram embeddings (offline, deterministic)."""

    def __init__(self, dimensions: int = 1536, ngram_sizes: tuple[int, ...] = (2, 3, 4)) -> None:
        self._dims = dimensions
        self._ngram_sizes = ngram_sizes

    @property
    def dimensions(self) -> int:
        return self._dims

    def _features(self, text: str) -> list[str]:
        norm = normalise_merchant_text(text)
        feats: list[str] = []
        for token in norm.split(" "):
            if not token:
                continue
            padded = f"#{token}#"
            feats.append(f"w:{token}")
            for n in self._ngram_sizes:
                if len(padded) < n:
                    continue
                feats.extend(f"{n}:{padded[i : i + n]}" for i in range(len(padded) - n + 1))
        return feats

    def embed_one(self, text: str) -> list[float]:
        vec = [0.0] * self._dims
        for feat in self._features(text):
            digest = hashlib.blake2b(feat.encode("utf-8"), digest_size=8).digest()
            idx = int.from_bytes(digest[:4], "big") % self._dims
            sign = 1.0 if digest[4] & 1 else -1.0
            weight = 2.0 if feat.startswith("w:") else 1.0
            vec[idx] += sign * weight
        norm = math.sqrt(sum(v * v for v in vec))
        if norm == 0:
            return vec
        return [v / norm for v in vec]

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self.embed_one(t) for t in texts]


class LiteLLMEmbeddingClient:
    def __init__(
        self,
        base_url: str,
        api_key: str | None,
        model: str,
        dimensions: int = 1536,
        timeout: float = 60.0,
        client: httpx.Client | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self._dims = dimensions
        self.timeout = timeout
        self._client = client

    @property
    def dimensions(self) -> int:
        return self._dims

    def _http(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        payload = {"model": self.model, "input": [normalise_merchant_text(t) or t for t in texts]}
        try:
            resp = self._http().post(f"{self.base_url}/v1/embeddings", json=payload, headers=headers)
        except httpx.HTTPError as exc:
            raise LLMError(f"LiteLLM embeddings request failed: {exc}") from exc
        if resp.status_code >= 400:
            raise LLMError(f"LiteLLM embeddings returned {resp.status_code}: {resp.text[:300]}")
        try:
            body = resp.json()
        except ValueError as exc:
            raise LLMError(f"LiteLLM embeddings returned a non-JSON body: {resp.text[:300]}") from exc
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, list):
            raise LLMError(f"unexpected LiteLLM embeddings response shape: {str(body)[:300]}")
        data = sorted(data, key=lambda d: d.get("index", 0))
        try:
            vectors = [list(map(float, d["embedding"])) for d in data]
        except (KeyError, TypeError, ValueError) as exc:
            raise LLMError("unexpected LiteLLM embeddings response shape: missing embedding") from exc
        if len(vectors) != len(texts):
            raise LLMError("embedding count mismatch")
        for v in vectors:
            if len(v) != self._dims:
                raise LLMError(f"embedding has {len(v)} dims, expected {self._dims}")
        return vectors
