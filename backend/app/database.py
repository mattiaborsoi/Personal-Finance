"""Database engine, session factory and idempotent schema initialisation.

The canonical schema lives in ``app/schema.sql`` (plain PostgreSQL DDL, every
statement idempotent). ``init_db`` executes it so a fresh database - or the test
database - is ready without a migration tool. The SQLAlchemy models in
``app/models.py`` map onto that schema.
"""

from __future__ import annotations

from collections.abc import Iterator
from functools import lru_cache
from pathlib import Path

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings, normalise_database_url

SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def make_engine(database_url: str, **kwargs) -> Engine:
    kwargs.setdefault("pool_pre_ping", True)
    kwargs.setdefault("future", True)
    return create_engine(normalise_database_url(database_url), **kwargs)


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    return make_engine(Settings().database_url)


def get_session_factory(engine: Engine | None = None) -> sessionmaker[Session]:
    return sessionmaker(bind=engine or get_engine(), autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    """FastAPI dependency yielding a request-scoped session."""
    session = get_session_factory()()
    try:
        yield session
    finally:
        session.close()


def _split_sql(sql: str) -> list[str]:
    """Split schema.sql into statements. ``DO $$ ... $$`` blocks contain semicolons,
    so a tiny state machine tracks dollar-quoting."""
    # Drop "--" line comments first (the schema has no string literals containing "--").
    sql = "\n".join(line.split("--", 1)[0] for line in sql.splitlines())
    statements: list[str] = []
    buf: list[str] = []
    in_dollar = False
    i = 0
    while i < len(sql):
        two = sql[i : i + 2]
        if two == "$$":
            in_dollar = not in_dollar
            buf.append(two)
            i += 2
            continue
        ch = sql[i]
        if ch == ";" and not in_dollar:
            stmt = "".join(buf).strip()
            if stmt and not _is_only_comments(stmt):
                statements.append(stmt)
            buf = []
        else:
            buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail and not _is_only_comments(tail):
        statements.append(tail)
    return statements


def _is_only_comments(stmt: str) -> bool:
    return all(line.strip().startswith("--") or not line.strip() for line in stmt.splitlines())


def init_db(engine: Engine | None = None) -> None:
    """Create extensions, types, tables, indexes and views if they do not exist."""
    engine = engine or get_engine()
    sql = SCHEMA_PATH.read_text(encoding="utf-8")
    with engine.begin() as conn:
        for stmt in _split_sql(sql):
            conn.execute(text(stmt))


def drop_all(engine: Engine) -> None:
    """Drop every application object (used by the test-suite)."""
    with engine.begin() as conn:
        conn.execute(text("DROP VIEW IF EXISTS investment_position"))
        for table in (
            "settlement_entries",
            "settlement_snapshots",
            "audit_reports",
            "transfer_buffer",
            "partner_claims",
            "merchant_memory",
            "transactions",
            "statement_uploads",
            "ledger_periods",
            "accounts",
        ):
            conn.execute(text(f"DROP TABLE IF EXISTS {table} CASCADE"))
        for enum in ("account_type_enum", "claim_type_enum", "review_status_enum", "transfer_state_enum",
                     "settlement_entry_kind"):
            conn.execute(text(f"DROP TYPE IF EXISTS {enum} CASCADE"))
