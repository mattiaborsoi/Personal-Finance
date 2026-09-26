"""Test data helpers shared by the test modules.

These deliberately avoid depending on the services under test: allocations are
computed here with a straightforward ROUND_HALF_UP split so that, e.g., metrics tests
do not rely on settlement.allocate being correct.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy.orm import Session

from app.config import AppConfig
from app.models import LedgerPeriod, PartnerClaim, Transaction
from app.services.periods import get_or_create_period, period_key_for

D = Decimal


def q2(value: Decimal | str | float) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def simple_allocation(amount: Decimal, claim_type: str, owner: str, config: AppConfig) -> tuple[Decimal, Decimal]:
    amount = q2(amount)
    if claim_type == "shared_proportional":
        p = q2(amount * config.primary_ratio)
        return p, amount - p
    if claim_type == "shared_equal":
        p = q2(amount * D("0.5"))
        return p, amount - p
    if claim_type == "secondary_personal":
        return D("0.00"), amount
    if claim_type == "primary_personal":
        return amount, D("0.00")
    # personal -> owner bears it
    if owner == config.primary_user_id:
        return amount, D("0.00")
    return D("0.00"), amount


def ensure_period(db: Session, period_key: str) -> LedgerPeriod:
    return get_or_create_period(db, period_key)


def make_transaction(
    db: Session,
    config: AppConfig,
    *,
    account_id: str = "acc_cc_amex",
    transaction_date: date = date(2026, 8, 15),
    amount: Decimal | str = "-15.81",
    raw_description: str = "WAITROSE 1234 LONDON",
    cleaned_merchant: str | None = None,
    category: str = "Groceries",
    claim_type: str = "shared_proportional",
    review_status: str = "manual_approved",
    is_internal_transfer: bool = False,
    period_key: str | None = None,
    subcategory: str | None = None,
    classification_source: str = "manual",
    fingerprint: str | None = None,
    **extra,
) -> Transaction:
    """Insert a transaction with allocations derived from ``claim_type``."""
    amount = q2(amount)
    period_key = period_key or period_key_for(transaction_date)
    ensure_period(db, period_key)
    owner = config.account_by_id(account_id).owner
    alloc_p, alloc_s = simple_allocation(amount, claim_type, owner, config)
    if fingerprint is None:
        fingerprint = hashlib.sha256(
            f"{account_id}|{transaction_date}|{amount}|{raw_description}|{uuid.uuid4()}".encode()
        ).hexdigest()
    txn = Transaction(
        period_key=period_key,
        account_id=account_id,
        transaction_date=transaction_date,
        post_date=transaction_date,
        raw_description=raw_description,
        cleaned_merchant=cleaned_merchant or raw_description.title(),
        amount=amount,
        currency=config.app.base_currency,
        category=category,
        subcategory=subcategory,
        claim_type=claim_type,
        allocated_primary_amount=alloc_p,
        allocated_secondary_amount=alloc_s,
        review_status=review_status,
        is_internal_transfer=is_internal_transfer,
        classification_source=classification_source,
        fingerprint=fingerprint,
        **extra,
    )
    db.add(txn)
    db.flush()
    return txn


def make_claim(
    db: Session,
    config: AppConfig,
    *,
    claim_date: date = date(2026, 8, 10),
    amount: Decimal | str = "50.00",
    merchant: str = "Corner Shop",
    claim_type: str = "shared_proportional",
    paid_by: str | None = None,
    description: str | None = None,
    is_settled: bool = False,
) -> PartnerClaim:
    """Insert a partner claim (positive amount paid by ``paid_by``, default secondary)."""
    amount = q2(amount)
    paid_by = paid_by or config.secondary_user_id
    period_key = period_key_for(claim_date)
    ensure_period(db, period_key)
    if claim_type == "shared_proportional":
        primary_owes = q2(amount * config.primary_ratio)
        secondary_owes = amount - primary_owes
    elif claim_type == "shared_equal":
        primary_owes = q2(amount * D("0.5"))
        secondary_owes = amount - primary_owes
    elif claim_type == "primary_personal":
        primary_owes, secondary_owes = amount, D("0.00")
    elif claim_type == "secondary_personal":
        primary_owes, secondary_owes = D("0.00"), amount
    else:  # personal -> payer's own cost
        if paid_by == config.primary_user_id:
            primary_owes, secondary_owes = amount, D("0.00")
        else:
            primary_owes, secondary_owes = D("0.00"), amount
    claim = PartnerClaim(
        period_key=period_key,
        claim_date=claim_date,
        paid_by=paid_by,
        merchant=merchant,
        description=description,
        amount=amount,
        claim_type=claim_type,
        primary_owes=primary_owes,
        secondary_owes=secondary_owes,
        is_settled=is_settled,
    )
    db.add(claim)
    db.flush()
    return claim
