"""Shared pytest fixtures.

Database tests need PostgreSQL with pgvector. The URL is resolved from
``TEST_DATABASE_URL``; failing that, from ``DATABASE_URL`` with the database name
suffixed ``_test`` (created on demand - this is what ``docker compose exec backend
pytest`` uses). Without either, DB-backed tests are skipped with a clear reason and
the pure-logic tests still run.

Each test runs inside a transaction that is rolled back at the end, so the schema is
created once per session and tests never see each other's rows.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.config import AppConfig, Settings, load_config, normalise_database_url
from app.database import init_db, make_engine
from app.models import Account
from app.services.embeddings import HashingEmbeddingClient
from app.services.llm import FakeLLMClient

REPO_ROOT = Path(__file__).resolve().parents[2]
# Inside the Docker image the example config is copied next to the app (see backend/Dockerfile).
EXAMPLE_CONFIG = Path(os.environ.get("EXAMPLE_CONFIG_PATH") or REPO_ROOT / "config.example.yaml")
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


# --------------------------------------------------------------------------- #
# Database URL resolution
# --------------------------------------------------------------------------- #


def _test_database_url() -> str | None:
    explicit = os.environ.get("TEST_DATABASE_URL")
    if explicit:
        return normalise_database_url(explicit)
    base = os.environ.get("DATABASE_URL")
    if not base:
        return None
    parts = urlsplit(normalise_database_url(base))
    db_name = parts.path.lstrip("/") or "financemaster"
    if not db_name.endswith("_test"):
        db_name = f"{db_name}_test"
    return urlunsplit((parts.scheme, parts.netloc, f"/{db_name}", parts.query, parts.fragment))


def _ensure_database_exists(url: str) -> None:
    """Create the test database if it is missing (needs CREATEDB rights)."""
    parts = urlsplit(url)
    db_name = parts.path.lstrip("/")
    admin_url = urlunsplit((parts.scheme, parts.netloc, "/postgres", parts.query, parts.fragment))
    admin = make_engine(admin_url, isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            exists = conn.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :n"), {"n": db_name}
            ).scalar()
            if not exists:
                conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    finally:
        admin.dispose()


TEST_DATABASE_URL = _test_database_url()


def requires_db(fn):
    """Decorator/marker for tests that need PostgreSQL."""
    return pytest.mark.skipif(TEST_DATABASE_URL is None, reason="TEST_DATABASE_URL/DATABASE_URL not set")(fn)


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="session")
def config() -> AppConfig:
    return load_config(EXAMPLE_CONFIG)


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings(
        database_url=TEST_DATABASE_URL or "postgresql://postgres:postgres@localhost:5432/financemaster_test",
        config_path=str(EXAMPLE_CONFIG),
        llm_provider="none",
        embedding_provider="hash",
        secret_key="test-secret-key",
        primary_password="primary-pass",
        secondary_password="secondary-pass",
        _env_file=None,  # type: ignore[call-arg]
    )


@pytest.fixture(scope="session")
def engine() -> Iterator[Engine]:
    if TEST_DATABASE_URL is None:
        pytest.skip("TEST_DATABASE_URL/DATABASE_URL not set; skipping database tests")
    try:
        _ensure_database_exists(TEST_DATABASE_URL)
        eng = make_engine(TEST_DATABASE_URL)
        init_db(eng)
    except Exception as exc:  # pragma: no cover - environment problem
        pytest.skip(f"test database unavailable: {exc}")
    yield eng
    eng.dispose()


@pytest.fixture
def db(engine: Engine) -> Iterator[Session]:
    """Transactional session: everything is rolled back after the test."""
    connection = engine.connect()
    outer = connection.begin()
    factory = sessionmaker(bind=connection, autoflush=False, expire_on_commit=False,
                           join_transaction_mode="create_savepoint")
    session = factory()
    try:
        yield session
    finally:
        session.close()
        outer.rollback()
        connection.close()


@pytest.fixture
def seeded_db(db: Session, config: AppConfig) -> Session:
    """Session with the example accounts inserted.

    The seed is committed (which only releases the savepoint under the test's outer
    transaction) so that a router's ``rollback()`` after a failed request cannot
    discard the accounts along with the request's own writes.
    """
    for acc in config.accounts:
        db.add(
            Account(
                id=acc.id,
                institution=acc.institution,
                account_type=acc.account_type,
                owner_user_id=acc.owner,
                identifier_last4=acc.identifier_last4,
            )
        )
    db.commit()
    return db


@pytest.fixture
def embedder() -> HashingEmbeddingClient:
    return HashingEmbeddingClient(dimensions=1536)


@pytest.fixture
def fake_llm() -> FakeLLMClient:
    return FakeLLMClient()


# --------------------------------------------------------------------------- #
# HTTP client (API tests)
# --------------------------------------------------------------------------- #


@pytest.fixture
def client(seeded_db: Session, settings: Settings, config: AppConfig, embedder, fake_llm, tmp_path):
    """FastAPI TestClient wired to the transactional session and offline providers.

    ``fake_llm`` has no handler by default; tests that exercise the LLM path set
    ``fake_llm.handler`` / ``fake_llm.responses`` before making requests.
    """
    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.deps import get_config, get_settings
    from app.main import create_app
    from app.routers.auth import reset_login_throttle
    from app.services.providers import get_embedder, get_llm

    reset_login_throttle()
    test_settings = settings.model_copy(update={"upload_dir": str(tmp_path / "uploads")})
    application = create_app(with_lifespan=False)

    def _db():
        yield seeded_db

    application.dependency_overrides[get_db] = _db
    application.dependency_overrides[get_settings] = lambda: test_settings
    application.dependency_overrides[get_config] = lambda: config
    application.dependency_overrides[get_llm] = lambda: fake_llm
    application.dependency_overrides[get_embedder] = lambda: embedder
    with TestClient(application) as c:
        yield c
    application.dependency_overrides.clear()


@pytest.fixture
def primary_headers(client) -> dict[str, str]:
    resp = client.post("/api/auth/login", json={"password": "primary-pass"})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['token']}"}


@pytest.fixture
def secondary_headers(client) -> dict[str, str]:
    resp = client.post("/api/auth/login", json={"password": "secondary-pass"})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['token']}"}
