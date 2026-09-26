"""Configuration engine.

Two layers of configuration exist:

* :class:`Settings` - runtime settings read from the environment (database URL,
  LiteLLM endpoint, secrets, provider switches).
* :class:`AppConfig` - the user's ``config.yaml``: identities, salaries, accounts,
  split strategy, deterministic rules and thresholds. Nothing personal is hard-coded
  anywhere in the codebase; ``config.example.yaml`` is a sanitised template.

Split ratios are derived from the configured incomes at load time and exposed as
``AppConfig.primary_ratio`` / ``AppConfig.secondary_ratio`` (exact ``Decimal``).
"""

from __future__ import annotations

import re
from decimal import Decimal
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, PrivateAttr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ClaimType = Literal[
    "personal",
    "shared_proportional",
    "shared_equal",
    "secondary_personal",
    "primary_personal",
]
CLAIM_TYPES: tuple[str, ...] = (
    "personal",
    "shared_proportional",
    "shared_equal",
    "secondary_personal",
    "primary_personal",
)

AccountType = Literal["checking", "savings", "credit", "credit_supplementary", "investment_cash"]
ACCOUNT_TYPES: tuple[str, ...] = ("checking", "savings", "credit", "credit_supplementary", "investment_cash")

ReviewStatus = Literal["pending_review", "auto_approved", "manual_approved"]
TransferState = Literal["unmatched", "matched", "ignored"]

DEFAULT_TRANSFER_PATTERNS: list[str] = [
    r"(?i)PAYMENT\s+RECEIVED\s*-?\s*THANK\s*YOU",
    r"(?i)PAYMENT\s+DD\s+THANK\s*YOU",
    r"(?i)DIRECT\s*DEBIT.*THANK\s*YOU",
    r"(?i)HSBC\s*CARD\s*PYMT",
    r"(?i)AMERICAN\s*EXPRESS",
    r"(?i)AMEX\s*(DD|PAYMENT)",
]

DEFAULT_CATEGORIES: list[str] = [
    "Bills:Water",
    "Bills:Energy",
    "Bills:Internet",
    "Bills:CouncilTax",
    "Housing:ServiceCharges",
    "Insurance:Life",
    "Groceries",
    "Dining",
    "Entertainment",
    "Subscriptions:Software",
    "Subscriptions:Entertainment",
    "Subscriptions:Cloud",
    "Health:Gym",
    "Transport:Public",
    "Travel",
    "Shopping",
    "Income:Salary",
    "Transfers:Internal",
    "Transfers:Settlement",
    "Transfers:Investment",
    "Uncategorized",
]

UNCATEGORIZED = "Uncategorized"
TRANSFER_CATEGORY_PREFIX = "Transfers:"


class ConfigError(ValueError):
    """Raised when config.yaml is missing or invalid."""


# --------------------------------------------------------------------------- #
# config.yaml models
# --------------------------------------------------------------------------- #


class AppSection(BaseModel):
    base_currency: str = "GBP"
    currency_symbol: str = "£"
    data_dir: str = "./data"


class UserConfig(BaseModel):
    id: str
    display_name: str
    base_salary_pa: Decimal = Decimal("0")
    additional_income_pa: Decimal = Decimal("0")

    @property
    def total_income_pa(self) -> Decimal:
        return self.base_salary_pa + self.additional_income_pa


class UsersSection(BaseModel):
    primary: UserConfig
    secondary: UserConfig

    @model_validator(mode="after")
    def _distinct_ids(self) -> UsersSection:
        if self.primary.id == self.secondary.id:
            raise ConfigError("users.primary.id and users.secondary.id must differ")
        return self


class SettlementSection(BaseModel):
    split_strategy: Literal["salary_proportional", "equal_50_50"] = "salary_proportional"
    rounding_decimals: int = Field(default=2, ge=0, le=6)
    settlement_day_of_month: int = Field(default=1, ge=1, le=28)


class AccountConfig(BaseModel):
    id: str
    institution: str
    label: str | None = None
    """Optional friendlier display name (e.g. ``"HSBC Premier"``). The UI falls back
    to the institution and account type when it is unset."""
    account_type: AccountType
    owner: str
    identifier_last4: str
    default_claim_type: ClaimType = "personal"
    billed_to: str | None = None
    """User who ultimately pays this account. Defaults to the primary user for
    supplementary credit cards (they are billed to the main cardholder) and to
    ``owner`` otherwise."""
    is_active: bool = True
    """Archived accounts (``False``) keep their history but are not offered for
    uploads. Only meaningful for accounts loaded from the database."""

    @field_validator("identifier_last4")
    @classmethod
    def _strip_last4(cls, v: str) -> str:
        v = str(v).strip()
        if not v:
            raise ConfigError("identifier_last4 must not be empty")
        return v


class DeterministicRule(BaseModel):
    pattern: str
    category: str
    claim_type: ClaimType = "personal"
    merchant: str | None = None
    subcategory: str | None = None
    is_internal_transfer: bool = False
    transfer_to_account: str | None = None

    _regex: re.Pattern[str] = PrivateAttr()

    @field_validator("pattern")
    @classmethod
    def _compiles(cls, v: str) -> str:
        try:
            re.compile(v)
        except re.error as exc:  # pragma: no cover - exercised via ConfigError tests
            raise ConfigError(f"invalid regex {v!r}: {exc}") from exc
        return v

    def model_post_init(self, __context: object) -> None:
        self._regex = re.compile(self.pattern)

    @property
    def regex(self) -> re.Pattern[str]:
        return self._regex

    def matches(self, description: str) -> bool:
        return bool(self._regex.search(description or ""))


class TransfersSection(BaseModel):
    payment_patterns: list[str] = Field(default_factory=lambda: list(DEFAULT_TRANSFER_PATTERNS))
    match_window_days: int = Field(default=7, ge=0, le=60)
    amount_tolerance: Decimal = Decimal("0.01")

    _regexes: list[re.Pattern[str]] = PrivateAttr(default_factory=list)

    @field_validator("payment_patterns")
    @classmethod
    def _compile_all(cls, v: list[str]) -> list[str]:
        for p in v:
            try:
                re.compile(p)
            except re.error as exc:
                raise ConfigError(f"invalid transfer regex {p!r}: {exc}") from exc
        return v

    def model_post_init(self, __context: object) -> None:
        self._regexes = [re.compile(p) for p in self.payment_patterns]

    @property
    def regexes(self) -> list[re.Pattern[str]]:
        return self._regexes

    def is_payment(self, description: str) -> bool:
        return any(r.search(description or "") for r in self._regexes)


class LLMSection(BaseModel):
    chat_model: str = "default-chat"
    """Model for classifying merchants (many small calls)."""
    extraction_model: str | None = None
    """Model for reading PDFs the parsers cannot; defaults to ``chat_model``."""
    audit_model: str | None = None
    """Model for the monthly summary sentence; defaults to ``chat_model``."""
    embedding_model: str = "default-embedding"
    similarity_threshold: float = Field(default=0.82, ge=0.0, le=1.0)
    top_k: int = Field(default=3, ge=1, le=20)

    @property
    def extraction_model_name(self) -> str:
        return self.extraction_model or self.chat_model

    @property
    def audit_model_name(self) -> str:
        return self.audit_model or self.chat_model


class AuditorSection(BaseModel):
    deviation_threshold: float = Field(default=0.15, ge=0.0)
    lookback_periods: int = Field(default=3, ge=1, le=24)


class AppConfig(BaseModel):
    app: AppSection = Field(default_factory=AppSection)
    users: UsersSection
    settlement: SettlementSection = Field(default_factory=SettlementSection)
    accounts: list[AccountConfig] = Field(default_factory=list)
    deterministic_rules: list[DeterministicRule] = Field(default_factory=list)
    transfers: TransfersSection = Field(default_factory=TransfersSection)
    llm: LLMSection = Field(default_factory=LLMSection)
    auditor: AuditorSection = Field(default_factory=AuditorSection)
    categories: list[str] = Field(default_factory=lambda: list(DEFAULT_CATEGORIES))

    # ----- validation -------------------------------------------------------
    @model_validator(mode="after")
    def _validate_references(self) -> AppConfig:
        user_ids = {self.users.primary.id, self.users.secondary.id}
        seen: set[str] = set()
        for acc in self.accounts:
            if acc.id in seen:
                raise ConfigError(f"duplicate account id {acc.id!r}")
            seen.add(acc.id)
            if acc.owner not in user_ids:
                raise ConfigError(f"account {acc.id!r} owner {acc.owner!r} is not a configured user")
            if acc.billed_to is not None and acc.billed_to not in user_ids:
                raise ConfigError(f"account {acc.id!r} billed_to {acc.billed_to!r} is not a configured user")
        for rule in self.deterministic_rules:
            if rule.transfer_to_account and rule.transfer_to_account not in seen:
                raise ConfigError(
                    f"rule {rule.pattern!r} references unknown transfer_to_account {rule.transfer_to_account!r}"
                )
        if UNCATEGORIZED not in self.categories:
            self.categories.append(UNCATEGORIZED)
        if self.settlement.split_strategy == "salary_proportional":
            if self.users.primary.total_income_pa + self.users.secondary.total_income_pa <= 0:
                raise ConfigError("salary_proportional split requires a positive combined income")
        return self

    # ----- derived values ---------------------------------------------------
    @property
    def primary_ratio(self) -> Decimal:
        """Exact share of shared expenses borne by the primary user."""
        if self.settlement.split_strategy == "equal_50_50":
            return Decimal("0.5")
        p = self.users.primary.total_income_pa
        s = self.users.secondary.total_income_pa
        return p / (p + s)

    @property
    def secondary_ratio(self) -> Decimal:
        return Decimal("1") - self.primary_ratio

    @property
    def primary_user_id(self) -> str:
        return self.users.primary.id

    @property
    def secondary_user_id(self) -> str:
        return self.users.secondary.id

    @property
    def user_ids(self) -> tuple[str, str]:
        return (self.users.primary.id, self.users.secondary.id)

    def is_primary(self, user_id: str) -> bool:
        return user_id == self.users.primary.id

    # ----- taxonomy ---------------------------------------------------------
    def canonical_category(self, value: str | None) -> str | None:
        """The configured category spelt as in ``categories``, or ``None`` when unknown.

        Matching ignores case and surrounding whitespace, so a client sending
        ``"groceries"`` gets ``"Groceries"`` back. :data:`UNCATEGORIZED` is always
        accepted, even for a configuration that does not list it.
        """
        wanted = (value or "").strip().lower()
        if not wanted:
            return None
        if wanted == UNCATEGORIZED.lower():
            return UNCATEGORIZED
        for category in self.categories:
            if category.lower() == wanted:
                return category
        return None

    def user(self, user_id: str) -> UserConfig:
        if user_id == self.users.primary.id:
            return self.users.primary
        if user_id == self.users.secondary.id:
            return self.users.secondary
        raise KeyError(user_id)

    # ----- account helpers --------------------------------------------------
    def account_by_id(self, account_id: str) -> AccountConfig:
        for acc in self.accounts:
            if acc.id == account_id:
                return acc
        raise KeyError(account_id)

    def get_account(self, account_id: str) -> AccountConfig | None:
        try:
            return self.account_by_id(account_id)
        except KeyError:
            return None

    def accounts_by_last4(self, last4: str, institution: str | None = None) -> list[AccountConfig]:
        last4 = str(last4).strip()
        out = [a for a in self.accounts if a.identifier_last4 == last4]
        if institution:
            inst = institution.strip().lower()
            narrowed = [a for a in out if a.institution.lower() == inst]
            if narrowed:
                return narrowed
        return out

    def payer_for_account(self, account_id: str) -> str:
        """User whose money settles the account (see :attr:`AccountConfig.billed_to`)."""
        acc = self.account_by_id(account_id)
        if acc.billed_to:
            return acc.billed_to
        if acc.account_type == "credit_supplementary":
            return self.users.primary.id
        return acc.owner

    def checking_account_ids(self) -> list[str]:
        return [a.id for a in self.accounts if a.account_type in ("checking", "savings")]

    def investment_account_ids(self) -> list[str]:
        return [a.id for a in self.accounts if a.account_type == "investment_cash"]

    def active_accounts(self) -> list[AccountConfig]:
        return [a for a in self.accounts if a.is_active]

    def with_accounts(self, accounts: list[AccountConfig]) -> AppConfig:
        """A copy of this configuration whose accounts are ``accounts``.

        Used to overlay the database rows (the source of truth once the app is
        running) on the file configuration. No cross-validation is re-run: an
        account that a rule refers to may legitimately have been archived.
        """
        return self.model_copy(update={"accounts": list(accounts)})

    # ----- serialisation for the UI ----------------------------------------
    def public_dict(self) -> dict:
        """Configuration safe to expose to the browser (no salaries, no rules)."""
        return {
            "base_currency": self.app.base_currency,
            "currency_symbol": self.app.currency_symbol,
            "users": {
                "primary": {"id": self.users.primary.id, "display_name": self.users.primary.display_name},
                "secondary": {
                    "id": self.users.secondary.id,
                    "display_name": self.users.secondary.display_name,
                },
            },
            "split": {
                "strategy": self.settlement.split_strategy,
                "primary_ratio": float(self.primary_ratio),
                "secondary_ratio": float(self.secondary_ratio),
                "rounding_decimals": self.settlement.rounding_decimals,
                "settlement_day_of_month": self.settlement.settlement_day_of_month,
            },
            "accounts": [
                {
                    "id": a.id,
                    "institution": a.institution,
                    "label": a.label,
                    "account_type": a.account_type,
                    "owner": a.owner,
                    "identifier_last4": a.identifier_last4,
                    "default_claim_type": a.default_claim_type,
                    "billed_to": self.payer_for_account(a.id),
                    "is_active": a.is_active,
                }
                for a in self.accounts
            ],
            "categories": list(self.categories),
            "claim_types": list(CLAIM_TYPES),
        }


def load_config(path: str | Path) -> AppConfig:
    """Load and validate ``config.yaml`` from *path*."""
    p = Path(path)
    if not p.exists():
        raise ConfigError(
            f"config file not found at {p}. Copy config.example.yaml to config.yaml and edit it, "
            "or set CONFIG_PATH."
        )
    try:
        raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise ConfigError(f"could not parse {p}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError(f"{p} must contain a mapping at the top level")
    try:
        return AppConfig.model_validate(raw)
    except ConfigError:
        raise
    except Exception as exc:  # pydantic ValidationError
        raise ConfigError(f"invalid configuration in {p}: {exc}") from exc


def load_config_from_dict(raw: dict) -> AppConfig:
    return AppConfig.model_validate(raw)


# --------------------------------------------------------------------------- #
# Environment settings
# --------------------------------------------------------------------------- #


class Settings(BaseSettings):
    """Runtime settings sourced from environment variables (and a local ``.env``)."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgresql://postgres:postgres@localhost:5432/financemaster"
    litellm_url: str = "http://localhost:4000"
    """The bundled proxy (or whatever LITELLM_URL says); Settings -> AI can point elsewhere."""
    litellm_api_key: str = ""
    litellm_master_key: str = "sk-local-change-me"
    """Falls back to the bundled proxy's master key when LITELLM_API_KEY is unset."""
    config_path: str = "./config.yaml"
    upload_dir: str | None = None
    """Where uploaded statements are kept; defaults to ``<app.data_dir>/uploads``."""
    keep_uploaded_files: bool = False
    """Keep original statement files after ingestion (they contain full account details)."""

    secret_key: str = "change-me-to-a-long-random-string"
    primary_password: str = "change-me-primary"
    secondary_password: str = "change-me-secondary"
    session_ttl_seconds: int = 30 * 24 * 3600

    llm_provider: Literal["litellm", "none"] = "litellm"
    embedding_provider: Literal["litellm", "hash"] = "litellm"
    llm_timeout_seconds: float = 90.0
    embedding_dimensions: int = 1536

    cors_origins: str = "http://localhost:5173,http://localhost"

    # Self-update (Settings -> System). The updater is an optional sidecar container
    # (see docker-compose.yml); when it is unreachable the UI shows manual steps.
    updater_url: str = "http://updater:9000"
    update_repo: str = "mattiaborsoi/personal-finance"
    """GitHub ``owner/repo`` whose default branch is compared with the running code."""
    update_branch: str = "main"
    update_check: bool = True
    """Set to false to never contact GitHub (the System tab then only shows the running commit)."""
    github_api_url: str = "https://api.github.com"

    @property
    def sqlalchemy_url(self) -> str:
        return normalise_database_url(self.database_url)

    @property
    def proxy_api_key(self) -> str:
        return self.litellm_api_key or self.litellm_master_key


def normalise_database_url(url: str) -> str:
    """Rewrite ``postgresql://`` / ``postgres://`` URLs to use the psycopg 3 driver."""
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://") :]
    return url
