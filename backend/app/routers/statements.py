from __future__ import annotations

import re
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.config import AppConfig, Settings
from app.database import get_db
from app.deps import get_effective_config, get_settings
from app.models import StatementUpload
from app.schemas import StatementUploadOut, UploadResult
from app.services import statement_uploads
from app.services.embeddings import EmbeddingClient
from app.services.ingestion import AccountResolutionError, DuplicateUploadError, ingest_statement
from app.services.llm import LLMClient
from app.services.parsers.base import ParseError
from app.services.periods import PeriodClosedError
from app.services.providers import get_embedder, get_extraction_llm, get_llm

router = APIRouter(prefix="/statements", tags=["statements"], dependencies=[Depends(require_primary)])

ALLOWED_SUFFIXES = {".pdf", ".csv", ".xlsx", ".xls"}
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


def _safe_filename(name: str) -> str:
    base = Path(name or "statement").name
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._") or "statement"
    return base[:120]


@router.post("/upload", response_model=UploadResult)
def upload_statement(
    file: UploadFile = File(...),
    account_id: str | None = Form(default=None),
    db: Session = Depends(get_db),
    config: AppConfig = Depends(get_effective_config),
    settings: Settings = Depends(get_settings),
    embedder: EmbeddingClient = Depends(get_embedder),
    llm: LLMClient = Depends(get_llm),
    extraction_llm: LLMClient = Depends(get_extraction_llm),
) -> UploadResult:
    filename = _safe_filename(file.filename or "")
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "only .pdf, .csv, .xlsx or .xls files are accepted")
    account_id = (account_id or "").strip() or None
    if account_id and config.get_account(account_id) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"unknown account_id {account_id!r}")

    upload_dir = Path(settings.upload_dir or Path(config.app.data_dir) / "uploads")
    upload_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    dest = upload_dir / f"{uuid.uuid4().hex}_{filename}"
    size = 0
    with dest.open("wb") as out:
        while chunk := file.file.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "file larger than 25 MB")
            out.write(chunk)
    if size == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "empty file")

    try:
        result = ingest_statement(db, config, embedder, llm, dest, filename, account_id=account_id)
    except DuplicateUploadError as exc:
        db.rollback()
        dest.unlink(missing_ok=True)
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except AccountResolutionError as exc:
        db.rollback()
        dest.unlink(missing_ok=True)
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, {"message": str(exc), "candidates": exc.candidates}
        ) from exc
    except PeriodClosedError as exc:
        db.rollback()
        dest.unlink(missing_ok=True)
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except ParseError as exc:
        db.rollback()
        dest.unlink(missing_ok=True)
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"could not parse statement: {exc}") from exc
    except Exception:
        db.rollback()
        dest.unlink(missing_ok=True)
        raise
    db.commit()
    if not settings.keep_uploaded_files:
        # The sha256 is stored for duplicate detection; the file itself holds full account details.
        dest.unlink(missing_ok=True)
    return result


@router.get("", response_model=list[StatementUploadOut])
def list_uploads(db: Session = Depends(get_db)) -> list[StatementUploadOut]:
    rows = list(db.scalars(select(StatementUpload).order_by(StatementUpload.created_at.desc())).all())
    deletable = statement_uploads.deletable_flags(db, rows)
    return [StatementUploadOut.model_validate(row).model_copy(update={"deletable": deletable[row.id]}) for row in rows]


@router.delete("/{upload_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_upload(upload_id: uuid.UUID, db: Session = Depends(get_db)) -> Response:
    """Delete an upload and every transaction it brought in, so the file can be uploaded again.

    Its lines, their split parts and mirror legs go with their transfer-buffer rows;
    a counterpart matched to one of them is unlinked and waits in the buffer again.
    Open periods left with nothing in them go too. **409** when any of those lines sits in a closed period, or for an
    upload recorded before lines were linked whose filename another such upload
    shares (``deletable: false`` in the listing).
    """
    upload = db.get(StatementUpload, upload_id)
    if upload is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "upload not found")
    try:
        statement_uploads.delete_upload(db, upload)
    except (PeriodClosedError, statement_uploads.UploadNotDeletable) as exc:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
