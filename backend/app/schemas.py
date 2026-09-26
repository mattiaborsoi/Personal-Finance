"""Pydantic request/response schemas for the REST API (see docs/API.md)."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.config import AccountType, ClaimType, TransferState

Role = Literal["primary", "secondary"]


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #


class LoginRequest(BaseModel):
    password: str = Field(min_length=1)


class SessionInfo(BaseModel):
    role: Role
    user_id: str
    display_name: str


class LoginResponse(SessionInfo):
    token: str


# --------------------------------------------------------------------------- #
# Reference data
# --------------------------------------------------------------------------- #


class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    institution: str
    label: str | None = None
    account_type: str
    owner_user_id: str
    identifier_last4: str
    default_claim_type: str = "personal"
    billed_to: str | None = None
    is_active: bool = True
    transaction_count: int = 0
    created_at: datetime | None = None


class AccountCreate(BaseModel):
    """``POST /accounts``: ``id`` is generated from institution, type and digits when omitted."""

    id: str | None = Field(default=None, max_length=64)
    institution: str = Field(min_length=1, max_length=64)
    label: str | None = Field(default=None, max_length=128)
    account_type: AccountType
    owner: str = Field(min_length=1, max_length=64)
    identifier_last4: str = Field(min_length=1, max_length=8)
    default_claim_type: ClaimType = "personal"
    billed_to: str | None = Field(default=None, max_length=64)


class AccountUpdate(BaseModel):
    """``PATCH /accounts/{id}``: omitted fields are untouched; ``null`` clears ``label`` / ``billed_to``."""

    institution: str | None = Field(default=None, max_length=64)
    label: str | None = Field(default=None, max_length=128)
    account_type: AccountType | None = None
    owner: str | None = Field(default=None, max_length=64)
    identifier_last4: str | None = Field(default=None, max_length=8)
    default_claim_type: ClaimType | None = None
    billed_to: str | None = Field(default=None, max_length=64)
    is_active: bool | None = None


class PeriodOut(BaseModel):
    period_key: str
    start_date: date
    end_date: date
    is_closed: bool
    closed_at: datetime | None = None
    transaction_count: int = 0
    pending_review_count: int = 0


# --------------------------------------------------------------------------- #
# Transactions
# --------------------------------------------------------------------------- #


class TransactionPartOut(BaseModel):
    """One part of a split transaction (a ``transactions`` row with ``split_parent_id``)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    split_index: int | None
    amount: Decimal
    category: str
    subcategory: str | None
    claim_type: str
    is_claimable: bool
    allocated_primary_amount: Decimal
    allocated_secondary_amount: Decimal


class TransactionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    period_key: str | None
    account_id: str | None
    transaction_date: date
    post_date: date | None
    raw_description: str
    cleaned_merchant: str
    amount: Decimal
    currency: str | None
    original_currency: str | None
    foreign_amount: Decimal | None
    category: str
    subcategory: str | None
    claim_type: str
    is_claimable: bool
    allocated_primary_amount: Decimal
    allocated_secondary_amount: Decimal
    review_status: str
    is_internal_transfer: bool
    linked_transfer_id: uuid.UUID | None
    classification_source: str
    classification_confidence: Decimal | None
    source_file: str | None
    created_at: datetime | None
    is_split: bool = False
    split_parent_id: uuid.UUID | None = None
    parts: list[TransactionPartOut] = Field(default_factory=list)


class TransactionListOut(BaseModel):
    items: list[TransactionOut]
    total: int


class SplitPartIn(BaseModel):
    """One requested part: signed like the parent (negative for spend)."""

    amount: Decimal
    category: str = Field(min_length=1, max_length=128)
    subcategory: str | None = Field(default=None, max_length=128)
    claim_type: ClaimType


class SplitRequest(BaseModel):
    """``PUT /transactions/{id}/split``: the parts must sum exactly to the transaction amount."""

    parts: list[SplitPartIn] = Field(min_length=2, max_length=20)


class TransactionUpdate(BaseModel):
    """Fields the user may correct. Allocations are recomputed server-side."""

    category: str | None = None
    subcategory: str | None = None
    claim_type: ClaimType | None = None
    cleaned_merchant: str | None = None
    is_internal_transfer: bool | None = None


class ApproveRequest(TransactionUpdate):
    """Approve a transaction, optionally correcting it first. ``remember`` controls
    whether the confirmed classification is written to merchant memory."""

    remember: bool = True


class BatchApproveRequest(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1)
    remember: bool = True


class BatchApproveOut(BaseModel):
    approved: int
    items: list[TransactionOut]


# --------------------------------------------------------------------------- #
# Uploads / ingestion
# --------------------------------------------------------------------------- #


class UploadResult(BaseModel):
    upload_id: uuid.UUID | None = None
    account_id: str | None
    period_key: str | None
    period_from: str | None = None
    period_to: str | None = None
    parser: str
    inserted: int
    skipped_duplicates: int
    pending_review: int
    auto_approved: int
    transfers_matched: int
    warnings: list[str] = Field(default_factory=list)


class StatementUploadOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    account_id: str | None
    period_key: str | None
    period_from: str | None = None
    period_to: str | None = None
    filename: str
    sha256: str
    parser: str | None
    transaction_count: int
    created_at: datetime | None


# --------------------------------------------------------------------------- #
# Transfers
# --------------------------------------------------------------------------- #


class TransferBufferOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    transaction_id: uuid.UUID | None
    account_id: str | None
    amount: Decimal
    transaction_date: date
    match_status: TransferState
    resolved_at: datetime | None
    description: str | None = None


class ManualMatchRequest(BaseModel):
    buffer_id_a: uuid.UUID
    buffer_id_b: uuid.UUID


class RematchOut(BaseModel):
    matched: int


# --------------------------------------------------------------------------- #
# Partner claims
# --------------------------------------------------------------------------- #


class ClaimCreate(BaseModel):
    claim_date: date
    amount: Decimal = Field(gt=0, description="Positive amount paid by the claimant")
    merchant: str = Field(min_length=1, max_length=255)
    description: str | None = None
    claim_type: ClaimType = "shared_proportional"
    paid_by: str | None = Field(
        default=None,
        description="User id who paid. Secondary users may only submit claims they paid themselves.",
    )


class ClaimOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    period_key: str | None
    claim_date: date
    paid_by: str
    merchant: str
    description: str | None
    amount: Decimal
    claim_type: str
    primary_owes: Decimal
    secondary_owes: Decimal
    is_settled: bool
    created_at: datetime | None


# --------------------------------------------------------------------------- #
# Settlement
# --------------------------------------------------------------------------- #


class SettlementLine(BaseModel):
    """One contribution to the settlement, positive = increases what secondary owes."""

    source: Literal["transaction", "claim"]
    id: uuid.UUID
    date: date
    merchant: str
    amount: Decimal
    claim_type: str
    paid_by: str
    primary_share: Decimal
    secondary_share: Decimal
    effect_on_secondary_owes: Decimal


class SettlementSnapshotOut(BaseModel):
    """The reconciliation debt recorded when the period was closed."""

    model_config = ConfigDict(from_attributes=True)

    period_key: str
    net_owed_by_secondary: Decimal
    secondary_share_of_primary_paid_shared: Decimal
    primary_share_of_secondary_paid_shared: Decimal
    secondary_personal_on_primary_paid: Decimal
    primary_personal_on_secondary_paid: Decimal
    settlement_payments_received: Decimal
    line_count: int
    snapshot_at: datetime | None = None


class SettlementSummary(BaseModel):
    period_key: str
    primary_user_id: str
    secondary_user_id: str
    primary_ratio: Decimal
    secondary_ratio: Decimal
    secondary_share_of_primary_paid_shared: Decimal
    primary_share_of_secondary_paid_shared: Decimal
    secondary_personal_on_primary_paid: Decimal
    primary_personal_on_secondary_paid: Decimal
    net_owed_by_secondary: Decimal
    settlement_payments_received: Decimal = Decimal("0")
    pending_review_count: int = 0
    unsettled_claim_count: int = 0
    settlement_due_date: date | None = None
    snapshot: SettlementSnapshotOut | None = None
    lines: list[SettlementLine] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #


class CategoryAmount(BaseModel):
    category: str
    amount: Decimal


class MacroMetrics(BaseModel):
    household_burn: Decimal
    primary_accounts_burn: Decimal
    partner_claims_burn: Decimal
    refunds: Decimal = Decimal("0.00")
    """Credits received in spend categories this period; shown, never deducted from the burn."""
    by_category: list[CategoryAmount]
    """Gross debits per category plus a ``Partner claims`` row; sums exactly to ``household_burn``."""


class MicroMetrics(BaseModel):
    true_net_expense: Decimal
    from_transactions: Decimal
    from_partner_claims: Decimal
    by_category: list[CategoryAmount]


class LiquidityMetrics(BaseModel):
    credits: Decimal
    debits: Decimal
    net_cash_flow: Decimal
    by_account: list[dict[str, Any]] = Field(default_factory=list)


class MetricsOut(BaseModel):
    period_key: str
    macro: MacroMetrics
    micro: MicroMetrics
    liquidity: LiquidityMetrics


class TrendPoint(BaseModel):
    period_key: str
    household_burn: Decimal
    true_net_expense: Decimal
    net_cash_flow: Decimal


class InvestmentAccountSummary(BaseModel):
    account_id: str
    total_deposits: Decimal
    total_withdrawals: Decimal
    net_invested_capital: Decimal
    realized_gain: Decimal


class InvestmentSummary(BaseModel):
    accounts: list[InvestmentAccountSummary]
    total_deposits: Decimal
    total_withdrawals: Decimal
    net_invested_capital: Decimal
    realized_gain: Decimal


# --------------------------------------------------------------------------- #
# Audit
# --------------------------------------------------------------------------- #


class AnomalyOut(BaseModel):
    transaction_id: uuid.UUID | None = None
    merchant: str
    issue: str
    current_amount: Decimal | None = None
    baseline_amount: Decimal | None = None
    baseline_stddev: Decimal | None = None
    deviation: float | None = None


class CategoryComparisonOut(BaseModel):
    category: str
    current: Decimal
    baseline_average: Decimal
    change_pct: float | None = None
    baseline_periods: int = 0
    """Prior look-back periods with any spend that the average is taken over (same on every row)."""


class AuditReportOut(BaseModel):
    period_key: str
    summary_sentence: str
    anomalies: list[AnomalyOut]
    category_comparison: list[CategoryComparisonOut] = Field(default_factory=list)
    created_at: datetime | None = None


# --------------------------------------------------------------------------- #
# Merchant memory
# --------------------------------------------------------------------------- #


class MemoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    raw_pattern: str
    normalized_merchant: str
    category: str
    default_claim_type: str
    review_count: int
    last_updated: datetime | None


class HealthOut(BaseModel):
    """``GET /health`` is reachable without login through the web port: it says only whether
    the app and its database are up, never which providers or models are configured."""

    status: str
    database: str
