"""FastAPI application entry point."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.auth import validate_security_settings
from app.config import ConfigError
from app.database import get_engine, get_session_factory, init_db
from app.deps import get_config, get_settings
from app.models import EMBEDDING_DIMENSIONS
from app.routers import (
    accounts,
    ai,
    audit,
    auth,
    categories,
    claims,
    memory,
    metrics,
    periods,
    reference,
    settlement,
    site_settings,
    statements,
    system,
    transactions,
    transfers,
)
from app.services.accounts import seed_accounts
from app.services.periods import PeriodClosedError

log = logging.getLogger(__name__)

ROUTERS = (
    auth.router,
    reference.router,
    accounts.router,
    ai.router,
    site_settings.router,
    categories.router,
    periods.router,
    statements.router,
    transactions.router,
    transfers.router,
    claims.router,
    settlement.router,
    metrics.router,
    audit.router,
    memory.router,
    system.router,
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    # Built-in defaults when config.yaml is absent; a ConfigError (fail fast) when it is invalid.
    config = get_config()
    validate_security_settings(settings)
    if settings.embedding_dimensions != EMBEDDING_DIMENSIONS:
        raise ConfigError(
            f"EMBEDDING_DIMENSIONS={settings.embedding_dimensions} but merchant_memory.embedding is "
            f"vector({EMBEDDING_DIMENSIONS}); pick an embedding model with {EMBEDDING_DIMENSIONS} dimensions"
        )
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    init_db(get_engine())
    with get_session_factory()() as db:
        changed = seed_accounts(db, config)
        db.commit()
    if Path(settings.config_path).is_file():
        source = f"defaults from {settings.config_path}"
    else:
        source = (
            "built-in defaults (no config file: set the household, categories, rules and accounts up under Settings)"
        )
    log.info(
        "startup complete: %s, %d account(s) seeded or upgraded from them, llm_provider=%s embedding_provider=%s",
        source,
        changed,
        settings.llm_provider,
        settings.embedding_provider,
    )
    yield


def create_app(*, with_lifespan: bool = True) -> FastAPI:
    app = FastAPI(
        title="Settl API",
        description="Shared money, settled by AI. The REST contract behind the Settl ledger (see docs/API.md).",
        version="0.1.0",
        lifespan=lifespan if with_lifespan else None,
    )

    origins = [o.strip() for o in get_settings().cors_origins.split(",") if o.strip()]
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    for router in ROUTERS:
        app.include_router(router, prefix="/api")

    @app.exception_handler(PeriodClosedError)
    async def _period_closed(_: Request, exc: PeriodClosedError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(ConfigError)
    async def _config_error(_: Request, exc: ConfigError) -> JSONResponse:
        return JSONResponse(status_code=500, content={"detail": f"configuration error: {exc}"})

    return app


app = create_app()
