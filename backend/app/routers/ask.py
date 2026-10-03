"""Plain-English questions answered at home (see ``app.services.ask``)."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.config import AppConfig
from app.database import get_db
from app.deps import get_effective_config
from app.services import ask as ask_service
from app.services.ask import MAX_QUESTION_LENGTH, CannotAnswer, QuerySpec
from app.services.llm import LLMClient, LLMError, LLMUnavailable
from app.services.providers import get_ask_llm

router = APIRouter(prefix="/ask", tags=["ask"], dependencies=[Depends(require_primary)])


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=MAX_QUESTION_LENGTH)


class AskOut(BaseModel):
    answer: str
    interpreted: str
    query: QuerySpec
    link: str | None
    value: Decimal | None
    count: int
    rows: list[dict[str, Any]]


@router.post("", response_model=AskOut)
def ask(
    body: AskRequest,
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_effective_config),
    llm: LLMClient = Depends(get_ask_llm),
) -> AskOut:
    """Turn the question into a query (the only thing the model sees) and run it locally.

    **409** when AI is off, **422** when the question cannot be expressed as a query,
    **502** when the model could not be reached or answered off-contract.
    """
    if not llm.available:
        raise HTTPException(status.HTTP_409_CONFLICT, "AI is off; turn it on under Settings, AI to ask questions")
    try:
        result = ask_service.ask(db, config, llm, body.question)
    except CannotAnswer as exc:
        db.commit()  # the usage counter was flushed
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    except LLMUnavailable as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except LLMError as exc:
        db.commit()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"the AI could not answer: {exc}") from exc
    db.commit()
    return AskOut(
        answer=result.answer,
        interpreted=result.interpreted,
        query=result.query,
        link=result.link,
        value=result.value,
        count=result.count,
        rows=result.rows,
    )
