"""Deterministic config matcher (pre-processing before any LLM call).

Rules from ``config.yaml`` are tried in order against the raw statement description.
A match yields the category, claim type, an optional cleaned merchant name and
transfer flags; matched transactions are ``auto_approved`` and never hit the LLM.

This module also owns :func:`clean_merchant_name`, the heuristic that turns a raw
statement description (``'WAITROSE 1234 LONDON GB'``) into a display name
(``'Waitrose'``). It is deliberately simple and readable: a handful of documented
steps rather than a merchant database.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.config import AppConfig, DeterministicRule

MAX_MERCHANT_LENGTH = 255  # transactions.cleaned_merchant is VARCHAR(255)
UNKNOWN_MERCHANT = "Unknown"

# Leading payment-processor tags and bank narrative prefixes that carry no
# information about the merchant. Applied repeatedly, so 'CARD PAYMENT TO SQ *X'
# is reduced to 'X'.
_PREFIX_RE = re.compile(
    r"^(?:"
    # processor tags: 'SP ', 'SQ *', 'PAYPAL *', 'PP*', 'CRV*', 'IZ *', 'ZTL*', 'SUMUP *', 'DD '
    r"(?:SP|SQ|PAYPAL|PP|CRV|IZ|ZTL|SUMUP|DD)(?:\s*\*\s*|\s+)"
    # bank narrative prefixes
    r"|(?:CARD\s+PAYMENT\s+TO|DEBIT\s+CARD\s+PAYMENT\s+TO|CONTACTLESS\s+PAYMENT\s+TO|BILL\s+PAYMENT\s+TO"
    r"|DIRECT\s+DEBIT(?:\s+PAYMENT)?(?:\s+TO)?|STANDING\s+ORDER(?:\s+TO)?|FASTER\s+PAYMENTS?\s+(?:TO|FROM)"
    r"|POS)\s+"
    r")",
    re.IGNORECASE,
)

# 'www.' and domain suffixes (plus any path): 'NETFLIX.COM' -> 'NETFLIX',
# 'APPLE.COM/BILL' -> 'APPLE', 'AMAZON.CO.UK' -> 'AMAZON'.
_WWW_RE = re.compile(r"^WWW\.", re.IGNORECASE)
_DOMAIN_RE = re.compile(r"\.(?:COM|CO\.UK|NET|ORG|IO|UK)(?:/\S*)?$", re.IGNORECASE)

# Company-form tokens dropped wherever they appear.
_COMPANY_TOKENS = frozenset({"LTD", "LIMITED", "PLC", "LLC", "INC", "CORP", "GMBH"})

# Trailing country / city suffixes ('WAITROSE 1234 LONDON GB') and statement
# credit/debit markers ('PARTNER TRANSFER CR').
_LOCATION_TOKENS = frozenset(
    {
        "GB", "GBR", "UK", "ENG", "ENGLAND", "SCOTLAND", "WALES", "IE", "IRL", "IRELAND",
        "US", "USA", "EU", "FR", "FRA", "DE", "DEU", "ES", "ESP", "IT", "ITA", "NL", "NLD",
        "BE", "PT", "CH", "CHE", "AT", "SE", "DK", "NO", "FI", "PL", "AU", "AUS", "NZ",
        "CA", "CAN", "JP", "JPN", "SG", "HK", "AE",
        "LONDON", "MANCHESTER", "BIRMINGHAM", "LEEDS", "GLASGOW", "EDINBURGH", "BRISTOL",
        "LIVERPOOL", "CAMBRIDGE", "OXFORD", "DUBLIN",
        "CR", "DR",
    }
)  # fmt: skip

# Trailing reference-like tokens: store numbers, card/phone/reference numbers,
# numeric dates and times ('1234', '866-579-7172', '12/08/2026', '12:34').
_NUMERIC_RE = re.compile(r"^[\d\-/:.]*\d[\d\-/:.]*$")
# Dates written as day + month abbreviation: '12AUG', '12AUG26'.
_DATE_RE = re.compile(r"^\d{1,2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{0,4}$", re.IGNORECASE)
# Mixed alphanumeric references of five or more characters with at least two
# digits: 'REF123456', 'AB12C3', 'ORDER1234567'.
_REF_RE = re.compile(r"^(?=(?:.*\d){2})(?=.*[A-Z])[A-Z0-9\-]{5,}$", re.IGNORECASE)

# Short all-caps tokens that contain a vowel but are nevertheless initialisms.
_KNOWN_ACRONYMS = frozenset({"EE", "AA", "UPS", "RAC", "ITV", "TUI", "EON", "AIB", "IHG"})
_VOWELS = frozenset("AEIOU")


@dataclass(slots=True)
class RuleMatch:
    rule: DeterministicRule
    category: str
    claim_type: str
    merchant: str
    subcategory: str | None = None
    is_internal_transfer: bool = False
    transfer_to_account: str | None = None


def clean_merchant_name(raw_description: str) -> str:
    """Heuristic tidy-up of a raw statement description into a display merchant name.

    Steps, in order:

    1. Strip leading processor tags and bank narrative prefixes
       (``'SP '``, ``'SQ *'``, ``'PAYPAL *'``, ``'CRV*'``, ``'DD '``,
       ``'CARD PAYMENT TO '``, ``'DIRECT DEBIT '``...), repeatedly.
    2. Treat ``*``, ``#`` and ``,`` as separators and split into tokens.
    3. Per token: drop ``www.``, domain suffixes (``.COM``, ``.CO.UK``...) and
       trailing punctuation.
    4. Drop company-form tokens anywhere (``LTD``, ``LIMITED``, ``PLC``...).
    5. Drop trailing noise tokens while more than one token remains: store / card /
       reference / phone numbers, dates, country and city suffixes, ``CR``/``DR``.
    6. Title-case: all-caps tokens become ``Title`` (``'Sainsbury's'``, ``'Co-Op'``);
       short all-caps initialisms of at most three letters with no vowel
       (``'BP'``, ``'M&S'``, ``'TFL'``) are kept as-is, as are a few known
       vowel-bearing ones (``'EE'``); mixed-case tokens (``'PayPal'``) are left alone.

    Never returns an empty string: if the heuristics strip everything, the result
    falls back to the stripped raw description (title-cased); a blank input yields
    ``'Unknown'``. The result is capped at 255 characters (the column width).
    """
    raw = (raw_description or "").strip()
    if not raw:
        return UNKNOWN_MERCHANT

    text = _strip_prefixes(raw)
    text = re.sub(r"[*#,]", " ", text)

    tokens = [_normalise_token(t) for t in text.split()]
    tokens = [t for t in tokens if t and t.upper() not in _COMPANY_TOKENS]
    while len(tokens) > 1 and _is_trailing_noise(tokens[-1]):
        tokens.pop()

    cleaned = " ".join(_case_token(t) for t in tokens).strip(" -*:,./")
    if not cleaned:
        cleaned = " ".join(_case_token(t) for t in raw.split())
    return cleaned[:MAX_MERCHANT_LENGTH].rstrip()


def _strip_prefixes(text: str) -> str:
    """Remove up to three stacked prefixes, never consuming the whole string."""
    for _ in range(3):
        m = _PREFIX_RE.match(text)
        if m is None or m.end() >= len(text):
            break
        text = text[m.end() :]
    return text


def _normalise_token(token: str) -> str:
    token = _WWW_RE.sub("", token)
    token = _DOMAIN_RE.sub("", token)
    return token.rstrip(".,;:")


def _is_trailing_noise(token: str) -> bool:
    upper = token.upper()
    return (
        upper in _LOCATION_TOKENS
        or bool(_NUMERIC_RE.match(token))
        or bool(_DATE_RE.match(token))
        or bool(_REF_RE.match(token))
    )


def _case_token(token: str) -> str:
    """Title-case an all-caps or all-lowercase token, preserving initialisms."""
    if token.isupper():
        letters = token.replace("&", "")
        if letters.isalpha() and len(letters) <= 3:
            if token in _KNOWN_ACRONYMS or not (_VOWELS & set(letters)):
                return token
        return _title(token)
    if token.islower():
        return _title(token)
    return token  # already mixed case (PayPal, iTunes): trust it


def _title(token: str) -> str:
    """Capitalise each hyphen-separated part; unlike ``str.title`` this keeps
    ``"SAINSBURY'S"`` as ``"Sainsbury's"``."""
    return "-".join(part[:1].upper() + part[1:].lower() for part in token.split("-"))


def match_rule(raw_description: str, config: AppConfig) -> RuleMatch | None:
    """Return the first deterministic rule matching ``raw_description`` or ``None``.

    Rules are tried in ``config.deterministic_rules`` order; the first match wins.
    The merchant is the rule's ``merchant`` if set, else the cleaned description.
    A rule that names a ``transfer_to_account`` is always an internal transfer.
    """
    for rule in config.deterministic_rules:
        if rule.matches(raw_description):
            return RuleMatch(
                rule=rule,
                category=rule.category,
                claim_type=rule.claim_type,
                merchant=rule.merchant or clean_merchant_name(raw_description),
                subcategory=rule.subcategory,
                is_internal_transfer=rule.is_internal_transfer or bool(rule.transfer_to_account),
                transfer_to_account=rule.transfer_to_account,
            )
    return None
