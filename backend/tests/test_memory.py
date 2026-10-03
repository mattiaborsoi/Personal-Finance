"""pgvector merchant memory: key normalisation, cosine lookup, upsert, forget."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import MerchantMemory
from app.services import memory
from app.services.embeddings import HashingEmbeddingClient
from app.services.memory import (
    MemoryHit,
    forget,
    list_memories,
    lookup,
    lookup_by_key,
    memory_key,
    merchant_key,
    merchant_keys_conflict,
    remember,
)

from .conftest import requires_db

WAITROSE = "WAITROSE 1234 LONDON GB"
ENERGY = "NORTHWIND ENERGY"


def _remember(db: Session, embedder: HashingEmbeddingClient, raw: str, **overrides) -> MerchantMemory:
    fields = {"normalized_merchant": "Waitrose", "category": "Groceries", "claim_type": "shared_proportional"}
    fields.update(overrides)
    return remember(db, embedder, raw, **fields)


# --------------------------------------------------------------------------- #
# memory_key (pure)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("WAITROSE 1234 LONDON GB", "WAITROSE LONDON GB"),
        ("waitrose 9876 London GB", "WAITROSE LONDON GB"),
        ("  Zoom  Ocado  ", "ZOOM OCADO"),
        ("M&S SIMPLY FOOD", "M&S SIMPLY FOOD"),
        ("1234 ***", "1234 ***"),  # normalises to nothing -> stripped upper-case fallback
        ("", ""),
        ("   ", ""),
    ],
)
def test_memory_key(raw: str, expected: str) -> None:
    assert memory_key(raw) == expected


def test_memory_key_tolerates_none() -> None:
    assert memory_key(None) == ""  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# merchant_key + lookup_by_key (exact match before the vector search)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("TESCO STORES 3021 LONDON", "TESCO STORES"),
        ("TESCO STORES 4455 CROYDON", "TESCO STORES"),
        ("WAITROSE 123 LONDON", "WAITROSE"),  # the store number ends the key
        ("WAITROSE 456 CAMDEN", "WAITROSE"),
        ("PRET A MANGER", "PRET A"),
        ("PRET A MANGER 0012 VICTORIA", "PRET A"),
        ("UBER *TRIP HELP.UBER.COM", "UBER TRIP"),
        ("UBER *EATS HELP.UBER.COM", "UBER EATS"),
        ("1234 TESCO STORES 3021", "TESCO STORES"),  # leading references are skipped
        ("12AUG TESCO", "TESCO"),
        ("AMZN MKTP UK*AB1CD2EF3", "AMZN MKTP"),
        ("M&S SIMPLY FOOD", "M&S SIMPLY"),
        ("  waitrose  ", "WAITROSE"),
        ("1234 ***", ""),
        ("", ""),
    ],
)
def test_merchant_key(raw: str, expected: str) -> None:
    assert merchant_key(raw) == expected


def test_merchant_key_tolerates_none() -> None:
    assert merchant_key(None) == ""  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("a", "b", "conflict"),
    [
        ("UBER *TRIP HELP.UBER.COM", "UBER EATS HELP UBER COM", True),
        ("AMAZON PRIME 12", "AMAZON MKTP UK", True),
        ("TESCO STORES 3021", "TESCO STORES CROYDON", False),  # same key
        ("WAITROSE 123 LONDON", "WAITROSE LTD LONDON", False),  # one-word key: no second word to disagree
        ("OCADO RETAIL", "WAITROSE LONDON", False),  # different brands altogether
        ("", "UBER EATS", False),
    ],
)
def test_merchant_keys_conflict(a: str, b: str, conflict: bool) -> None:
    assert merchant_keys_conflict(a, b) is conflict


@requires_db
def test_lookup_by_key_matches_the_same_shop_under_another_store_number(
    db: Session, embedder: HashingEmbeddingClient
) -> None:
    _remember(db, embedder, "TESCO STORES 3021 LONDON", normalized_merchant="Tesco")
    hit = lookup_by_key(db, "TESCO STORES 4455 CROYDON")
    assert hit == MemoryHit("TESCO STORES LONDON", "Tesco", "Groceries", "shared_proportional", 1.0, 1)

    _remember(db, embedder, "WAITROSE 123 LONDON")
    _remember(db, embedder, "PRET A MANGER", normalized_merchant="Pret", category="Dining")
    assert lookup_by_key(db, "WAITROSE 456 CAMDEN").raw_pattern == "WAITROSE LONDON"
    assert lookup_by_key(db, "PRET A MANGER 0012 VICTORIA").normalized_merchant == "Pret"
    assert lookup_by_key(db, "WAITROSE").raw_pattern == "WAITROSE LONDON"  # the bare key matches too

    # The vector search misses all three under the hash embedder (0.74 / 0.56 / 0.79 < 0.82).
    for seen in ("TESCO STORES 4455 CROYDON", "WAITROSE 456 CAMDEN", "PRET A MANGER 0012 VICTORIA"):
        assert lookup(db, embedder, seen, threshold=0.82) == []


@requires_db
def test_lookup_by_key_prefers_the_most_reviewed_row(db: Session, embedder: HashingEmbeddingClient) -> None:
    _remember(db, embedder, "TESCO STORES 3021 LONDON", normalized_merchant="Tesco London")
    _remember(db, embedder, "TESCO STORES 4455 CROYDON", normalized_merchant="Tesco Croydon")
    _remember(db, embedder, "TESCO STORES 4455 CROYDON", normalized_merchant="Tesco Croydon")
    hit = lookup_by_key(db, "TESCO STORES 9 ROMFORD")
    assert (hit.normalized_merchant, hit.review_count, hit.similarity) == ("Tesco Croydon", 2, 1.0)


@requires_db
def test_lookup_by_key_misses_other_services_and_ambiguous_keys(
    db: Session, embedder: HashingEmbeddingClient
) -> None:
    _remember(db, embedder, "UBER *EATS HELP.UBER.COM", normalized_merchant="Uber Eats", category="Dining")
    assert lookup_by_key(db, "UBER *TRIP HELP.UBER.COM") is None
    assert lookup_by_key(db, "UBERX") is None  # a prefix must end at a word boundary
    assert lookup_by_key(db, "") is None and lookup_by_key(db, "1234 ***") is None

    # A bank narrative prefix shared by unrelated purchases: the rows disagree, so no pre-fill.
    _remember(db, embedder, "CARD PAYMENT TO WAITROSE")
    _remember(db, embedder, "CARD PAYMENT TO NETFLIX", normalized_merchant="Netflix",
              category="Subscriptions:Entertainment", claim_type="shared_equal")  # fmt: skip
    assert lookup_by_key(db, "CARD PAYMENT TO TESCO") is None
    # ...but rows that agree are trusted, whichever merchant spelling is the most reviewed.
    _remember(db, embedder, "CARD PAYMENT TO OCADO", normalized_merchant="Ocado")
    _remember(db, embedder, "CARD PAYMENT TO OCADO", normalized_merchant="Ocado")
    forget(db, next(r.id for r in list_memories(db) if r.normalized_merchant == "Netflix"))
    assert lookup_by_key(db, "CARD PAYMENT TO TESCO").normalized_merchant == "Ocado"


@requires_db
def test_lookup_by_key_ignores_rows_that_differ_only_in_claim_type(
    db: Session, embedder: HashingEmbeddingClient
) -> None:
    # Pret filed personal from one store and shared from another: the split is decided
    # per card by the guesser, so the key still names the merchant and its category.
    _remember(db, embedder, "PRET A MANGER 0012", normalized_merchant="Pret", category="Dining", claim_type="personal")
    _remember(db, embedder, "PRET A MANGER VICTORIA", normalized_merchant="Pret", category="Dining",
              claim_type="shared_equal")  # fmt: skip
    hit = lookup_by_key(db, "PRET A MANGER 0099")
    assert hit is not None and (hit.normalized_merchant, hit.category) == ("Pret", "Dining")


# --------------------------------------------------------------------------- #
# remember + lookup
# --------------------------------------------------------------------------- #


@requires_db
def test_remember_then_lookup_same_raw_is_exact_match(db: Session, embedder: HashingEmbeddingClient) -> None:
    row = _remember(db, embedder, WAITROSE)
    assert row.id is not None
    assert row.raw_pattern == "WAITROSE LONDON GB"
    assert row.review_count == 1
    assert row.last_updated is not None and row.last_updated.tzinfo is not None
    assert row.embedding is not None and len(row.embedding) == embedder.dimensions

    hits = lookup(db, embedder, WAITROSE)
    assert len(hits) == 1
    hit = hits[0]
    assert isinstance(hit, MemoryHit)
    assert hit.similarity == pytest.approx(1.0, abs=1e-6)
    assert hit.raw_pattern == "WAITROSE LONDON GB"
    assert hit.normalized_merchant == "Waitrose"
    assert hit.category == "Groceries"
    assert hit.default_claim_type == "shared_proportional"
    assert hit.review_count == 1


@requires_db
def test_lookup_similar_high_unrelated_low(db: Session, embedder: HashingEmbeddingClient) -> None:
    _remember(db, embedder, WAITROSE)
    _remember(db, embedder, ENERGY, normalized_merchant="Northwind Energy", category="Bills:Energy")

    hits = lookup(db, embedder, "WAITROSE 4321 LONDON", threshold=0.0, k=3)
    assert [h.normalized_merchant for h in hits] == ["Waitrose", "Northwind Energy"]
    assert hits[0].similarity > 0.82
    assert hits[1].similarity < 0.2
    for hit in hits:
        assert -1.0 <= hit.similarity <= 1.0
        assert isinstance(hit.similarity, float)
        assert round(hit.similarity, 6) == hit.similarity


@requires_db
def test_lookup_threshold_filters_weak_matches(db: Session, embedder: HashingEmbeddingClient) -> None:
    _remember(db, embedder, WAITROSE)
    _remember(db, embedder, ENERGY, normalized_merchant="Northwind Energy", category="Bills:Energy")

    hits = lookup(db, embedder, "WAITROSE 4321 LONDON", threshold=0.82, k=3)
    assert [h.normalized_merchant for h in hits] == ["Waitrose"]

    assert lookup(db, embedder, "SOME NEW CAFE", threshold=0.82, k=3) == []
    # threshold 0 -> top-k regardless of strength
    assert len(lookup(db, embedder, "SOME NEW CAFE", threshold=0.0, k=3)) == 2


@requires_db
def test_lookup_respects_k(db: Session, embedder: HashingEmbeddingClient) -> None:
    for i, name in enumerate(["WAITROSE", "OCADO", "TESCO", "SAINSBURYS", "LIDL"]):
        _remember(db, embedder, f"{name} {i}", normalized_merchant=name.title())

    assert len(lookup(db, embedder, "WAITROSE 9", k=2)) == 2
    assert len(lookup(db, embedder, "WAITROSE 9", k=10)) == 5
    assert lookup(db, embedder, "WAITROSE 9", k=0) == []


@requires_db
def test_lookup_blank_or_empty_table(db: Session, embedder: HashingEmbeddingClient) -> None:
    assert lookup(db, embedder, "WAITROSE") == []  # nothing remembered yet
    _remember(db, embedder, WAITROSE)
    assert lookup(db, embedder, "") == []
    assert lookup(db, embedder, "   ") == []


@requires_db
def test_zero_vector_descriptions_never_pollute_lookups(db: Session, embedder: HashingEmbeddingClient) -> None:
    # Digits-only text hashes to the zero vector: cosine distance would be NaN,
    # which PostgreSQL sorts above every real number. Store NULL instead.
    numeric = _remember(db, embedder, "1234 ***", normalized_merchant="Ref 1234", category="Fees:Bank")
    assert numeric.raw_pattern == "1234 ***"
    assert numeric.embedding is None
    _remember(db, embedder, WAITROSE)

    hits = lookup(db, embedder, "WAITROSE 4321 LONDON", threshold=0.0, k=5)
    assert [h.raw_pattern for h in hits] == ["WAITROSE LONDON GB"]
    assert lookup(db, embedder, "9999", threshold=0.0, k=5) == []  # zero query vector
    assert [r.raw_pattern for r in list_memories(db)] == ["WAITROSE LONDON GB", "1234 ***"]


@requires_db
def test_lookup_excludes_rows_without_embedding(db: Session, embedder: HashingEmbeddingClient) -> None:
    db.add(
        MerchantMemory(
            raw_pattern="LEGACY ROW",
            normalized_merchant="Legacy",
            category="Shopping:Home",
            default_claim_type="personal",
            embedding=None,
        )
    )
    db.flush()
    _remember(db, embedder, WAITROSE)

    hits = lookup(db, embedder, "LEGACY ROW", threshold=0.0, k=5)
    assert [h.raw_pattern for h in hits] == ["WAITROSE LONDON GB"]
    assert lookup(db, embedder, "LEGACY ROW", threshold=0.5, k=5) == []


# --------------------------------------------------------------------------- #
# upsert semantics
# --------------------------------------------------------------------------- #


@requires_db
def test_remember_upserts_and_increments_review_count(db: Session, embedder: HashingEmbeddingClient) -> None:
    first = _remember(db, embedder, WAITROSE)
    first_updated = first.last_updated
    first_embedding = list(first.embedding)

    second = _remember(
        db, embedder, "waitrose 9876 London GB", normalized_merchant="Waitrose Ltd", category="Dining",
        claim_type="shared_equal",
    )  # fmt: skip

    assert second.id == first.id
    assert second.review_count == 2
    assert second.normalized_merchant == "Waitrose Ltd"
    assert second.category == "Dining"
    assert second.default_claim_type == "shared_equal"
    assert second.last_updated >= first_updated
    assert list(second.embedding) == pytest.approx(first_embedding)  # same key -> same vector

    assert db.scalar(select(func.count()).select_from(MerchantMemory)) == 1
    hit = lookup(db, embedder, WAITROSE)[0]
    assert (hit.category, hit.default_claim_type, hit.review_count) == ("Dining", "shared_equal", 2)


@requires_db
def test_remember_re_embeds_on_update(db: Session, embedder: HashingEmbeddingClient, monkeypatch) -> None:
    row = _remember(db, embedder, WAITROSE)
    monkeypatch.setattr(embedder, "embed", lambda texts: [[0.5] * embedder.dimensions for _ in texts])
    updated = _remember(db, embedder, WAITROSE)
    assert updated.id == row.id
    assert list(updated.embedding)[:3] == pytest.approx([0.5, 0.5, 0.5])


@requires_db
@pytest.mark.parametrize(
    ("raw", "overrides"),
    [
        ("", {}),
        ("   ", {}),
        (WAITROSE, {"claim_type": "household"}),
        (WAITROSE, {"normalized_merchant": "  "}),
        (WAITROSE, {"category": ""}),
    ],
)
def test_remember_rejects_invalid_input(db: Session, embedder: HashingEmbeddingClient, raw, overrides) -> None:
    with pytest.raises(ValueError):
        _remember(db, embedder, raw, **overrides)
    assert db.scalar(select(func.count()).select_from(MerchantMemory)) == 0


@requires_db
def test_remember_truncates_long_merchant(db: Session, embedder: HashingEmbeddingClient) -> None:
    row = _remember(db, embedder, WAITROSE, normalized_merchant="W" * 300)
    assert len(row.normalized_merchant) == memory.MAX_MERCHANT_LENGTH


# --------------------------------------------------------------------------- #
# forget + list
# --------------------------------------------------------------------------- #


@requires_db
def test_forget(db: Session, embedder: HashingEmbeddingClient) -> None:
    row = _remember(db, embedder, WAITROSE)
    other = _remember(db, embedder, ENERGY, normalized_merchant="Northwind Energy", category="Bills:Energy")

    assert forget(db, row.id) is True
    assert forget(db, row.id) is False  # already gone
    assert db.get(MerchantMemory, row.id) is None
    assert lookup(db, embedder, WAITROSE, threshold=0.9) == []

    assert forget(db, str(other.id)) is True  # string ids accepted
    assert forget(db, uuid.uuid4()) is False
    assert forget(db, "not-a-uuid") is False
    assert forget(db, None) is False
    assert list_memories(db) == []


@requires_db
def test_list_memories_newest_first_with_limit(db: Session, embedder: HashingEmbeddingClient) -> None:
    _remember(db, embedder, WAITROSE)
    _remember(db, embedder, ENERGY, normalized_merchant="Northwind Energy", category="Bills:Energy")
    _remember(db, embedder, "NETFLIX.COM", normalized_merchant="Netflix", category="Subscriptions:Entertainment")
    _remember(db, embedder, WAITROSE)  # touch -> becomes the most recent

    rows = list_memories(db)
    assert [r.raw_pattern for r in rows] == ["WAITROSE LONDON GB", "NETFLIX COM", "NORTHWIND ENERGY"]
    assert rows[0].review_count == 2

    assert [r.raw_pattern for r in list_memories(db, limit=1)] == ["WAITROSE LONDON GB"]
    assert list_memories(db, limit=0) == []
