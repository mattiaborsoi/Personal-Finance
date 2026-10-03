"""Settings -> Household / Categories / Rules: what used to be edited in ``config.yaml``.

Every mutation commits and answers with the fresh document, and the effective
configuration is rebuilt per request, so a change takes effect on the next call.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.config import AppConfig
from app.database import get_db
from app.deps import get_config, get_effective_config
from app.services import rule_apply, rule_suggestions, site_settings
from app.services.site_settings import (
    CategoriesOut,
    CategoriesUpdate,
    CategoryRename,
    HouseholdOut,
    HouseholdUpdate,
    RulesOut,
    RulesUpdate,
    RuleTest,
    RuleTestOut,
)

router = APIRouter(prefix="/settings", tags=["settings"], dependencies=[Depends(require_primary)])


def _http(exc: ValueError) -> HTTPException:
    if isinstance(exc, site_settings.SiteSettingsNotFound):
        return HTTPException(status.HTTP_404_NOT_FOUND, str(exc))
    if isinstance(exc, site_settings.SiteSettingsConflict):
        return HTTPException(status.HTTP_409_CONFLICT, str(exc))
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))


# ----- household ----------------------------------------------------------- #


def _household(db: Session, base: AppConfig) -> HouseholdOut:
    household, stored = site_settings.load_household(db, base)
    return site_settings.household_out(base, household, stored)


@router.get("/household", response_model=HouseholdOut)
def get_household(db: Session = Depends(get_db), base: AppConfig = Depends(get_config)) -> HouseholdOut:
    return _household(db, base)


@router.put("/household", response_model=HouseholdOut)
def update_household(
    body: HouseholdUpdate,
    db: Session = Depends(get_db),
    base: AppConfig = Depends(get_config),
    effective: AppConfig = Depends(get_effective_config),
) -> HouseholdOut:
    try:
        site_settings.update_household(db, base, effective, body)
    except site_settings.SiteSettingsError as exc:
        raise _http(exc) from exc
    db.commit()
    return _household(db, base)


# ----- categories ---------------------------------------------------------- #


def _categories(db: Session, base: AppConfig) -> CategoriesOut:
    categories, stored = site_settings.load_categories(db, base)
    rules, _ = site_settings.load_rules(db, base)
    usage = site_settings.category_usage(db, rules)
    return site_settings.categories_out(categories, stored, usage, base.category_emojis)


@router.get("/categories", response_model=CategoriesOut)
def get_categories(db: Session = Depends(get_db), base: AppConfig = Depends(get_config)) -> CategoriesOut:
    return _categories(db, base)


@router.put("/categories", response_model=CategoriesOut)
def update_categories(
    body: CategoriesUpdate,
    db: Session = Depends(get_db),
    base: AppConfig = Depends(get_config),
    effective: AppConfig = Depends(get_effective_config),
) -> CategoriesOut:
    try:
        site_settings.update_categories(db, base, effective, body)
    except (site_settings.SiteSettingsError, site_settings.SiteSettingsConflict) as exc:
        raise _http(exc) from exc
    db.commit()
    return _categories(db, base)


@router.post("/categories/rename", response_model=CategoriesOut)
def rename_category(
    body: CategoryRename,
    db: Session = Depends(get_db),
    base: AppConfig = Depends(get_config),
    effective: AppConfig = Depends(get_effective_config),
) -> CategoriesOut:
    """Rename a category in the taxonomy, every transaction, the merchant memory and the rules at once."""
    try:
        site_settings.rename_category(db, base, effective, body)
    except (
        site_settings.SiteSettingsError,
        site_settings.SiteSettingsConflict,
        site_settings.SiteSettingsNotFound,
    ) as exc:
        raise _http(exc) from exc
    db.commit()
    return _categories(db, base)


# ----- rules --------------------------------------------------------------- #


def _rules(db: Session, base: AppConfig) -> RulesOut:
    rules, stored = site_settings.load_rules(db, base)
    return site_settings.rules_out(rules, stored)


@router.get("/rules", response_model=RulesOut)
def get_rules(db: Session = Depends(get_db), base: AppConfig = Depends(get_config)) -> RulesOut:
    return _rules(db, base)


@router.put("/rules", response_model=RulesOut)
def update_rules(
    body: RulesUpdate,
    db: Session = Depends(get_db),
    base: AppConfig = Depends(get_config),
    effective: AppConfig = Depends(get_effective_config),
) -> RulesOut:
    try:
        site_settings.update_rules(db, base, effective, body)
    except site_settings.SiteSettingsError as exc:
        raise _http(exc) from exc
    db.commit()
    return _rules(db, base)


@router.post("/rules/test", response_model=RuleTestOut)
def test_rules(
    body: RuleTest,
    db: Session = Depends(get_db),
    base: AppConfig = Depends(get_config),
    effective: AppConfig = Depends(get_effective_config),
) -> RuleTestOut:
    """Which rule a description hits and whether it looks like a card payment; unsaved edits welcome."""
    try:
        return site_settings.try_rules(db, base, effective, body)
    except site_settings.SiteSettingsError as exc:
        raise _http(exc) from exc


class ApplyRulesRequest(BaseModel):
    """Re-run the rules on waiting lines of one month (``YYYY-MM``) or, with ``null``, every open month."""

    dry_run: bool = False
    period: str | None = Field(default=None, pattern=r"^\d{4}-(0[1-9]|1[0-2])$")


class FiledAs(BaseModel):
    category: str
    claim_type: str


class ApplyRulesItem(BaseModel):
    id: uuid.UUID
    cleaned_merchant: str
    amount: Decimal
    before: FiledAs
    after: FiledAs
    changed: bool
    rule_index: int


class ApplyRulesOut(BaseModel):
    matched: int
    changed: int
    approved: int
    unchanged: int
    items: list[ApplyRulesItem]


@router.post("/rules/apply", response_model=ApplyRulesOut)
def apply_rules(
    body: ApplyRulesRequest,
    db: Session = Depends(get_db),
    effective: AppConfig = Depends(get_effective_config),
) -> ApplyRulesOut:
    """File waiting lines as the saved rules say and approve them (see ``app.services.rule_apply``).

    ``dry_run`` decides without writing anything. Approved lines, split lines and
    closed months are never touched. ``items`` lists at most 200 lines, those that
    change first.
    """
    outcome = rule_apply.plan(db, effective, rule_apply.waiting_lines(db, body.period))
    shown = outcome.plans[: rule_apply.MAX_ITEMS]
    before = {item.txn.id: FiledAs(category=item.txn.category, claim_type=item.txn.claim_type) for item in shown}
    if not body.dry_run:
        for item in outcome.plans:
            rule_apply.apply(db, effective, item)
        db.commit()
    return ApplyRulesOut(
        matched=outcome.matched,
        changed=outcome.changed,
        approved=outcome.approved,
        unchanged=outcome.unchanged,
        items=[
            ApplyRulesItem(
                id=item.txn.id,
                cleaned_merchant=item.txn.cleaned_merchant,
                amount=item.txn.amount,
                before=before[item.txn.id],
                after=FiledAs(category=item.category, claim_type=item.claim_type),
                changed=item.changed,
                rule_index=item.rule_index,
            )
            for item in shown
        ],
    )


# ----- rule suggestions (no AI) ------------------------------------------- #


class SuggestionOut(BaseModel):
    key: str
    kind: str
    text: str
    merchant: str
    category: str
    claim_type: str
    count: int
    amount: Decimal | None
    rule: dict
    rule_index: int | None
    action: str
    examples: list[str]


class SuggestionsOut(BaseModel):
    suggestions: list[SuggestionOut]


class DismissRequest(BaseModel):
    key: str = Field(min_length=1, max_length=200)


@router.get("/rules/suggestions", response_model=SuggestionsOut)
def get_rule_suggestions(
    db: Session = Depends(get_db), effective: AppConfig = Depends(get_effective_config)
) -> SuggestionsOut:
    """Rules the approvals suggest (see ``app.services.rule_suggestions``); nothing is changed by reading them."""
    items = [
        SuggestionOut(
            key=s.key,
            kind=s.kind,
            text=rule_suggestions.describe(effective, s),
            merchant=s.merchant,
            category=s.category,
            claim_type=s.claim_type,
            count=s.count,
            amount=s.amount,
            rule=s.rule,
            rule_index=s.rule_index,
            action=s.action,
            examples=s.examples,
        )
        for s in rule_suggestions.suggest(db, effective)
    ]
    return SuggestionsOut(suggestions=items)


@router.post("/rules/suggestions/dismiss", status_code=status.HTTP_204_NO_CONTENT)
def dismiss_rule_suggestion(body: DismissRequest, db: Session = Depends(get_db)) -> Response:
    """Remember that the owner does not want this suggestion; it is not shown again."""
    rule_suggestions.dismiss(db, body.key)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
