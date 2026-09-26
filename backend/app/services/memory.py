"""pgvector merchant memory store (few-shot retrieval for Agent 2).

Two lookups exist. :func:`lookup_by_key` is an exact match on the coarse
:func:`merchant_key` (the first two words before any store number), which is how a
shop seen once under one store number is recognised under another; the offline
hashing embedder rarely gets such pairs over the similarity threshold. Only when
that finds nothing does the vector :func:`lookup` run. It uses cosine distance::

    SELECT normalized_merchant, category, default_claim_type,
           1 - (embedding <=> :query_embedding) AS similarity
    FROM merchant_memory
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> :query_embedding) >= :threshold   -- only when threshold > 0
    ORDER BY similarity DESC
    LIMIT :k;

``remember`` is the learning feedback loop: when the user approves or corrects a
transaction the confirmed classification is upserted (keyed on the normalised raw
pattern) with a fresh embedding and an incremented ``review_count``.

Every function takes an open :class:`~sqlalchemy.orm.Session`, flushes its own
writes and never commits; the caller owns the transaction.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.config import CLAIM_TYPES
from app.models import MerchantMemory
from app.services.embeddings import EmbeddingClient, normalise_merchant_text

MAX_MERCHANT_LENGTH = 255  # merchant_memory.normalized_merchant is VARCHAR(255)
MAX_CATEGORY_LENGTH = 128  # merchant_memory.category is VARCHAR(128)


@dataclass(slots=True)
class MemoryHit:
    raw_pattern: str
    normalized_merchant: str
    category: str
    default_claim_type: str
    similarity: float
    review_count: int


def memory_key(raw_description: str) -> str:
    """Normalised key stored in ``merchant_memory.raw_pattern``.

    Uses :func:`normalise_merchant_text` (upper-case, digits and punctuation
    stripped, whitespace collapsed) so ``'WAITROSE 1234 LONDON GB'`` and
    ``'waitrose 9876 London GB'`` share one memory row. A description that
    normalises to nothing (e.g. ``'1234 ***'``) falls back to its stripped,
    upper-cased form; a blank description yields ``''``.
    """
    raw = raw_description or ""
    return normalise_merchant_text(raw) or raw.strip().upper()


MERCHANT_KEY_WORDS = 2


def merchant_key(raw_description: str) -> str:
    """Coarse merchant identity: the first two words printed before any store number.

    Leading tokens carrying digits (references, dates) are skipped; the first token
    with a digit *after* the name starts ends it, so the store number and whatever
    follows (branch, town) never enter the key. Each kept token goes through
    :func:`normalise_merchant_text`, so ``'UBER *TRIP HELP.UBER.COM'`` gives
    ``'UBER TRIP'``, ``'TESCO STORES 3021 LONDON'`` ``'TESCO STORES'``,
    ``'WAITROSE 123 LONDON'`` ``'WAITROSE'`` and ``'PRET A MANGER 0012'`` ``'PRET A'``.
    A description with no alphabetic token yields ``''``.
    """
    words: list[str] = []
    for token in (raw_description or "").upper().split():
        if any(ch.isdigit() for ch in token):
            if words:
                break
            continue
        for word in normalise_merchant_text(token).split():
            if any("A" <= ch <= "Z" for ch in word):
                words.append(word)
            if len(words) == MERCHANT_KEY_WORDS:
                return " ".join(words)
    return " ".join(words)


def merchant_keys_conflict(raw_a: str, raw_b: str) -> bool:
    """True when the two descriptions are the same brand's different services.

    Both keys have two words, the first word is shared and the second differs:
    ``'UBER TRIP'`` against ``'UBER EATS'``, ``'AMAZON PRIME'`` against
    ``'AMAZON MKTP'``. Their embeddings sit close together because of the shared
    brand and boilerplate, so a vector hit between them is not to be trusted.
    """
    words_a, words_b = merchant_key(raw_a).split(), merchant_key(raw_b).split()
    if len(words_a) != MERCHANT_KEY_WORDS or len(words_b) != MERCHANT_KEY_WORDS:
        return False
    return words_a[0] == words_b[0] and words_a[1] != words_b[1]


def lookup_by_key(db: Session, raw_description: str) -> MemoryHit | None:
    """Exact match on :func:`merchant_key` before any vector search.

    Returns the most reviewed row whose ``raw_pattern`` is the key or starts with the
    key followed by a space (``raw_pattern`` is the normalised description, so
    ``'TESCO STORES LONDON'`` matches the key ``'TESCO STORES'``), as a
    :class:`MemoryHit` with similarity 1.0. When the matching rows disagree on the
    category or claim type the key is too coarse to trust (``'CARD PAYMENT'`` in a
    bank narrative would otherwise pre-fill every card purchase alike) and ``None``
    is returned so the caller falls through to the vector search.
    """
    key = merchant_key(raw_description)
    if not key:
        return None
    same_key = or_(
        MerchantMemory.raw_pattern == key,
        MerchantMemory.raw_pattern.startswith(key + " ", autoescape=True),
    )
    stmt = (
        select(MerchantMemory)
        .where(same_key)
        .order_by(MerchantMemory.review_count.desc(), MerchantMemory.last_updated.desc(), MerchantMemory.raw_pattern)
    )
    rows = list(db.scalars(stmt))
    if not rows or len({(r.category, r.default_claim_type) for r in rows}) > 1:
        return None
    best = rows[0]
    return MemoryHit(
        raw_pattern=best.raw_pattern,
        normalized_merchant=best.normalized_merchant,
        category=best.category,
        default_claim_type=best.default_claim_type,
        similarity=1.0,
        review_count=best.review_count or 0,
    )


def lookup(
    db: Session,
    embedder: EmbeddingClient,
    raw_description: str,
    *,
    threshold: float = 0.0,
    k: int = 3,
) -> list[MemoryHit]:
    """Nearest memories with cosine similarity at or above ``threshold``.

    A ``threshold`` of 0 (or below) disables filtering and returns the top-``k``
    regardless of how weak the match is (similarity can be negative). Rows without
    an embedding are never returned. Results are ordered by similarity descending;
    ``similarity`` is a float in ``[-1, 1]`` rounded to six decimal places. A blank
    description or ``k <= 0`` returns ``[]`` without touching the database.
    """
    key = memory_key(raw_description)
    if not key or k <= 0:
        return []
    query_vector = embedder.embed([key])[0]
    if _is_zero_vector(query_vector):
        return []  # cosine distance is undefined (NaN) for a zero vector

    # Ordering by the raw distance (ascending) rather than the derived similarity
    # lets PostgreSQL use the HNSW cosine index; the order is identical.
    distance = MerchantMemory.embedding.cosine_distance(query_vector)
    similarity = (1 - distance).label("similarity")
    stmt = select(MerchantMemory, similarity).where(MerchantMemory.embedding.is_not(None))
    if threshold > 0:
        stmt = stmt.where(similarity >= threshold)
    stmt = stmt.order_by(distance, MerchantMemory.review_count.desc()).limit(k)

    hits: list[MemoryHit] = []
    for row, sim in db.execute(stmt):
        hits.append(
            MemoryHit(
                raw_pattern=row.raw_pattern,
                normalized_merchant=row.normalized_merchant,
                category=row.category,
                default_claim_type=row.default_claim_type,
                similarity=_clean_similarity(sim),
                review_count=row.review_count or 0,
            )
        )
    return hits


def _is_zero_vector(vector: list[float]) -> bool:
    return not any(vector)


def _clean_similarity(value: object) -> float:
    """Clamp a raw ``1 - distance`` value into ``[-1, 1]`` and round to 6 dp."""
    sim = float(value) if value is not None else 0.0
    if sim != sim:  # NaN (zero-norm vector); treat as no similarity
        sim = 0.0
    return round(max(-1.0, min(1.0, sim)), 6)


def remember(
    db: Session,
    embedder: EmbeddingClient,
    raw_description: str,
    *,
    normalized_merchant: str,
    category: str,
    claim_type: str,
) -> MerchantMemory:
    """Upsert the confirmed classification for ``raw_description``.

    Keyed on :func:`memory_key`. On insert ``review_count`` is 1; on update the
    merchant, category and claim type are overwritten, the embedding recomputed
    and ``review_count`` incremented. ``last_updated`` is set to now (UTC) either
    way. The row is flushed (not committed) and returned.

    A description whose embedding is the zero vector (e.g. digits only under the
    hashing embedder) is stored with a ``NULL`` embedding: cosine similarity is
    undefined for it, so it is listed but never retrieved by :func:`lookup`.

    Raises :class:`ValueError` for a blank description, a blank merchant or
    category, or an unknown claim type.
    """
    key = memory_key(raw_description)
    if not key:
        raise ValueError("raw_description must not be blank")
    merchant = (normalized_merchant or "").strip()[:MAX_MERCHANT_LENGTH]
    if not merchant:
        raise ValueError("normalized_merchant must not be blank")
    category = (category or "").strip()[:MAX_CATEGORY_LENGTH]
    if not category:
        raise ValueError("category must not be blank")
    if claim_type not in CLAIM_TYPES:
        raise ValueError(f"unknown claim_type {claim_type!r}; expected one of {', '.join(CLAIM_TYPES)}")

    embedding: list[float] | None = embedder.embed([key])[0]
    if embedding is not None and _is_zero_vector(embedding):
        embedding = None
    now = datetime.now(UTC)

    row = db.scalars(select(MerchantMemory).where(MerchantMemory.raw_pattern == key)).first()
    if row is None:
        row = MerchantMemory(
            raw_pattern=key,
            normalized_merchant=merchant,
            category=category,
            default_claim_type=claim_type,
            embedding=embedding,
            review_count=1,
            last_updated=now,
        )
        db.add(row)
    else:
        row.normalized_merchant = merchant
        row.category = category
        row.default_claim_type = claim_type
        row.embedding = embedding
        row.review_count = (row.review_count or 0) + 1
        row.last_updated = now
    db.flush()
    return row


def forget(db: Session, memory_id) -> bool:
    """Delete one memory row by id (``uuid.UUID`` or its string form).

    Returns ``True`` when a row was deleted, ``False`` when nothing matched
    (including ``None`` or an id that is not a valid UUID). Flushes, does not commit.
    """
    if memory_id is None:
        return False
    if isinstance(memory_id, str):
        try:
            memory_id = uuid.UUID(memory_id)
        except ValueError:
            return False
    row = db.get(MerchantMemory, memory_id)
    if row is None:
        return False
    db.delete(row)
    db.flush()
    return True


def list_memories(db: Session, limit: int = 200) -> list[MerchantMemory]:
    """Most recently updated memories first, at most ``limit`` rows."""
    if limit <= 0:
        return []
    stmt = (
        select(MerchantMemory)
        .order_by(MerchantMemory.last_updated.desc(), MerchantMemory.raw_pattern)
        .limit(limit)
    )
    return list(db.scalars(stmt))
