"""Dual-ledger allocation and end-of-month settlement maths.

Definitions
-----------
* ``amount`` is signed as in the ledger: negative = expense, positive = refund/credit.
* Allocations are signed the same way. ``allocated_primary + allocated_secondary == amount``
  always holds: the primary share is rounded (ROUND_HALF_UP to
  ``settlement.rounding_decimals``) and the secondary share is the exact remainder,
  so no penny is ever lost or created.
* Who *bears* an item depends on ``claim_type`` and on the owner of the account it
  was spent from::

      personal             -> the account owner bears 100 %
      secondary_personal   -> the secondary user bears 100 %
      primary_personal     -> the primary user bears 100 %
      shared_proportional  -> primary_ratio / secondary_ratio (from config)
      shared_equal         -> 50 / 50

* Who *paid* is ``AppConfig.payer_for_account(account_id)`` for transactions (the
  primary user for supplementary cards) and ``PartnerClaim.paid_by`` for claims.

Settlement
----------
``Net owed by secondary`` for a period is::

    + Σ secondary share of items paid by primary
    - Σ primary share of items paid by secondary

which expands to four sums (secondary share of primary-paid shared,
primary share of secondary-paid shared, secondary personal on primary cards, primary
personal on secondary cards). Internal transfers and ``Transfers:*`` categories never
enter the settlement. Only ``auto_approved``/``manual_approved`` transactions count;
the number of still-pending transactions is reported so the UI can warn.

``settlement_payments_received`` is the signed total of the period's approved
``Transfers:Settlement`` lines in both directions (positive = the secondary paid the
primary); see :mod:`app.services.balance`. It is reported, never subtracted from
``net_owed_by_secondary``: the running balance does that.

Every item contributes to exactly one of the four sums, so
``net_owed_by_secondary == sum1 - sum2 + sum3 - sum4`` holds to the penny:

* shared item paid by primary    -> ``secondary_share_of_primary_paid_shared`` (+effect)
* shared item paid by secondary  -> ``primary_share_of_secondary_paid_shared`` (-effect)
* 100 %-other-party item paid by primary   -> ``secondary_personal_on_primary_paid`` (+effect)
* 100 %-other-party item paid by secondary -> ``primary_personal_on_secondary_paid`` (-effect)
* an item borne entirely by its payer has zero effect and is left out of ``lines``.

``SettlementLine`` values (``amount``, ``primary_share``, ``secondary_share``) use the
ledger sign for *both* sources: a partner claim, stored as a positive amount, appears
negated so that a cost is always negative and ``effect_on_secondary_owes`` is always
``-secondary_share`` when primary paid and ``primary_share`` when secondary paid.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import APPROVED_STATUSES, CLAIM_TYPES, TRANSFER_CATEGORY_PREFIX, AppConfig
from app.models import LedgerPeriod, PartnerClaim, Transaction
from app.schemas import SettlementLine, SettlementSummary

SHARED_CLAIM_TYPES: tuple[str, ...] = ("shared_proportional", "shared_equal")
SETTLEMENT_CATEGORY = "Transfers:Settlement"


def quantize(value: Decimal, decimals: int = 2) -> Decimal:
    """ROUND_HALF_UP to ``decimals`` places.

    Halves round away from zero for both signs (``2.345 -> 2.35``, ``-2.995 -> -3.00``),
    which is what the ledger expects for signed money.
    """
    if decimals < 0:
        raise ValueError("decimals must be >= 0")
    return _as_decimal(value).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


def allocate(
    amount: Decimal,
    claim_type: str,
    owner_user_id: str,
    config: AppConfig,
) -> tuple[Decimal, Decimal]:
    """Split a signed ``amount`` into ``(allocated_primary, allocated_secondary)``.

    ``owner_user_id`` is the owner (spender) of the account the item sits on and is
    only consulted for ``claim_type == "personal"``.

    The primary share is ``quantize(amount * ratio)`` and the secondary share is the
    exact remainder, so the pair always sums to ``amount``. ``amount`` is expected to
    already be at ``settlement.rounding_decimals`` places (as stored in the ledger).
    Raises ``ValueError`` for an unknown ``claim_type`` or, for ``personal``, an
    owner that is not a configured user.
    """
    amount = _as_decimal(amount)
    ratio = _primary_ratio_for(claim_type, owner_user_id, config)
    primary = quantize(amount * ratio, config.settlement.rounding_decimals)
    secondary = amount - primary
    return primary, secondary


def claim_shares(amount: Decimal, claim_type: str, paid_by: str, config: AppConfig) -> tuple[Decimal, Decimal]:
    """For a partner claim of positive ``amount`` paid by ``paid_by`` return
    ``(primary_owes, secondary_owes)`` - both >= 0 - i.e. what each user's share of
    the cost is (the payer's own share is included; the settlement engine nets it).

    ``personal`` claims are borne entirely by the payer. A negative ``amount`` raises
    ``ValueError``: claims are always recorded as positive costs.
    """
    amount = _as_decimal(amount)
    if amount < 0:
        raise ValueError("partner claims are recorded as positive amounts")
    # The payer is the "owner" of a claim, so the personal rule falls out naturally.
    return allocate(amount, claim_type, paid_by, config)


def compute_settlement(db: Session, period_key: str, config: AppConfig) -> SettlementSummary:
    """Aggregate approved transactions and partner claims for ``period_key``.

    Read-only apart from an initial ``flush()`` so that rows the caller has added to
    the session but not yet flushed are included. A period that does not exist yields
    an all-zero summary rather than an error.
    """
    db.flush()
    decimals = config.settlement.rounding_decimals
    summary = _empty_summary(period_key, config)
    if not period_key or db.get(LedgerPeriod, period_key) is None:
        return summary

    buckets = _Buckets()
    lines: list[SettlementLine] = []

    for txn in _approved_non_transfer_transactions(db, period_key):
        payer = _payer_for_transaction(txn, config)
        paid_by_primary = config.is_primary(payer)
        primary_share = _as_decimal(txn.allocated_primary_amount)
        secondary_share = _as_decimal(txn.allocated_secondary_amount)
        effect = _effect(paid_by_primary, primary_share, secondary_share)
        if effect == 0:
            continue
        buckets.add(effect, paid_by_primary, txn.claim_type in SHARED_CLAIM_TYPES)
        lines.append(
            SettlementLine(
                source="transaction",
                id=txn.id,
                date=txn.transaction_date,
                merchant=txn.cleaned_merchant,
                amount=_as_decimal(txn.amount),
                claim_type=txn.claim_type,
                paid_by=payer,
                primary_share=primary_share,
                secondary_share=secondary_share,
                effect_on_secondary_owes=effect,
            )
        )

    unsettled = 0
    for claim in _claims(db, period_key):
        if not claim.is_settled:
            unsettled += 1
        paid_by_primary = config.is_primary(claim.paid_by)
        # Claims are stored as positive costs; present them in ledger sign.
        primary_share = -_as_decimal(claim.primary_owes)
        secondary_share = -_as_decimal(claim.secondary_owes)
        effect = _effect(paid_by_primary, primary_share, secondary_share)
        if effect == 0:
            continue
        buckets.add(effect, paid_by_primary, claim.claim_type in SHARED_CLAIM_TYPES)
        lines.append(
            SettlementLine(
                source="claim",
                id=claim.id,
                date=claim.claim_date,
                merchant=claim.merchant,
                amount=-_as_decimal(claim.amount),
                claim_type=claim.claim_type,
                paid_by=claim.paid_by,
                primary_share=primary_share,
                secondary_share=secondary_share,
                effect_on_secondary_owes=effect,
            )
        )

    # Both sources arrive date-ordered; a stable sort merges them by date.
    lines.sort(key=lambda line: line.date)

    summary.secondary_share_of_primary_paid_shared = quantize(buckets.secondary_share_of_primary_paid_shared, decimals)
    summary.primary_share_of_secondary_paid_shared = quantize(buckets.primary_share_of_secondary_paid_shared, decimals)
    summary.secondary_personal_on_primary_paid = quantize(buckets.secondary_personal_on_primary_paid, decimals)
    summary.primary_personal_on_secondary_paid = quantize(buckets.primary_personal_on_secondary_paid, decimals)
    summary.net_owed_by_secondary = (
        summary.secondary_share_of_primary_paid_shared
        - summary.primary_share_of_secondary_paid_shared
        + summary.secondary_personal_on_primary_paid
        - summary.primary_personal_on_secondary_paid
    )
    # Imported here: the balance module builds on this one.
    from app.services.balance import ledger_payments_total

    summary.settlement_payments_received = ledger_payments_total(db, period_key, config)
    summary.pending_review_count = _pending_review_count(db, period_key)
    summary.unsettled_claim_count = unsettled
    summary.lines = lines
    return summary


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


@dataclass
class _Buckets:
    """The four sums, each positive for an expense."""

    secondary_share_of_primary_paid_shared: Decimal = Decimal(0)
    primary_share_of_secondary_paid_shared: Decimal = Decimal(0)
    secondary_personal_on_primary_paid: Decimal = Decimal(0)
    primary_personal_on_secondary_paid: Decimal = Decimal(0)

    def add(self, effect: Decimal, paid_by_primary: bool, is_shared: bool) -> None:
        """Route ``effect`` (signed change to what secondary owes) to its bucket."""
        if paid_by_primary and is_shared:
            self.secondary_share_of_primary_paid_shared += effect
        elif paid_by_primary:
            self.secondary_personal_on_primary_paid += effect
        elif is_shared:
            self.primary_share_of_secondary_paid_shared -= effect
        else:
            self.primary_personal_on_secondary_paid -= effect


def _as_decimal(value: Decimal | int | str | float) -> Decimal:
    """Coerce to ``Decimal`` without going through binary float representation."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def _primary_ratio_for(claim_type: str, owner_user_id: str, config: AppConfig) -> Decimal:
    """Fraction of an item borne by the primary user."""
    if claim_type == "shared_proportional":
        return config.primary_ratio
    if claim_type == "shared_equal":
        return Decimal("0.5")
    if claim_type == "primary_personal":
        return Decimal(1)
    if claim_type == "secondary_personal":
        return Decimal(0)
    if claim_type == "personal":
        if config.is_primary(owner_user_id):
            return Decimal(1)
        if owner_user_id == config.secondary_user_id:
            return Decimal(0)
        raise ValueError(f"owner {owner_user_id!r} is not a configured user")
    raise ValueError(f"unknown claim_type {claim_type!r}; expected one of {CLAIM_TYPES}")


def _effect(paid_by_primary: bool, primary_share: Decimal, secondary_share: Decimal) -> Decimal:
    """Signed change to "secondary owes" for one item, shares in ledger sign.

    Primary paid: secondary owes their share of the cost (an expense's share is
    negative, hence the sign flip; a refund's share is positive and reduces the debt).
    Secondary paid: primary's share of the cost is deducted from what secondary owes.
    """
    return -secondary_share if paid_by_primary else primary_share


def _payer_for_transaction(txn: Transaction, config: AppConfig) -> str:
    """User whose money settled the transaction's account.

    Uses the configuration when the account is known to it, else the account row's
    owner, else the primary user (the master ledger belongs to the primary user).
    """
    if txn.account_id is not None:
        if config.get_account(txn.account_id) is not None:
            return config.payer_for_account(txn.account_id)
        if txn.account is not None:
            return txn.account.owner_user_id
    return config.primary_user_id


def _empty_summary(period_key: str, config: AppConfig) -> SettlementSummary:
    zero = quantize(Decimal(0), config.settlement.rounding_decimals)
    return SettlementSummary(
        period_key=period_key,
        primary_user_id=config.primary_user_id,
        secondary_user_id=config.secondary_user_id,
        primary_ratio=config.primary_ratio,
        secondary_ratio=config.secondary_ratio,
        secondary_share_of_primary_paid_shared=zero,
        primary_share_of_secondary_paid_shared=zero,
        secondary_personal_on_primary_paid=zero,
        primary_personal_on_secondary_paid=zero,
        net_owed_by_secondary=zero,
        settlement_payments_received=zero,
    )


def _approved_non_transfer_transactions(db: Session, period_key: str) -> list[Transaction]:
    """Approved spend rows of the period; a split parent is skipped, its parts count."""
    stmt = (
        select(Transaction)
        .where(
            Transaction.period_key == period_key,
            Transaction.review_status.in_(APPROVED_STATUSES),
            Transaction.is_internal_transfer.is_not(True),
            Transaction.is_split.is_not(True),
            ~Transaction.category.startswith(TRANSFER_CATEGORY_PREFIX),
        )
        .order_by(Transaction.transaction_date, Transaction.created_at, Transaction.split_index)
    )
    return list(db.scalars(stmt))


def _claims(db: Session, period_key: str) -> list[PartnerClaim]:
    stmt = (
        select(PartnerClaim)
        .where(PartnerClaim.period_key == period_key)
        .order_by(PartnerClaim.claim_date, PartnerClaim.created_at)
    )
    return list(db.scalars(stmt))


def _pending_review_count(db: Session, period_key: str) -> int:
    """Pending transactions that would enter the settlement once approved."""
    stmt = (
        select(func.count())
        .select_from(Transaction)
        .where(
            Transaction.period_key == period_key,
            Transaction.review_status == "pending_review",
            Transaction.is_internal_transfer.is_not(True),
            Transaction.is_split.is_not(True),
            ~Transaction.category.startswith(TRANSFER_CATEGORY_PREFIX),
        )
    )
    return int(db.scalar(stmt) or 0)

