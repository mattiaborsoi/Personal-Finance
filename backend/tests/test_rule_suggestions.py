"""Rule suggestions from approvals: fixed amounts, always-the-same merchants, overridden rules; dismissals."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from app.services import rule_suggestions
from app.services.rule_suggestions import pattern_for
from tests.conftest import requires_db
from tests.factories import make_transaction

D = Decimal


def test_pattern_for_escapes_the_merchant_key() -> None:
    assert pattern_for("THIRD SPACE 0012 LONDON") == r"(?i)THIRD\s*SPACE"
    assert pattern_for("WAITROSE 123") == "(?i)WAITROSE"
    assert pattern_for("M&S SIMPLY FOOD") == r"(?i)M&S\s*SIMPLY"
    assert pattern_for("12345") is None


def approved(db, config, day: int, amount: str, raw: str, merchant: str, category: str, claim_type="personal", **extra):
    return make_transaction(
        db, config, transaction_date=date(2026, 8, 1) + timedelta(days=day), amount=amount, raw_description=raw,
        cleaned_merchant=merchant, category=category, claim_type=claim_type, **extra,
    )  # fmt: skip


@requires_db
def test_fixed_amount_and_always_same_suggestions(seeded_db, config) -> None:
    # Gymbox (no rule for it): £40.00 three times as Health:Gym, plus a smoothie filed as Dining: a fixed-amount rule.
    for day in range(3):
        approved(seeded_db, config, day, "-40.00", "GYMBOX 0012 LONDON", "Gymbox", "Health:Gym")
    approved(seeded_db, config, 5, "-8.50", "GYMBOX 0012 LONDON", "Gymbox", "Dining")
    # Zoom Ocado: five times, always Groceries split by income: a plain rule.
    for day in range(5):
        approved(seeded_db, config, day, f"-{30 + day}.00", "ZOOM OCADO 12", "Ocado", "Groceries", "shared_equal")
    # Only twice: nothing to suggest yet. Pending lines, transfers and uncategorised ones never count.
    for day in range(2):
        approved(seeded_db, config, day, "-5.00", "PRET A MANGER", "Pret", "Dining")
    approved(seeded_db, config, 9, "-5.00", "PRET A MANGER", "Pret", "Dining", review_status="pending_review")
    for day in range(5):
        approved(seeded_db, config, day, "-1.00", "UNKNOWN THING", "Unknown", "Uncategorized")

    found = rule_suggestions.suggest(seeded_db, config)
    assert [(s.kind, s.merchant, s.count) for s in found] == [
        ("always_same", "Ocado", 5),
        ("fixed_amount", "Gymbox", 3),
    ]
    ocado, gym = found
    assert ocado.rule == {
        "pattern": r"(?i)ZOOM\s*OCADO", "category": "Groceries", "claim_type": "shared_equal", "merchant": None,
        "subcategory": None, "is_internal_transfer": False, "transfer_to_account": None, "amount_min": None,
        "amount_max": None,
    }  # fmt: skip
    assert ocado.key == "always:ZOOM OCADO:Groceries:shared_equal" and ocado.action == "add"
    assert gym.amount == D("40.00") and gym.rule["amount_min"] == gym.rule["amount_max"] == "40.00"
    assert gym.rule["pattern"] == "(?i)GYMBOX" and gym.examples == ["GYMBOX 0012 LONDON"]
    assert rule_suggestions.describe(config, gym) == "Gymbox, £40.00, filed as Health:Gym 3 times: make it a rule?"
    assert rule_suggestions.describe(config, ocado) == (
        "Ocado has always been filed as Groceries (5 times): make it a rule?"
    )

    rule_suggestions.dismiss(seeded_db, gym.key)
    assert [s.kind for s in rule_suggestions.suggest(seeded_db, config)] == ["always_same"]
    rule_suggestions.dismiss(seeded_db, gym.key)  # again is fine


@requires_db
def test_overridden_rule_suggests_a_range_or_removal(seeded_db, config) -> None:
    # config.example.yaml rule 8: (?i)THIRD\s*SPACE -> Health:Gym personal. The owner keeps filing the
    # £8.50 smoothies as Dining while the £40.00 fees stay as the rule says: narrow the rule to £40.00.
    for day in range(3):
        approved(seeded_db, config, day, "-8.50", "THIRD SPACE 0012 LONDON", "Third Space", "Dining")
    for day in range(2):
        approved(seeded_db, config, day + 10, "-40.00", "THIRD SPACE 0012 LONDON", "Third Space", "Health:Gym")
    # Rule 1: AQUANORTH WATER -> Bills:Water shared; filed as Housing:ServiceCharges every time: remove it.
    for day in range(3):
        approved(seeded_db, config, day, "-32.10", "AQUANORTH WATER", "Aquanorth Water", "Housing:ServiceCharges",
                 "shared_proportional")  # fmt: skip
    found = rule_suggestions.suggest(seeded_db, config)
    assert [(s.kind, s.action, s.rule_index, s.count) for s in found] == [
        ("override", "remove", 0, 3),  # same count: merchants in alphabetical order
        ("override", "edit", 7, 3),
    ]
    removed, narrowed = found
    assert narrowed.rule["pattern"] == r"(?i)THIRD\s*SPACE"
    assert (narrowed.rule["amount_min"], narrowed.rule["amount_max"]) == ("40.00", "40.00")
    assert rule_suggestions.describe(config, narrowed) == (
        "Rule 8 matched Third Space but you filed it as Dining 3 times: limit the rule to £40.00 to £40.00?"
    )
    assert removed.rule["pattern"] == r"(?i)AQUANORTH\s*WATER"
    assert rule_suggestions.describe(config, removed) == (
        "Rule 1 matched Aquanorth Water but you filed it as Housing:ServiceCharges every time (3): remove the rule?"
    )


@requires_db
def test_suggestions_endpoints(client, primary_headers, secondary_headers, seeded_db, config) -> None:
    for day in range(5):
        approved(seeded_db, config, day, "-12.00", "SPOTIFY", "Spotify", "Subscriptions:Entertainment")
    resp = client.get("/api/settings/rules/suggestions", headers=primary_headers)
    assert resp.status_code == 200, resp.text
    [item] = resp.json()["suggestions"]
    assert item["kind"] == "always_same" and item["text"].startswith("Spotify has always been filed")
    assert item["rule"]["pattern"] == "(?i)SPOTIFY" and item["amount"] is None and item["action"] == "add"

    # Accepting goes through the rules API as it is; afterwards the suggestion no longer applies.
    rules = client.get("/api/settings/rules", headers=primary_headers).json()["rules"]
    saved = client.put("/api/settings/rules", headers=primary_headers, json={"rules": [*rules, item["rule"]]})
    assert saved.status_code == 200, saved.text
    assert client.get("/api/settings/rules/suggestions", headers=primary_headers).json()["suggestions"] == []

    for day in range(5):
        approved(seeded_db, config, day, "-7.00", "DELIVEROO", "Deliveroo", "Dining")
    [item] = client.get("/api/settings/rules/suggestions", headers=primary_headers).json()["suggestions"]
    url = "/api/settings/rules/suggestions/dismiss"
    assert client.post(url, headers=primary_headers, json={"key": item["key"]}).status_code == 204
    assert client.get("/api/settings/rules/suggestions", headers=primary_headers).json()["suggestions"] == []
    assert client.get("/api/settings/rules/suggestions", headers=secondary_headers).status_code == 403
