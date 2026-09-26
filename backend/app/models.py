"""SQLAlchemy ORM models mapping onto ``app/schema.sql``.

The schema is created by ``app.database.init_db`` from the SQL file; these classes
are the typed mapping used by services and routers. Keep them in sync with the DDL.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Boolean,
    Computed,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import ENUM, JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.config import ACCOUNT_TYPES, CLAIM_TYPES

EMBEDDING_DIMENSIONS = 1536

account_type_enum = ENUM(*ACCOUNT_TYPES, name="account_type_enum", create_type=False)
claim_type_enum = ENUM(*CLAIM_TYPES, name="claim_type_enum", create_type=False)
review_status_enum = ENUM(
    "pending_review", "auto_approved", "manual_approved", name="review_status_enum", create_type=False
)
transfer_state_enum = ENUM("unmatched", "matched", "ignored", name="transfer_state_enum", create_type=False)


class Base(DeclarativeBase):
    pass


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    institution: Mapped[str] = mapped_column(String(64), nullable=False)
    label: Mapped[str | None] = mapped_column(String(128))
    account_type: Mapped[str] = mapped_column(account_type_enum, nullable=False)
    owner_user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    identifier_last4: Mapped[str] = mapped_column(String(8), nullable=False)
    default_claim_type: Mapped[str] = mapped_column(
        claim_type_enum, nullable=False, default="personal", server_default="personal"
    )
    billed_to: Mapped[str | None] = mapped_column(String(64))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    transactions: Mapped[list[Transaction]] = relationship(back_populates="account")


class AppSetting(Base):
    """A settings document edited in the UI (e.g. ``key="ai"``), overriding file defaults."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class LedgerPeriod(Base):
    __tablename__ = "ledger_periods"

    period_key: Mapped[str] = mapped_column(String(7), primary_key=True)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    is_closed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class StatementUpload(Base):
    __tablename__ = "statement_uploads"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[str | None] = mapped_column(String(64), ForeignKey("accounts.id"))
    period_key: Mapped[str | None] = mapped_column(String(7), ForeignKey("ledger_periods.period_key"))
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    parser: Mapped[str | None] = mapped_column(String(64))
    transaction_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_key: Mapped[str | None] = mapped_column(String(7), ForeignKey("ledger_periods.period_key"))
    account_id: Mapped[str | None] = mapped_column(String(64), ForeignKey("accounts.id"))
    transaction_date: Mapped[date] = mapped_column(Date, nullable=False)
    post_date: Mapped[date | None] = mapped_column(Date)
    raw_description: Mapped[str] = mapped_column(Text, nullable=False)
    cleaned_merchant: Mapped[str] = mapped_column(String(255), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str | None] = mapped_column(String(3), default="GBP", server_default="GBP")
    original_currency: Mapped[str | None] = mapped_column(String(3))
    foreign_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    category: Mapped[str] = mapped_column(String(128), nullable=False)
    subcategory: Mapped[str | None] = mapped_column(String(128))

    claim_type: Mapped[str] = mapped_column(
        claim_type_enum, nullable=False, default="personal", server_default="personal"
    )
    is_claimable: Mapped[bool] = mapped_column(Boolean, Computed("claim_type != 'personal'", persisted=True))
    allocated_primary_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    allocated_secondary_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)

    review_status: Mapped[str] = mapped_column(
        review_status_enum, default="pending_review", server_default="pending_review"
    )
    is_internal_transfer: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    linked_transfer_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("transactions.id")
    )

    classification_source: Mapped[str] = mapped_column(
        String(16), nullable=False, default="none", server_default="none"
    )
    classification_confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    fingerprint: Mapped[str | None] = mapped_column(String(64), unique=True)

    # Split transactions (see app.services.splits): the parent is flagged ``is_split``
    # and carries no money of its own; its parts point back via ``split_parent_id``.
    is_split: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    split_parent_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("transactions.id", ondelete="CASCADE")
    )
    split_index: Mapped[int | None] = mapped_column(Integer)

    source_file: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())

    account: Mapped[Account | None] = relationship(back_populates="transactions")
    period: Mapped[LedgerPeriod | None] = relationship()
    parts: Mapped[list[Transaction]] = relationship(
        "Transaction",
        foreign_keys=[split_parent_id],
        back_populates="split_parent",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="Transaction.split_index",
    )
    split_parent: Mapped[Transaction | None] = relationship(
        "Transaction", foreign_keys=[split_parent_id], remote_side=[id], back_populates="parts"
    )

    @property
    def is_split_part(self) -> bool:
        return self.split_parent_id is not None

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Transaction {self.transaction_date} {self.account_id} {self.amount} {self.cleaned_merchant!r}>"


class MerchantMemory(Base):
    __tablename__ = "merchant_memory"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    raw_pattern: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    normalized_merchant: Mapped[str] = mapped_column(String(255), nullable=False)
    category: Mapped[str] = mapped_column(String(128), nullable=False)
    default_claim_type: Mapped[str] = mapped_column(claim_type_enum, nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIMENSIONS))
    review_count: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    last_updated: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PartnerClaim(Base):
    __tablename__ = "partner_claims"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_key: Mapped[str | None] = mapped_column(String(7), ForeignKey("ledger_periods.period_key"))
    claim_date: Mapped[date] = mapped_column(Date, nullable=False)
    paid_by: Mapped[str] = mapped_column(String(64), nullable=False)
    merchant: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    claim_type: Mapped[str] = mapped_column(
        claim_type_enum, nullable=False, default="shared_proportional", server_default="shared_proportional"
    )
    primary_owes: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    secondary_owes: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    is_settled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TransferBuffer(Base):
    __tablename__ = "transfer_buffer"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    transaction_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("transactions.id", ondelete="CASCADE")
    )
    account_id: Mapped[str | None] = mapped_column(String(64), ForeignKey("accounts.id"))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    transaction_date: Mapped[date] = mapped_column(Date, nullable=False)
    match_status: Mapped[str] = mapped_column(
        transfer_state_enum, default="unmatched", server_default="unmatched"
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    transaction: Mapped[Transaction | None] = relationship()


class AuditReport(Base):
    __tablename__ = "audit_reports"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_key: Mapped[str | None] = mapped_column(String(7), ForeignKey("ledger_periods.period_key"))
    summary_sentence: Mapped[str] = mapped_column(Text, nullable=False)
    anomalies: Mapped[list] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    category_comparison: Mapped[list] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SettlementSnapshot(Base):
    """The settlement ledger entry written when a period is closed."""

    __tablename__ = "settlement_snapshots"

    period_key: Mapped[str] = mapped_column(String(7), ForeignKey("ledger_periods.period_key"), primary_key=True)
    net_owed_by_secondary: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    secondary_share_of_primary_paid_shared: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    primary_share_of_secondary_paid_shared: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    secondary_personal_on_primary_paid: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    primary_personal_on_secondary_paid: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    settlement_payments_received: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0"))
    line_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    snapshot_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
