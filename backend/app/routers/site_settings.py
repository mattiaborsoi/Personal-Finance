"""Settings -> Household / Categories / Rules: what used to be edited in ``config.yaml``.

Every mutation commits and answers with the fresh document, and the effective
configuration is rebuilt per request, so a change takes effect on the next call.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import require_primary
from app.config import AppConfig
from app.database import get_db
from app.deps import get_config, get_effective_config
from app.services import site_settings
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
