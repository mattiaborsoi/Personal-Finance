"""Tidy merchant names stored before the cleaner learnt to drop bank codes.

Names such as "Acme Water 900000000000 DDR" were kept whole because the trailing
``DDR`` stopped :func:`rules.strip_trailing_noise` from reaching the reference in front
of it. New imports now clean to "Acme Water", so the stored names are tidied the
same way at startup: otherwise a merchant's new lines and its history would carry
different names, and auto-approval, subscriptions and merchant memory would treat
them as two merchants. Only names ending in a bank code or "First"/"Payment" are
looked at, and each is cut with the same rule the cleaner uses, so running it again
changes nothing.
"""

from __future__ import annotations

import logging

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models import MerchantMemory, Transaction
from app.services.rules import strip_trailing_noise

log = logging.getLogger(__name__)

# Postgres word-boundary match on the last token (\m is the start of a word).
_CANDIDATE = r"\m(DDR|DD|BGC|FT|STO|TFR|DEB|CHG|UNP|FIRST|PAYMENT)\s*$"


def tidied(name: str) -> str:
    return " ".join(strip_trailing_noise(name.split()))


def tidy_stored_names(db: Session) -> int:
    """Re-cut stored merchant names ending in a bank code; returns how many names changed. The caller commits."""
    changed = 0
    for column, model in (
        (Transaction.cleaned_merchant, Transaction),
        (MerchantMemory.normalized_merchant, MerchantMemory),
    ):
        names = db.scalars(select(column).distinct().where(column.op("~*")(_CANDIDATE))).all()
        for name in names:
            new = tidied(name)
            if new and new != name:
                db.execute(update(model).where(column == name).values({column.key: new}))
                changed += 1
    if changed:
        log.info("merchant names: tidied %d name(s) ending in a bank code", changed)
    return changed
