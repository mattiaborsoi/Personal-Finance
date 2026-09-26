"""Cross-ledger transfer buffer: registration, matching, linking and manual resolution."""

from __future__ import annotations

import uuid
from datetime import UTC, date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from app.config import AppConfig
from app.models import Transaction, TransferBuffer
from app.services import transfers
from tests.conftest import requires_db
from tests.factories import make_transaction

CHECKING = "acc_checking_hsbc"
CARD = "acc_cc_amex"
OTHER_CARD = "acc_cc_virgin"

CHECKING_DATE = date(2026, 7, 28)
CARD_DATE = date(2026, 7, 30)
AMOUNT = Decimal("3384.21")


def _register(
    db: Session,
    config: AppConfig,
    *,
    account_id: str,
    amount: Decimal | str,
    transaction_date: date,
    raw_description: str = "HSBC CARD PYMT",
) -> TransferBuffer:
    """Insert an internal-transfer transaction and put it in the buffer."""
    txn = make_transaction(
        db,
        config,
        account_id=account_id,
        amount=amount,
        transaction_date=transaction_date,
        raw_description=raw_description,
        category="Transfers:Internal",
        claim_type="personal",
        classification_source="transfer",
    )
    return transfers.register_transfer(db, txn)


def _checking(db: Session, config: AppConfig, **kw) -> TransferBuffer:
    kw.setdefault("account_id", CHECKING)
    kw.setdefault("amount", -AMOUNT)
    kw.setdefault("transaction_date", CHECKING_DATE)
    kw.setdefault("raw_description", "HSBC CARD PYMT")
    return _register(db, config, **kw)


def _card(db: Session, config: AppConfig, **kw) -> TransferBuffer:
    kw.setdefault("account_id", CARD)
    kw.setdefault("amount", AMOUNT)
    kw.setdefault("transaction_date", CARD_DATE)
    kw.setdefault("raw_description", "PAYMENT RECEIVED - THANK YOU")
    return _register(db, config, **kw)


# --------------------------------------------------------------------------- #
# is_transfer_description (pure logic)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "raw",
    [
        "HSBC CARD PYMT",
        "PAYMENT RECEIVED - THANK YOU",
        "PAYMENT RECEIVED THANK YOU",
        "payment dd thank you",
        "AMERICAN EXPRESS DIRECT DEBIT",
        "VIRGIN MONEY CC",
        "ROBINHOOD",  # deterministic rule with transfer_to_account
    ],
)
def test_is_transfer_description_positive(raw: str, config: AppConfig) -> None:
    assert transfers.is_transfer_description(raw, config) is True


@pytest.mark.parametrize("raw", ["WAITROSE 1234 LONDON GB", "NORTHWIND ENERGY", "PARTNER TRANSFER CR", "", None])
def test_is_transfer_description_negative(raw: str | None, config: AppConfig) -> None:
    assert transfers.is_transfer_description(raw, config) is False  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# register_transfer
# --------------------------------------------------------------------------- #


@requires_db
def test_register_transfer_copies_fields_and_flags_transaction(seeded_db: Session, config: AppConfig) -> None:
    txn = make_transaction(
        seeded_db,
        config,
        account_id=CHECKING,
        amount="-3384.21",
        transaction_date=CHECKING_DATE,
        raw_description="HSBC CARD PYMT",
        category="Transfers:Internal",
        claim_type="personal",
        is_internal_transfer=False,
    )
    entry = transfers.register_transfer(seeded_db, txn)

    assert txn.is_internal_transfer is True
    assert entry.id is not None
    assert entry.transaction_id == txn.id
    assert entry.account_id == CHECKING
    assert entry.amount == Decimal("-3384.21")
    assert entry.transaction_date == CHECKING_DATE
    assert entry.match_status == "unmatched"
    assert entry.resolved_at is None


@requires_db
def test_register_transfer_is_idempotent(seeded_db: Session, config: AppConfig) -> None:
    entry = _checking(seeded_db, config)
    again = transfers.register_transfer(seeded_db, entry.transaction)
    assert again.id == entry.id
    assert len(transfers.unmatched(seeded_db)) == 1


@requires_db
def test_register_transfer_accepts_unflushed_transaction(seeded_db: Session, config: AppConfig) -> None:
    txn = Transaction(
        period_key=None,
        account_id=CHECKING,
        transaction_date=CHECKING_DATE,
        raw_description="HSBC CARD PYMT",
        cleaned_merchant="Hsbc Card Pymt",
        amount=Decimal("-3384.21"),
        category="Transfers:Internal",
        claim_type="personal",
        allocated_primary_amount=Decimal("-3384.21"),
        allocated_secondary_amount=Decimal("0.00"),
    )
    entry = transfers.register_transfer(seeded_db, txn)
    assert txn.id is not None
    assert entry.transaction_id == txn.id


# --------------------------------------------------------------------------- #
# Matching
# --------------------------------------------------------------------------- #


@requires_db
def test_blueprint_fixture_matches_and_links_both_ways(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    card = _card(seeded_db, config)

    assert transfers.match_pending(seeded_db, config) == 1

    assert checking.match_status == "matched"
    assert card.match_status == "matched"
    assert checking.resolved_at is not None and checking.resolved_at.tzinfo is not None
    assert checking.resolved_at == card.resolved_at
    assert checking.resolved_at.astimezone(UTC).date() >= date(2026, 1, 1)

    txn_checking = checking.transaction
    txn_card = card.transaction
    assert txn_checking.linked_transfer_id == txn_card.id
    assert txn_card.linked_transfer_id == txn_checking.id
    assert txn_checking.is_internal_transfer is True
    assert txn_card.is_internal_transfer is True

    assert transfers.unmatched(seeded_db) == []
    # a second run has nothing left to do
    assert transfers.match_pending(seeded_db, config) == 0


@requires_db
def test_find_match_returns_counterpart(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    card = _card(seeded_db, config)
    assert transfers.find_match(seeded_db, checking, config).id == card.id
    assert transfers.find_match(seeded_db, card, config).id == checking.id


@requires_db
@pytest.mark.parametrize(("days_apart", "expected"), [(7, True), (-7, True), (8, False), (-8, False), (0, True)])
def test_window_boundary_is_inclusive(seeded_db: Session, config: AppConfig, days_apart: int, expected: bool) -> None:
    assert config.transfers.match_window_days == 7
    checking = _checking(seeded_db, config)
    card = _card(seeded_db, config, transaction_date=CHECKING_DATE + timedelta(days=days_apart))
    found = transfers.find_match(seeded_db, checking, config)
    assert (found is not None and found.id == card.id) is expected


@requires_db
@pytest.mark.parametrize(
    ("card_amount", "expected"),
    [("3384.21", True), ("3384.22", True), ("3384.20", True), ("3384.23", False), ("3384.19", False)],
)
def test_amount_tolerance(seeded_db: Session, config: AppConfig, card_amount: str, expected: bool) -> None:
    assert config.transfers.amount_tolerance == Decimal("0.01")
    checking = _checking(seeded_db, config)
    card = _card(seeded_db, config, amount=card_amount)
    found = transfers.find_match(seeded_db, checking, config)
    assert (found is not None and found.id == card.id) is expected


@requires_db
def test_same_sign_amounts_never_match(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    _card(seeded_db, config, amount=-AMOUNT)  # a debit on the card, not a payment credit
    assert transfers.find_match(seeded_db, checking, config) is None


@requires_db
def test_same_account_never_matches(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    _checking(seeded_db, config, amount=AMOUNT, transaction_date=CARD_DATE, raw_description="REFUND")
    assert transfers.find_match(seeded_db, checking, config) is None
    assert transfers.match_pending(seeded_db, config) == 0
    assert len(transfers.unmatched(seeded_db)) == 2


@requires_db
def test_closest_date_is_preferred(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    far = _card(seeded_db, config, transaction_date=CHECKING_DATE + timedelta(days=5))
    near = _card(seeded_db, config, transaction_date=CHECKING_DATE + timedelta(days=2))
    farthest = _card(seeded_db, config, transaction_date=CHECKING_DATE + timedelta(days=7))

    assert transfers.find_match(seeded_db, checking, config).id == near.id
    assert transfers.match_pending(seeded_db, config) == 1
    assert near.match_status == "matched"
    assert far.match_status == "unmatched"
    assert farthest.match_status == "unmatched"


@requires_db
def test_match_pending_visits_oldest_entry_first(seeded_db: Session, config: AppConfig) -> None:
    """The greedy pass is oldest-first: the earliest entry claims its best counterpart."""
    checking = _checking(seeded_db, config)
    near = _card(seeded_db, config, transaction_date=CHECKING_DATE + timedelta(days=2))
    earlier_card = _card(seeded_db, config, transaction_date=CHECKING_DATE - timedelta(days=6))

    assert transfers.match_pending(seeded_db, config) == 1
    assert earlier_card.match_status == "matched"
    assert checking.transaction.linked_transfer_id == earlier_card.transaction.id
    assert near.match_status == "unmatched"


@requires_db
def test_date_tie_prefers_earlier_date(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    after = _card(seeded_db, config, transaction_date=CHECKING_DATE + timedelta(days=2))
    before = _card(seeded_db, config, transaction_date=CHECKING_DATE - timedelta(days=2))
    assert transfers.find_match(seeded_db, checking, config).id == before.id
    assert after.match_status == "unmatched"


@requires_db
def test_matched_and_ignored_entries_are_not_candidates(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    card = _card(seeded_db, config)
    transfers.ignore(seeded_db, card.id)
    assert transfers.find_match(seeded_db, checking, config) is None
    assert transfers.find_match(seeded_db, card, config) is None  # a resolved entry never matches
    assert transfers.match_pending(seeded_db, config) == 0


@requires_db
def test_already_linked_transaction_is_not_a_candidate(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    card = _card(seeded_db, config)
    # simulate a link made elsewhere without touching the buffer row
    other = make_transaction(seeded_db, config, account_id=OTHER_CARD, amount=AMOUNT, transaction_date=CARD_DATE)
    card.transaction.linked_transfer_id = other.id
    seeded_db.flush()
    assert transfers.find_match(seeded_db, checking, config) is None


@requires_db
def test_match_pending_counts_pairs_and_leaves_orphans(seeded_db: Session, config: AppConfig) -> None:
    _checking(seeded_db, config)
    _card(seeded_db, config)
    _checking(seeded_db, config, amount="-250.00", transaction_date=date(2026, 8, 3))
    _register(
        seeded_db,
        config,
        account_id=OTHER_CARD,
        amount="250.00",
        transaction_date=date(2026, 8, 5),
        raw_description="PAYMENT RECEIVED - THANK YOU",
    )
    orphan = _checking(seeded_db, config, amount="-99.99", transaction_date=date(2026, 8, 10))

    assert transfers.match_pending(seeded_db, config) == 2
    remaining = transfers.unmatched(seeded_db)
    assert [e.id for e in remaining] == [orphan.id]
    assert transfers.match_pending(seeded_db, config) == 0


@requires_db
def test_one_debit_does_not_link_two_credits(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    _card(seeded_db, config, transaction_date=CHECKING_DATE + timedelta(days=1))
    _register(
        seeded_db,
        config,
        account_id=OTHER_CARD,
        amount=AMOUNT,
        transaction_date=CHECKING_DATE + timedelta(days=1),
        raw_description="PAYMENT RECEIVED - THANK YOU",
    )
    assert transfers.match_pending(seeded_db, config) == 1
    assert checking.match_status == "matched"
    assert len(transfers.unmatched(seeded_db)) == 1


@requires_db
def test_unmatched_entry_survives_until_later_upload(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    assert transfers.match_pending(seeded_db, config) == 0
    assert [e.id for e in transfers.unmatched(seeded_db)] == [checking.id]

    # the card statement arrives later
    card = _card(seeded_db, config)
    assert transfers.match_pending(seeded_db, config) == 1
    assert transfers.unmatched(seeded_db) == []
    assert checking.transaction.linked_transfer_id == card.transaction.id
    assert card.transaction.linked_transfer_id == checking.transaction.id


@requires_db
def test_unmatched_is_ordered_oldest_first(seeded_db: Session, config: AppConfig) -> None:
    newest = _checking(seeded_db, config, amount="-3.00", transaction_date=date(2026, 8, 20))
    oldest = _checking(seeded_db, config, amount="-1.00", transaction_date=date(2026, 6, 1))
    middle = _checking(seeded_db, config, amount="-2.00", transaction_date=date(2026, 7, 15))
    assert [e.id for e in transfers.unmatched(seeded_db)] == [oldest.id, middle.id, newest.id]


# --------------------------------------------------------------------------- #
# ignore
# --------------------------------------------------------------------------- #


@requires_db
def test_ignore_marks_entry_resolved(seeded_db: Session, config: AppConfig) -> None:
    entry = _checking(seeded_db, config)
    result = transfers.ignore(seeded_db, entry.id)
    assert result.id == entry.id
    assert entry.match_status == "ignored"
    assert entry.resolved_at is not None and entry.resolved_at.tzinfo is not None
    assert entry.transaction.is_internal_transfer is True
    assert entry.transaction.linked_transfer_id is None
    assert transfers.unmatched(seeded_db) == []
    # idempotent
    first_resolved = entry.resolved_at
    transfers.ignore(seeded_db, entry.id)
    assert entry.resolved_at == first_resolved


@requires_db
def test_ignore_unknown_id_raises_key_error(seeded_db: Session) -> None:
    with pytest.raises(KeyError):
        transfers.ignore(seeded_db, uuid.uuid4())


@requires_db
def test_ignore_matched_entry_raises_value_error(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    _card(seeded_db, config)
    transfers.match_pending(seeded_db, config)
    with pytest.raises(ValueError):
        transfers.ignore(seeded_db, checking.id)


# --------------------------------------------------------------------------- #
# manual_link
# --------------------------------------------------------------------------- #


@requires_db
def test_manual_link_bypasses_heuristics(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    # outside the window and the tolerance: only a human can pair these
    card = _card(seeded_db, config, amount="3380.00", transaction_date=CHECKING_DATE + timedelta(days=20))
    assert transfers.find_match(seeded_db, checking, config) is None

    a, b = transfers.manual_link(seeded_db, checking.id, card.id)
    assert {a.id, b.id} == {checking.id, card.id}
    assert checking.match_status == card.match_status == "matched"
    assert checking.resolved_at == card.resolved_at
    assert checking.transaction.linked_transfer_id == card.transaction.id
    assert card.transaction.linked_transfer_id == checking.transaction.id
    assert transfers.unmatched(seeded_db) == []


@requires_db
def test_manual_link_unknown_id_raises_key_error(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    with pytest.raises(KeyError):
        transfers.manual_link(seeded_db, checking.id, uuid.uuid4())
    with pytest.raises(KeyError):
        transfers.manual_link(seeded_db, uuid.uuid4(), checking.id)
    assert checking.match_status == "unmatched"


@requires_db
def test_manual_link_rejects_self(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    with pytest.raises(ValueError):
        transfers.manual_link(seeded_db, checking.id, checking.id)


@requires_db
def test_manual_link_rejects_same_account(seeded_db: Session, config: AppConfig) -> None:
    a = _checking(seeded_db, config)
    b = _checking(seeded_db, config, amount=AMOUNT, transaction_date=CARD_DATE, raw_description="REFUND")
    with pytest.raises(ValueError):
        transfers.manual_link(seeded_db, a.id, b.id)
    assert a.match_status == b.match_status == "unmatched"


@requires_db
def test_manual_link_rejects_resolved_entries(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    card = _card(seeded_db, config)
    transfers.match_pending(seeded_db, config)
    later = _card(seeded_db, config, transaction_date=date(2026, 8, 20))
    with pytest.raises(ValueError):
        transfers.manual_link(seeded_db, checking.id, later.id)  # checking already matched

    ignored = _checking(seeded_db, config, transaction_date=date(2026, 8, 18))
    transfers.ignore(seeded_db, ignored.id)
    with pytest.raises(ValueError):
        transfers.manual_link(seeded_db, ignored.id, later.id)  # ignored is not unmatched
    assert later.match_status == "unmatched"
    assert card.match_status == "matched"


# --------------------------------------------------------------------------- #
# link (low level)
# --------------------------------------------------------------------------- #


@requires_db
def test_link_rejects_self(seeded_db: Session, config: AppConfig) -> None:
    checking = _checking(seeded_db, config)
    with pytest.raises(ValueError):
        transfers.link(seeded_db, checking, checking)
