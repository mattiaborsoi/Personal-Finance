"""Household, categories and rules edited in the app (Settings -> Household / Categories / Rules).

Everything a user once had to edit in ``config.yaml``, apart from the accounts
(which have their own table), lives in three documents of the ``app_settings``
table:

* ``household``: the two people's display names and incomes, how shared costs are
  split, the rounding, the settlement day and the currency;
* ``categories``: the taxonomy offered to the classifier and the review queue, in
  the order the menus show it, and the emoji chosen for each category group (the
  part of a name before the first ``:``) where it differs from the built-in default;
* ``rules``: the deterministic rules tried before any AI call, the card-payment
  patterns that feed the transfer buffer, and the matching window and tolerance.

``config.yaml`` supplies the defaults (the built-in ones when the file is absent);
a saved document overrides them. :func:`apply_all` overlays the three documents on
an :class:`~app.config.AppConfig` and is what :func:`app.deps.get_effective_config`
calls on every request, so a change takes effect on the next request without a
restart.

Every ``load`` deep-merges the stored document over the defaults, so a field added
in a later version picks up its default, and a corrupt document is ignored with a
warning rather than taking the app down. Every ``update`` validates the proposed
document twice: once with the messages below, and once more by re-running the
whole :class:`~app.config.AppConfig` validation on the overlaid configuration
(``model_copy`` skips it), so nothing the file would refuse can be saved either.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from collections.abc import Callable
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.config import (
    CLAIM_TYPES,
    UNCATEGORIZED,
    AppConfig,
    ConfigError,
    DeterministicRule,
    SettlementSection,
    TransfersSection,
    UserConfig,
    UsersSection,
    category_group,
)
from app.models import AppSetting, MerchantMemory, Transaction

log = logging.getLogger(__name__)

HOUSEHOLD_KEY = "household"
CATEGORIES_KEY = "categories"
RULES_KEY = "rules"

SPLIT_STRATEGIES: tuple[str, ...] = ("salary_proportional", "equal_50_50")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")

MAX_DISPLAY_NAME = 64
MAX_CATEGORY_LENGTH = 128  # transactions.category is VARCHAR(128)
MAX_MERCHANT_LENGTH = 255  # transactions.cleaned_merchant is VARCHAR(255)
MAX_SUBCATEGORY_LENGTH = 128
MAX_PATTERN_LENGTH = 512
MAX_EMOJI_LENGTH = 8


class SiteSettingsError(ValueError):
    """Invalid values (HTTP 422)."""


class SiteSettingsConflict(ValueError):
    """The change clashes with existing data (HTTP 409)."""


class SiteSettingsNotFound(ValueError):
    """The named item does not exist (HTTP 404)."""


# --------------------------------------------------------------------------- #
# Documents (what is stored)
# --------------------------------------------------------------------------- #


class HouseholdUser(BaseModel):
    display_name: str
    base_salary_pa: Decimal = Decimal("0")
    additional_income_pa: Decimal = Decimal("0")

    @field_validator("display_name")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @property
    def total_income_pa(self) -> Decimal:
        return self.base_salary_pa + self.additional_income_pa


class HouseholdUsers(BaseModel):
    primary: HouseholdUser
    secondary: HouseholdUser


class Household(BaseModel):
    """User ids are deliberately absent: they come from ``config.yaml`` (or the
    built-in defaults) and never change, since every row in the database names them."""

    users: HouseholdUsers
    split_strategy: str
    rounding_decimals: int
    settlement_day_of_month: int
    base_currency: str
    currency_symbol: str

    @field_validator("base_currency")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.strip().upper()

    @field_validator("currency_symbol")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


class Categories(BaseModel):
    categories: list[str]
    emojis: dict[str, str] = Field(default_factory=dict)
    """Group -> emoji saved in the app, over :attr:`AppConfig.category_emojis`; ``""``
    means "no emoji" and hides a default. Only groups in ``categories`` are kept."""


class Rule(BaseModel):
    pattern: str
    category: str
    claim_type: str = "personal"
    merchant: str | None = None
    subcategory: str | None = None
    is_internal_transfer: bool = False
    transfer_to_account: str | None = None


class Rules(BaseModel):
    rules: list[Rule]
    payment_patterns: list[str]
    match_window_days: int
    amount_tolerance: Decimal


# --------------------------------------------------------------------------- #
# Request bodies
# --------------------------------------------------------------------------- #


class HouseholdUserUpdate(BaseModel):
    display_name: str | None = None
    base_salary_pa: Decimal | None = None
    additional_income_pa: Decimal | None = None


class HouseholdUsersUpdate(BaseModel):
    primary: HouseholdUserUpdate | None = None
    secondary: HouseholdUserUpdate | None = None


class HouseholdUpdate(BaseModel):
    """``PUT /settings/household``: any subset of the fields, nested partials included."""

    users: HouseholdUsersUpdate | None = None
    split_strategy: str | None = None
    rounding_decimals: int | None = None
    settlement_day_of_month: int | None = None
    base_currency: str | None = None
    currency_symbol: str | None = None


class CategoriesUpdate(BaseModel):
    """``PUT /settings/categories``: the whole list, in the order the menus should show it,
    and/or the group emojis. A field left out keeps its saved value; ``emojis`` given
    replaces the saved map entirely (``{}``: the defaults apply again)."""

    categories: list[str] | None = None
    emojis: dict[str, str] | None = None


class CategoryRename(BaseModel):
    """``POST /settings/categories/rename``."""

    model_config = ConfigDict(populate_by_name=True)

    from_: str = Field(alias="from")
    to: str


class RuleIn(BaseModel):
    pattern: str
    category: str
    claim_type: str = "personal"
    merchant: str | None = None
    subcategory: str | None = None
    is_internal_transfer: bool = False
    transfer_to_account: str | None = None


class RulesUpdate(BaseModel):
    """``PUT /settings/rules``: any subset; a list given replaces the stored one entirely."""

    rules: list[RuleIn] | None = None
    payment_patterns: list[str] | None = None
    match_window_days: int | None = None
    amount_tolerance: Decimal | None = None


class RuleTest(BaseModel):
    """``POST /settings/rules/test``: ``rules`` / ``payment_patterns`` given are tried instead of the saved ones."""

    description: str
    rules: list[RuleIn] | None = None
    payment_patterns: list[str] | None = None


# --------------------------------------------------------------------------- #
# Responses
# --------------------------------------------------------------------------- #


class HouseholdUserOut(BaseModel):
    id: str
    display_name: str
    base_salary_pa: Decimal
    additional_income_pa: Decimal


class HouseholdUsersOut(BaseModel):
    primary: HouseholdUserOut
    secondary: HouseholdUserOut


class HouseholdOut(BaseModel):
    users: HouseholdUsersOut
    split_strategy: str
    rounding_decimals: int
    settlement_day_of_month: int
    base_currency: str
    currency_symbol: str
    primary_ratio: float
    secondary_ratio: float
    stored: bool


class CategoryUsage(BaseModel):
    transactions: int = 0
    memory: int = 0
    rules: int = 0

    @property
    def total(self) -> int:
        return self.transactions + self.memory + self.rules


class CategoryOut(BaseModel):
    name: str
    in_use: CategoryUsage


class CategoriesOut(BaseModel):
    categories: list[CategoryOut]
    emojis: dict[str, str]
    """The effective group -> emoji map (saved values over the defaults) for the groups
    in the list; ``""`` marks a group whose default emoji was removed."""
    default_emojis: dict[str, str] = Field(default_factory=dict)
    """The built-in (or ``config.yaml``) emoji of each group in the list that has one,
    so the editor can show it and send only real overrides."""
    stored: bool


class RulesOut(BaseModel):
    rules: list[Rule]
    payment_patterns: list[str]
    match_window_days: int
    amount_tolerance: Decimal
    stored: bool


class RuleTestOut(BaseModel):
    rule_index: int | None
    """Zero-based position in the tried list of the first matching rule, or ``null``."""
    rule: Rule | None
    is_payment: bool


# --------------------------------------------------------------------------- #
# Defaults
# --------------------------------------------------------------------------- #


def _household_user(user: UserConfig) -> HouseholdUser:
    return HouseholdUser(
        display_name=user.display_name,
        base_salary_pa=user.base_salary_pa,
        additional_income_pa=user.additional_income_pa,
    )


def household_defaults(config: AppConfig) -> Household:
    return Household(
        users=HouseholdUsers(
            primary=_household_user(config.users.primary), secondary=_household_user(config.users.secondary)
        ),
        split_strategy=config.settlement.split_strategy,
        rounding_decimals=config.settlement.rounding_decimals,
        settlement_day_of_month=config.settlement.settlement_day_of_month,
        base_currency=config.app.base_currency,
        currency_symbol=config.app.currency_symbol,
    )


def categories_defaults(config: AppConfig) -> Categories:
    return Categories(categories=list(config.categories))


def rules_defaults(config: AppConfig) -> Rules:
    return Rules(
        rules=[Rule.model_validate(rule.model_dump()) for rule in config.deterministic_rules],
        payment_patterns=list(config.transfers.payment_patterns),
        match_window_days=config.transfers.match_window_days,
        amount_tolerance=config.transfers.amount_tolerance,
    )


# --------------------------------------------------------------------------- #
# Validation (the messages the API returns)
# --------------------------------------------------------------------------- #


def check_household(household: Household) -> Household:
    """Raise :class:`SiteSettingsError` unless every value is usable; returns the document."""
    for user in (household.users.primary, household.users.secondary):
        if not user.display_name:
            raise SiteSettingsError("display_name must not be empty")
        if len(user.display_name) > MAX_DISPLAY_NAME:
            raise SiteSettingsError(f"display_name must be at most {MAX_DISPLAY_NAME} characters")
        if user.base_salary_pa < 0 or user.additional_income_pa < 0:
            raise SiteSettingsError("incomes cannot be negative")
    if household.split_strategy not in SPLIT_STRATEGIES:
        raise SiteSettingsError("split_strategy must be salary_proportional or equal_50_50")
    if household.split_strategy == "salary_proportional":
        if household.users.primary.total_income_pa + household.users.secondary.total_income_pa <= 0:
            raise SiteSettingsError("salary_proportional needs a positive combined income")
    if not 0 <= household.rounding_decimals <= 6:
        raise SiteSettingsError("rounding_decimals must be between 0 and 6")
    if not 1 <= household.settlement_day_of_month <= 28:
        raise SiteSettingsError("settlement_day_of_month must be between 1 and 28")
    if not CURRENCY_RE.match(household.base_currency):
        raise SiteSettingsError("base_currency must be a three-letter code")
    if not 1 <= len(household.currency_symbol) <= 3:
        raise SiteSettingsError("currency_symbol must be 1 to 3 characters")
    return household


def normalise_categories(names: list[str]) -> Categories:
    """Trimmed, non-empty, unique ignoring case, ``Uncategorized`` always present, order kept."""
    out: list[str] = []
    seen: set[str] = set()
    for position, raw in enumerate(names, 1):
        name = (raw or "").strip()
        if not name:
            raise SiteSettingsError(f"category {position} must not be empty")
        if len(name) > MAX_CATEGORY_LENGTH:
            raise SiteSettingsError(f"category {position} is longer than {MAX_CATEGORY_LENGTH} characters")
        if name.lower() == UNCATEGORIZED.lower():
            name = UNCATEGORIZED
        if name.lower() in seen:
            raise SiteSettingsError(f"category {name!r} is listed twice")
        seen.add(name.lower())
        out.append(name)
    if UNCATEGORIZED.lower() not in seen:
        out.append(UNCATEGORIZED)
    return Categories(categories=out)


def _clean(value: str | None, max_len: int, what: str, where: str) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    if len(text) > max_len:
        raise SiteSettingsError(f"{where}: {what} is longer than {max_len} characters")
    return text


def _compile(pattern: str, where: str) -> None:
    if not pattern.strip():
        raise SiteSettingsError(f"{where}: pattern must not be empty")
    if len(pattern) > MAX_PATTERN_LENGTH:
        raise SiteSettingsError(f"{where}: pattern is longer than {MAX_PATTERN_LENGTH} characters")
    try:
        re.compile(pattern)
    except re.error as exc:
        raise SiteSettingsError(f"{where}: invalid regex {pattern!r}: {exc}") from exc


def validate_rules(doc: Rules, config: AppConfig | None = None) -> Rules:
    """A normalised copy of ``doc``, or :class:`SiteSettingsError` naming the offending item.

    Patterns must compile, claim types must be known and the numbers must be in
    range. With ``config`` (the effective configuration) every rule's category must
    also be in the taxonomy (it is stored in the configured spelling) and its
    ``transfer_to_account`` must be an account, archived ones included. Without it
    (loading a stored document) the references are left alone: an account or a
    category may legitimately have gone since the document was saved.
    """
    rules: list[Rule] = []
    for position, rule in enumerate(doc.rules, 1):
        where = f"rule {position}"
        _compile(rule.pattern, where)
        category = (rule.category or "").strip()
        if not category:
            raise SiteSettingsError(f"{where}: category must not be empty")
        if rule.claim_type not in CLAIM_TYPES:
            raise SiteSettingsError(f"{where}: unknown claim_type")
        transfer_to = _clean(rule.transfer_to_account, 64, "transfer_to_account", where)
        if config is not None:
            canonical = config.canonical_category(category)
            if canonical is None:
                raise SiteSettingsError(f"{where}: category {category!r} is not in the configured taxonomy")
            category = canonical
            if transfer_to and config.get_account(transfer_to) is None:
                raise SiteSettingsError(f"{where}: transfer_to_account {transfer_to!r} is not an account")
        rules.append(
            Rule(
                pattern=rule.pattern,
                category=category,
                claim_type=rule.claim_type,
                merchant=_clean(rule.merchant, MAX_MERCHANT_LENGTH, "merchant", where),
                subcategory=_clean(rule.subcategory, MAX_SUBCATEGORY_LENGTH, "subcategory", where),
                is_internal_transfer=bool(rule.is_internal_transfer),
                transfer_to_account=transfer_to,
            )
        )
    for position, pattern in enumerate(doc.payment_patterns, 1):
        _compile(pattern, f"payment pattern {position}")
    if not 0 <= doc.match_window_days <= 60:
        raise SiteSettingsError("match_window_days must be between 0 and 60")
    if not 0 <= doc.amount_tolerance <= 10:
        raise SiteSettingsError("amount_tolerance must be between 0 and 10")
    return Rules(
        rules=rules,
        payment_patterns=list(doc.payment_patterns),
        match_window_days=doc.match_window_days,
        amount_tolerance=doc.amount_tolerance,
    )


def _describe(exc: ValidationError) -> str:
    """One line naming the field, for a pydantic error on the overlaid configuration."""
    errors = exc.errors()
    if not errors:
        return str(exc)
    first = errors[0]
    message = str(first.get("msg", "")).removeprefix("Value error, ")
    location = ".".join(str(part) for part in first.get("loc", ()))
    return f"{location}: {message}" if location else message


def validate_full(config: AppConfig) -> AppConfig:
    """Re-run :class:`AppConfig`'s own validation on an overlaid configuration.

    ``model_copy(update=...)`` never runs validators, so this is the safety net
    that keeps anything ``config.yaml`` would refuse from being saved in the app.
    """
    try:
        return AppConfig.model_validate(config.model_dump())
    except ConfigError as exc:
        raise SiteSettingsError(str(exc)) from exc
    except ValidationError as exc:
        raise SiteSettingsError(_describe(exc)) from exc


# --------------------------------------------------------------------------- #
# Load, save, apply
# --------------------------------------------------------------------------- #


def _merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        elif value is not None:
            out[key] = value
    return out


def _load(db: Session, key: str, base: BaseModel, check: Callable[[Any], Any]) -> tuple[Any, bool]:
    """``(document, stored)``: the stored document merged over ``base`` and checked, or ``base``."""
    row = db.get(AppSetting, key)
    if row is None or not row.value:
        return base, False
    try:
        doc = type(base).model_validate(_merge(base.model_dump(mode="json"), row.value))
        return check(doc), True
    except Exception as exc:  # noqa: BLE001 - a corrupt document must not take the app down
        log.warning("ignoring invalid %s settings document: %s", key, exc)
        return base, False


def _save(db: Session, key: str, doc: BaseModel) -> None:
    value = doc.model_dump(mode="json")
    row = db.get(AppSetting, key)
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value
    db.flush()


def load_household(db: Session, config: AppConfig) -> tuple[Household, bool]:
    return _load(db, HOUSEHOLD_KEY, household_defaults(config), check_household)


def save_household(db: Session, household: Household) -> None:
    _save(db, HOUSEHOLD_KEY, household)


def apply_household(config: AppConfig, household: Household) -> AppConfig:
    """``config`` with the household overlaid; the user ids are ``config``'s own."""

    def user(base: UserConfig, doc: HouseholdUser) -> UserConfig:
        return UserConfig(
            id=base.id,
            display_name=doc.display_name,
            base_salary_pa=doc.base_salary_pa,
            additional_income_pa=doc.additional_income_pa,
        )

    users = UsersSection(
        primary=user(config.users.primary, household.users.primary),
        secondary=user(config.users.secondary, household.users.secondary),
    )
    settlement = SettlementSection(
        split_strategy=household.split_strategy,
        rounding_decimals=household.rounding_decimals,
        settlement_day_of_month=household.settlement_day_of_month,
    )
    app = config.app.model_copy(
        update={"base_currency": household.base_currency, "currency_symbol": household.currency_symbol}
    )
    return config.model_copy(update={"users": users, "settlement": settlement, "app": app})


def _check_stored_categories(doc: Categories) -> Categories:
    """A stored document, normalised; emojis for groups no longer listed (or no longer
    valid) are dropped rather than failing the whole document."""
    names = normalise_categories(doc.categories).categories
    groups = _groups(names)
    emojis = {group: emoji for group, emoji in doc.emojis.items() if group in groups and _valid_emoji(emoji)}
    return Categories(categories=names, emojis=emojis)


def load_categories(db: Session, config: AppConfig) -> tuple[Categories, bool]:
    return _load(db, CATEGORIES_KEY, categories_defaults(config), _check_stored_categories)


def save_categories(db: Session, categories: Categories) -> None:
    _save(db, CATEGORIES_KEY, categories)


def apply_categories(config: AppConfig, categories: Categories) -> AppConfig:
    names = list(categories.categories)
    if UNCATEGORIZED not in names:
        names.append(UNCATEGORIZED)
    emojis = effective_emojis(Categories(categories=names, emojis=categories.emojis), config.category_emojis)
    return config.model_copy(update={"categories": names, "category_emojis": emojis})


def load_rules(db: Session, config: AppConfig) -> tuple[Rules, bool]:
    return _load(db, RULES_KEY, rules_defaults(config), validate_rules)


def save_rules(db: Session, rules: Rules) -> None:
    _save(db, RULES_KEY, rules)


def apply_rules(config: AppConfig, rules: Rules) -> AppConfig:
    deterministic = [DeterministicRule.model_validate(rule.model_dump()) for rule in rules.rules]
    transfers = TransfersSection(
        payment_patterns=list(rules.payment_patterns),
        match_window_days=rules.match_window_days,
        amount_tolerance=rules.amount_tolerance,
    )
    return config.model_copy(update={"deterministic_rules": deterministic, "transfers": transfers})


def apply_all(db: Session, config: AppConfig) -> AppConfig:
    """``config`` with the three stored documents overlaid (household, categories, rules)."""
    household, _ = load_household(db, config)
    categories, _ = load_categories(db, config)
    rules, _ = load_rules(db, config)
    return apply_rules(apply_categories(apply_household(config, household), categories), rules)


# --------------------------------------------------------------------------- #
# Household
# --------------------------------------------------------------------------- #


def household_out(config: AppConfig, household: Household, stored: bool) -> HouseholdOut:
    applied = apply_household(config, household)

    def user(role: str) -> HouseholdUserOut:
        base: UserConfig = getattr(config.users, role)
        doc: HouseholdUser = getattr(household.users, role)
        return HouseholdUserOut(
            id=base.id,
            display_name=doc.display_name,
            base_salary_pa=doc.base_salary_pa,
            additional_income_pa=doc.additional_income_pa,
        )

    return HouseholdOut(
        users=HouseholdUsersOut(primary=user("primary"), secondary=user("secondary")),
        split_strategy=household.split_strategy,
        rounding_decimals=household.rounding_decimals,
        settlement_day_of_month=household.settlement_day_of_month,
        base_currency=household.base_currency,
        currency_symbol=household.currency_symbol,
        primary_ratio=float(applied.primary_ratio),
        secondary_ratio=float(applied.secondary_ratio),
        stored=stored,
    )


def merged_household(current: Household, body: HouseholdUpdate) -> Household:
    """``current`` with the fields present in ``body`` replaced, checked."""
    data = _merge(current.model_dump(), body.model_dump(exclude_unset=True))
    if data.get("split_strategy") not in SPLIT_STRATEGIES:
        raise SiteSettingsError("split_strategy must be salary_proportional or equal_50_50")
    return check_household(Household.model_validate(data))


def update_household(db: Session, base: AppConfig, effective: AppConfig, body: HouseholdUpdate) -> Household:
    """Validate and persist a household update (flushed, not committed)."""
    current, _ = load_household(db, base)
    proposed = merged_household(current, body)
    validate_full(apply_household(effective, proposed))
    save_household(db, proposed)
    return proposed


# --------------------------------------------------------------------------- #
# Categories
# --------------------------------------------------------------------------- #


def _counts_by_category(db: Session, model: type[Transaction] | type[MerchantMemory]) -> list[tuple[str, int]]:
    """``(lower-cased category, rows)`` pairs for every category the table uses."""
    column = func.lower(model.category)
    return [(name, int(count)) for name, count in db.execute(select(column, func.count()).group_by(column)) if name]


def category_usage(db: Session, rules: Rules) -> dict[str, CategoryUsage]:
    """How many transactions (split parts included), remembered merchants and rules
    use each category, keyed by the lower-cased name. Matching ignores case so rows
    written under an older spelling are still counted."""
    usage: dict[str, CategoryUsage] = {}

    def entry(name: str) -> CategoryUsage:
        return usage.setdefault(name.lower(), CategoryUsage())

    for name, count in _counts_by_category(db, Transaction):
        entry(name).transactions = count
    for name, count in _counts_by_category(db, MerchantMemory):
        entry(name).memory = count
    for name, count in Counter(rule.category.lower() for rule in rules.rules).items():
        entry(name).rules = count
    return usage


def _groups(names: list[str]) -> list[str]:
    """The category groups of ``names``, each once, in menu order."""
    return list(dict.fromkeys(category_group(name) for name in names))


def _valid_emoji(value: str) -> bool:
    """``""`` (no emoji) or 1 to 8 characters that are not all letters or digits."""
    if value == "":
        return True
    return len(value) <= MAX_EMOJI_LENGTH and value == value.strip() and not value.isalnum()


def effective_emojis(categories: Categories, defaults: dict[str, str]) -> dict[str, str]:
    """Group -> emoji for the groups in ``categories``: the saved value, else the default.

    ``""`` (saved to hide a default) is kept so the editor can tell "removed" from
    "never had one"; groups with neither a saved value nor a default are left out.
    """
    out: dict[str, str] = {}
    for group in _groups(categories.categories):
        value = categories.emojis[group] if group in categories.emojis else defaults.get(group)
        if value is not None:
            out[group] = value
    return out


def check_emojis(emojis: dict[str, str], names: list[str]) -> dict[str, str]:
    """The submitted group -> emoji map, keys spelt as the groups of ``names`` (matched
    ignoring case), values trimmed; raise :class:`SiteSettingsError` naming the group."""
    groups = _groups(names)
    out: dict[str, str] = {}
    for raw_group, raw_value in emojis.items():
        wanted = (raw_group or "").strip()
        group = wanted if wanted in groups else next((g for g in groups if g.lower() == wanted.lower()), None)
        if group is None:
            raise SiteSettingsError(f"emoji for {wanted!r}: {wanted!r} is not a category group")
        if group in out:
            raise SiteSettingsError(f"emoji for {group!r} is given twice")
        value = raw_value.strip()
        if raw_value and not value:
            raise SiteSettingsError(f"emoji for {group!r} must not be blank (send \"\" for no emoji)")
        if not _valid_emoji(value):
            raise SiteSettingsError(
                f"emoji for {group!r} must be an emoji or a short symbol "
                f"(1 to {MAX_EMOJI_LENGTH} characters, not only letters or digits)"
            )
        out[group] = value
    return out


def _prune_emojis(emojis: dict[str, str], names: list[str]) -> dict[str, str]:
    groups = set(_groups(names))
    return {group: emoji for group, emoji in emojis.items() if group in groups}


def categories_out(
    categories: Categories, stored: bool, usage: dict[str, CategoryUsage], default_emojis: dict[str, str]
) -> CategoriesOut:
    return CategoriesOut(
        categories=[
            CategoryOut(name=name, in_use=usage.get(name.lower(), CategoryUsage())) for name in categories.categories
        ],
        emojis=effective_emojis(categories, default_emojis),
        default_emojis={g: default_emojis[g] for g in _groups(categories.categories) if default_emojis.get(g)},
        stored=stored,
    )


def _plural(n: int, singular: str, plural: str | None = None) -> str:
    return f"{n} {singular if n == 1 else (plural or singular + 's')}"


def _usage_sentence(usage: CategoryUsage) -> str:
    return (
        f"{_plural(usage.transactions, 'transaction')}, "
        f"{_plural(usage.memory, 'remembered merchant')} and {_plural(usage.rules, 'rule')}"
    )


def update_categories(db: Session, base: AppConfig, effective: AppConfig, body: CategoriesUpdate) -> Categories:
    """Replace the taxonomy (adds, removals, reordering) and/or the group emojis; a
    removal still in use is refused. Emojis of groups no longer listed are dropped."""
    current, _ = load_categories(db, base)
    names = normalise_categories(body.categories).categories if body.categories is not None else current.categories
    if body.emojis is None:
        emojis = _prune_emojis(current.emojis, names)
    else:
        emojis = check_emojis(body.emojis, names)
    proposed = Categories(categories=names, emojis=emojis)
    rules, _ = load_rules(db, base)
    usage = category_usage(db, rules)
    kept = {name.lower() for name in proposed.categories}
    for name in current.categories:
        if name.lower() in kept:
            continue
        used = usage.get(name.lower())
        if used is not None and used.total:
            raise SiteSettingsConflict(f"category {name!r} is still used by {_usage_sentence(used)}")
    validate_full(apply_categories(effective, proposed))
    save_categories(db, proposed)
    return proposed


def rename_category(db: Session, base: AppConfig, effective: AppConfig, body: CategoryRename) -> Categories:
    """Rename a category everywhere: the taxonomy, every transaction row, the merchant
    memory and the rules. Flushed, not committed, so the caller's commit makes it one
    transaction."""
    source = (body.from_ or "").strip()
    target = (body.to or "").strip()
    if not source or not target:
        raise SiteSettingsError("category names must not be empty")
    if len(target) > MAX_CATEGORY_LENGTH:
        raise SiteSettingsError(f"category is longer than {MAX_CATEGORY_LENGTH} characters")
    current, _ = load_categories(db, base)
    match = next((name for name in current.categories if name.lower() == source.lower()), None)
    if match is None:
        raise SiteSettingsNotFound(f"category {source!r} is not in the taxonomy")
    if match == UNCATEGORIZED:
        raise SiteSettingsConflict(f"{UNCATEGORIZED!r} cannot be renamed")
    if target.lower() != match.lower():
        clash = next((name for name in current.categories if name.lower() == target.lower()), None)
        if clash is not None:
            raise SiteSettingsConflict(f"category {clash!r} already exists")
    names = normalise_categories([target if name == match else name for name in current.categories]).categories
    emojis = dict(current.emojis)
    old_group, new_group = category_group(match), category_group(target)
    old_groups, new_groups = set(_groups(current.categories)), set(_groups(names))
    if old_group not in new_groups and new_group not in old_groups:
        # The whole group was renamed (its only category): its emoji goes with it.
        carried = effective_emojis(current, base.category_emojis).get(old_group)
        if carried is not None:
            emojis[new_group] = carried
    proposed = Categories(categories=names, emojis=_prune_emojis(emojis, names))
    validate_full(apply_categories(effective, proposed))

    for model in (Transaction, MerchantMemory):
        db.execute(update(model).where(func.lower(model.category) == match.lower()).values(category=target))
    rules, _ = load_rules(db, base)
    renamed = [
        rule.model_copy(update={"category": target}) if rule.category.lower() == match.lower() else rule
        for rule in rules.rules
    ]
    if renamed != rules.rules:
        save_rules(db, rules.model_copy(update={"rules": renamed}))
    save_categories(db, proposed)
    return proposed


# --------------------------------------------------------------------------- #
# Rules
# --------------------------------------------------------------------------- #


def rules_out(rules: Rules, stored: bool) -> RulesOut:
    return RulesOut(**rules.model_dump(), stored=stored)


def merged_rules(current: Rules, body: RulesUpdate) -> Rules:
    data = current.model_dump()
    for key, value in body.model_dump(exclude_unset=True).items():
        if value is not None:
            data[key] = value
    return Rules.model_validate(data)


def update_rules(db: Session, base: AppConfig, effective: AppConfig, body: RulesUpdate) -> Rules:
    """Validate and persist a rules update (flushed, not committed)."""
    current, _ = load_rules(db, base)
    proposed = validate_rules(merged_rules(current, body), effective)
    validate_full(apply_rules(effective, proposed))
    save_rules(db, proposed)
    return proposed


def test_rules(rules: Rules, description: str) -> RuleTestOut:
    """Which rule (first match) and whether the card-payment patterns match ``description``."""
    transfers = TransfersSection(payment_patterns=list(rules.payment_patterns))
    for index, rule in enumerate(rules.rules):
        if DeterministicRule.model_validate(rule.model_dump()).matches(description):
            return RuleTestOut(rule_index=index, rule=rule, is_payment=transfers.is_payment(description))
    return RuleTestOut(rule_index=None, rule=None, is_payment=transfers.is_payment(description))


def try_rules(db: Session, base: AppConfig, effective: AppConfig, body: RuleTest) -> RuleTestOut:
    """The tester: saved rules and patterns unless the body carries its own (validated as on a PUT)."""
    current, _ = load_rules(db, base)
    doc = merged_rules(current, RulesUpdate(rules=body.rules, payment_patterns=body.payment_patterns))
    if body.rules is not None or body.payment_patterns is not None:
        doc = validate_rules(doc, effective)
    return test_rules(doc, body.description)
