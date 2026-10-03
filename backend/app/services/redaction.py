"""Redaction of personal data before any text leaves for a language model.

Everything the AI receives goes through a :class:`Redactor` first: statement lines
and the few-shot examples sent to the classifier, the page text of a PDF the parsers
could not read, the merchant names in the monthly summary payload and the owner's
own questions. The original text never changes; only the copy sent out does.

What is masked, in this order:

* e-mail addresses -> ``[email]``;
* phone numbers (UK mobile and landline shapes, ``+44`` forms) -> ``[phone]``;
* UK postcodes -> ``[postcode]``;
* any run of 6 or more digits (references, account numbers), a sort code written
  as three pairs (``00-00-00``) and digit groups of four or more joined by spaces or
  hyphens (a card number in any grouping) -> ``[number]``; a card-length run of 12
  or more digits keeps its last four (``[card:5502]``), the digits a statement
  prints anyway and the app needs to tell card sections apart;
* the two household members' names (every word of each display name of two or more
  letters, matched as whole words ignoring case) -> ``[name]``;
* the extra words saved under Settings -> AI (``privacy.redact_words``) -> ``[word]``.

Dates (``03/08/2026``), amounts (``3,384.21``) and four-digit store or card
endings are left alone: they are not personal and the classifier needs them.

:meth:`Redactor.redact_indexed` numbers every placeholder (``[number#3]``) and hands
back the map to the originals, so text a model copies verbatim (the ``raw_text`` of
a PDF line) can be put back locally with :meth:`Redactor.restore`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.config import AppConfig

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# UK shapes: 07700 900123, (020) 7946 0123, +44 7700 900123; 10 or 11 national digits (checked in ``_run``).
PHONE_RE = re.compile(
    r"(?<![\w.])(?:\+44\s?\(?0?\)?\s?\d{2,4}|\(?0\d{2,4}\)?)[\s-]?\d{3,4}[\s-]?\d{3,4}(?![\w.-])"
)
POSTCODE_RE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]{1,2}\d[A-Za-z\d]?\s?\d[A-Za-z]{2}(?![A-Za-z0-9])")
# A run of digit groups joined by single spaces or hyphens ("0000 0000 0000 5502",
# "00-00-00", "12345678"); which of them to mask is decided in ``_digit_groups``.
DIGIT_RUN_RE = re.compile(r"(?<![\d.,])\d+(?:[ -]\d+)*(?![\d.,]*\d)")
MIN_DIGITS = 6
CARD_LENGTH = 12
CARD_GROUP_MIN = 4
MIN_NAME_LENGTH = 2
MAX_REDACT_WORDS = 50
MAX_REDACT_WORD_LENGTH = 64

PLACEHOLDER_RE = re.compile(r"\[(email|phone|postcode|number|card|name|word)(?:#(\d+))?(?::\d{4})?\]")


def _word_pattern(words: list[str]) -> re.Pattern[str] | None:
    cleaned = sorted({w.strip() for w in words if w and len(w.strip()) >= MIN_NAME_LENGTH}, key=len, reverse=True)
    if not cleaned:
        return None
    alternatives = "|".join(re.escape(w) for w in cleaned)
    return re.compile(rf"(?<![A-Za-z0-9])(?:{alternatives})(?![A-Za-z0-9])", re.IGNORECASE)


def _name_words(display_names: list[str]) -> list[str]:
    words: list[str] = []
    for name in display_names:
        for token in re.split(r"[\s\-']+", name or ""):
            token = token.strip(".,")
            if len(token) >= MIN_NAME_LENGTH and token.isalpha():
                words.append(token)
    return words


@dataclass(slots=True)
class Redactor:
    """Masks personal data in text; built from the household names and the extra words."""

    names: list[str] = field(default_factory=list)
    words: list[str] = field(default_factory=list)
    _name_re: re.Pattern[str] | None = field(init=False, default=None, repr=False)
    _word_re: re.Pattern[str] | None = field(init=False, default=None, repr=False)

    def __post_init__(self) -> None:
        self._name_re = _word_pattern(_name_words(self.names))
        self._word_re = _word_pattern(self.words[:MAX_REDACT_WORDS])

    @classmethod
    def from_config(cls, config: AppConfig | None) -> Redactor:
        if config is None:
            return cls()
        return cls(
            names=[config.users.primary.display_name, config.users.secondary.display_name],
            words=list(config.privacy.redact_words),
        )

    # ----- plain masks -------------------------------------------------------
    def redact(self, text: str | None) -> str:
        """``text`` with every match replaced by its kind in brackets (``[name]``)."""
        redacted, _ = self._run(text or "", indexed=False)
        return redacted

    # ----- numbered masks with a map back ------------------------------------
    def redact_indexed(self, text: str | None) -> tuple[str, dict[str, str]]:
        """``(redacted, originals)``: placeholders are numbered (``[number#2]``) and
        ``originals`` maps each placeholder to the text it stands for."""
        return self._run(text or "", indexed=True)

    @staticmethod
    def restore(text: str | None, originals: dict[str, str]) -> str:
        """Put the originals back into text a model copied the placeholders into.

        A placeholder the map does not know (the model invented or mangled one) is
        left as it is; its brackets make it obvious in the ledger.
        """
        if not text:
            return text or ""
        return PLACEHOLDER_RE.sub(lambda m: originals.get(m.group(0), m.group(0)), text)

    # ----- internals -------------------------------------------------------------
    def _run(self, text: str, *, indexed: bool) -> tuple[str, dict[str, str]]:
        originals: dict[str, str] = {}
        counter = [0]

        def mask(kind: str, suffix: str = ""):
            def replace(m: re.Match[str]) -> str:
                if indexed:
                    counter[0] += 1
                    token = f"[{kind}#{counter[0]}{suffix}]"
                    originals[token] = m.group(0)
                    return token
                return f"[{kind}{suffix}]"

            return replace

        text = EMAIL_RE.sub(mask("email"), text)

        def phone(m: re.Match[str]) -> str:
            found = m.group(0)
            digits = sum(ch.isdigit() for ch in found) - (2 if found.startswith("+44") else 0)
            return mask("phone")(m) if 10 <= digits <= 11 else found

        text = PHONE_RE.sub(phone, text)
        text = POSTCODE_RE.sub(mask("postcode"), text)

        def digits(m: re.Match[str]) -> str:
            run = m.group(0)
            groups = re.split(r"[ -]", run)
            only = "".join(groups)
            whole = (
                len(groups) == 1
                or (len(groups) == 3 and all(len(g) == 2 for g in groups))  # a sort code
                or all(len(g) >= CARD_GROUP_MIN for g in groups)  # a card number in any grouping
            )
            if whole and len(only) >= CARD_LENGTH:
                return mask("card", f":{only[-4:]}")(m)
            if whole and len(only) >= MIN_DIGITS:
                return mask("number")(m)
            if len(groups) == 1:
                return run
            # Mixed groups (a date such as 2026-07-31): mask only the long ones, one by one.
            parts = re.split(r"([ -])", run)
            return "".join(
                mask("number")(re.match(r".*", part)) if part.isdigit() and len(part) >= MIN_DIGITS else part
                for part in parts
            )

        text = DIGIT_RUN_RE.sub(digits, text)
        if self._name_re is not None:
            text = self._name_re.sub(mask("name"), text)
        if self._word_re is not None:
            text = self._word_re.sub(mask("word"), text)
        return text, originals


def strip_placeholders(text: str | None) -> str:
    """Remove bracketed placeholders a model echoed into a value of its own (a merchant name)."""
    cleaned = PLACEHOLDER_RE.sub(" ", text or "")
    return " ".join(cleaned.split())
