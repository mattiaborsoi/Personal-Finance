"""Category group emojis (Settings -> Categories) and the picker's category suggestions."""

from __future__ import annotations

from datetime import date, timedelta

from app.config import DEFAULT_CATEGORY_EMOJIS, category_group
from app.models import AppSetting
from app.services import site_settings
from tests.conftest import requires_db
from tests.factories import make_transaction

PETS = "\U0001f43e"  # paw prints
PASTA = "\U0001f35d"  # spaghetti


def test_category_group():
    assert category_group("Bills:Water") == "Bills"
    assert category_group("Groceries") == "Groceries"
    assert category_group("Travel:Flights:Long") == "Travel"


def test_effective_emojis_overlay_and_filter():
    doc = site_settings.Categories(
        categories=["Bills:Water", "Coffee", "Pets:Food"], emojis={"Coffee": "", "Pets": PETS}
    )
    assert site_settings.effective_emojis(doc, DEFAULT_CATEGORY_EMOJIS) == {
        "Bills": DEFAULT_CATEGORY_EMOJIS["Bills"],
        "Coffee": "",
        "Pets": PETS,
    }


# --------------------------------------------------------------------------- #
# Emojis on the categories document
# --------------------------------------------------------------------------- #


@requires_db
def test_default_emojis_in_get(client, primary_headers, config):
    body = client.get("/api/settings/categories", headers=primary_headers).json()
    groups = {category_group(name) for name in config.categories}
    assert body["stored"] is False
    assert body["emojis"] == {group: DEFAULT_CATEGORY_EMOJIS[group] for group in groups}
    assert body["default_emojis"] == body["emojis"]
    assert body["emojis"]["Groceries"] == "\U0001f6d2" and body["emojis"]["Bills"] == "\U0001f9fe"
    exposed = client.get("/api/config", headers=primary_headers).json()["category_emojis"]
    assert exposed == body["emojis"]


@requires_db
def test_put_emojis_round_trip_and_empty_overrides_default(client, primary_headers, config):
    names = [*config.categories, "Pets:Food"]
    resp = client.put(
        "/api/settings/categories",
        json={"categories": names, "emojis": {"Pets": PETS, "dining": f" {PASTA} ", "Coffee": ""}},
        headers=primary_headers,
    )
    assert resp.status_code == 200, resp.text
    emojis = resp.json()["emojis"]
    assert emojis["Pets"] == PETS and emojis["Dining"] == PASTA  # key respelt as the group, value trimmed
    assert emojis["Coffee"] == ""  # "" hides the default
    assert emojis["Bills"] == DEFAULT_CATEGORY_EMOJIS["Bills"]  # untouched groups keep their default
    assert client.get("/api/settings/categories", headers=primary_headers).json()["emojis"] == emojis

    exposed = client.get("/api/config", headers=primary_headers).json()["category_emojis"]
    assert exposed["Pets"] == PETS and exposed["Dining"] == PASTA
    assert "Coffee" not in exposed  # the app config leaves groups without an emoji out

    # A PUT without emojis keeps the saved map.
    resp = client.put("/api/settings/categories", json={"categories": list(reversed(names))}, headers=primary_headers)
    assert resp.status_code == 200 and resp.json()["emojis"] == emojis

    # {} means "no custom emojis": the defaults apply again; categories left out are kept.
    resp = client.put("/api/settings/categories", json={"emojis": {}}, headers=primary_headers)
    assert resp.status_code == 200, resp.text
    assert "Pets:Food" in [c["name"] for c in resp.json()["categories"]]
    assert resp.json()["emojis"]["Coffee"] == DEFAULT_CATEGORY_EMOJIS["Coffee"]
    assert resp.json()["emojis"]["Dining"] == DEFAULT_CATEGORY_EMOJIS["Dining"]
    assert "Pets" not in resp.json()["emojis"]  # no default for a new group


@requires_db
def test_emoji_validation(client, primary_headers, config):
    for emojis, group in [
        ({"Nope": PETS}, "'Nope'"),
        ({"Dining": "Food"}, "'Dining'"),
        ({"Dining": "42"}, "'Dining'"),
        ({"Dining": "   "}, "'Dining'"),
        ({"Dining": PASTA * 9}, "'Dining'"),
        ({"Dining": PASTA, "dining": PETS}, "'Dining'"),
    ]:
        resp = client.put("/api/settings/categories", json={"emojis": emojis}, headers=primary_headers)
        assert resp.status_code == 422, emojis
        assert group in resp.json()["detail"], resp.text
    # A group only in the submitted list is accepted; one only in the current list is not once dropped.
    resp = client.put(
        "/api/settings/categories", json={"categories": ["Dining", "Pets:Food"], "emojis": {"Bills": PETS}},
        headers=primary_headers,
    )
    assert resp.status_code == 422 and "'Bills'" in resp.json()["detail"]
    assert client.get("/api/settings/categories", headers=primary_headers).json()["stored"] is False


@requires_db
def test_emojis_of_removed_groups_are_dropped(client, primary_headers, seeded_db, config):
    names = [*config.categories, "Pets:Food"]
    resp = client.put(
        "/api/settings/categories", json={"categories": names, "emojis": {"Pets": PETS}}, headers=primary_headers
    )
    assert resp.status_code == 200, resp.text

    # Dropped on save: the stored document forgets the group with the category.
    resp = client.put("/api/settings/categories", json={"categories": config.categories}, headers=primary_headers)
    assert resp.status_code == 200 and "Pets" not in resp.json()["emojis"]
    seeded_db.expire_all()
    assert "Pets" not in seeded_db.get(AppSetting, site_settings.CATEGORIES_KEY).value["emojis"]
    resp = client.put("/api/settings/categories", json={"categories": names}, headers=primary_headers)
    assert "Pets" not in resp.json()["emojis"]

    # Dropped on read: a stored entry for a group that is not listed never comes back.
    row = seeded_db.get(AppSetting, site_settings.CATEGORIES_KEY)
    row.value = {"categories": names, "emojis": {"Ghost": PETS, "Pets": PETS}}
    seeded_db.commit()
    body = client.get("/api/settings/categories", headers=primary_headers).json()
    assert "Ghost" not in body["emojis"] and body["emojis"]["Pets"] == PETS
    assert "Ghost" not in client.get("/api/config", headers=primary_headers).json()["category_emojis"]


@requires_db
def test_rename_carries_a_whole_groups_emoji(client, primary_headers, config):
    resp = client.post(
        "/api/settings/categories/rename", json={"from": "Education", "to": "Learning"}, headers=primary_headers
    )
    assert resp.status_code == 200, resp.text
    emojis = resp.json()["emojis"]
    assert emojis["Learning"] == DEFAULT_CATEGORY_EMOJIS["Education"] and "Education" not in emojis

    # Only one of the group's categories moves: the old group keeps its emoji, the new one has none.
    resp = client.post(
        "/api/settings/categories/rename", json={"from": "Health:Gym", "to": "Fitness:Gym"}, headers=primary_headers
    )
    assert resp.status_code == 200, resp.text
    emojis = resp.json()["emojis"]
    assert emojis["Health"] == DEFAULT_CATEGORY_EMOJIS["Health"] and "Fitness" not in emojis


# --------------------------------------------------------------------------- #
# GET /categories/suggestions
# --------------------------------------------------------------------------- #


def _seed_history(db, config, today: date) -> None:
    def txn(category, days_ago, merchant="Corner Cafe", **kw):
        return make_transaction(
            db, config, category=category, cleaned_merchant=merchant, raw_description=merchant.upper(),
            transaction_date=today - timedelta(days=days_ago), amount="-4.50", **kw,
        )

    txn("Dining", 10)
    txn("Dining", 20)
    txn("Coffee", 5)
    txn("Coffee", 40)
    txn("Groceries", 100, merchant="corner cafe", review_status="auto_approved")
    for _ in range(3):
        txn("Uncategorized", 2)
    for _ in range(5):
        txn("Shopping:Gifts", 2, review_status="pending_review")
    txn("Old:Gone", 3)  # no longer in the taxonomy
    parent = txn("Travel", 1, is_split=True)  # a split parent: its parts count instead
    txn("Groceries", 1, split_parent_id=parent.id, split_index=0)
    txn("Groceries", 1, split_parent_id=parent.id, split_index=1)
    txn("Dining", 30, merchant="Other Place")
    for _ in range(5):
        txn("Education", 400, merchant="Other Place")  # older than 12 months
    db.commit()


@requires_db
def test_suggestions(client, primary_headers, seeded_db, config, embedder):
    from app.services import memory

    today = date.today()
    _seed_history(seeded_db, config, today)
    url = "/api/categories/suggestions"

    resp = client.get(url, params={"merchant": "corner cafe"}, headers=primary_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Groceries 3 (one auto-approved, two split parts); Coffee and Dining tie on 2, Coffee used last.
    assert body["merchant"] == [
        {"category": "Groceries", "count": 3},
        {"category": "Coffee", "count": 2},
        {"category": "Dining", "count": 2},
    ]
    assert body["frequent"] == [
        {"category": "Dining", "count": 3},
        {"category": "Groceries", "count": 3},
        {"category": "Coffee", "count": 2},
    ]

    memory.remember(seeded_db, embedder, "CORNER CAFE LONDON", normalized_merchant="Corner Cafe",
                    category="Personal:Care", claim_type="personal")
    memory.remember(seeded_db, embedder, "CORNER CAFE PARIS", normalized_merchant="CORNER CAFE",
                    category="Dining", claim_type="personal")
    memory.remember(seeded_db, embedder, "BRAND NEW PLACE", normalized_merchant="Brand New Place",
                    category="Coffee", claim_type="personal")
    seeded_db.commit()

    body = client.get(url, params={"merchant": " Corner Cafe ", "limit": 10}, headers=primary_headers).json()
    # A memory entry adds its category with a count of at least 1; one agreeing with the
    # history adds no count but makes it the most recent (Dining now ahead of Coffee).
    assert body["merchant"] == [
        {"category": "Groceries", "count": 3},
        {"category": "Dining", "count": 2},
        {"category": "Coffee", "count": 2},
        {"category": "Personal:Care", "count": 1},
    ]
    categories = [item["category"] for item in body["frequent"]]
    assert "Education" not in categories and "Uncategorized" not in categories
    assert "Shopping:Gifts" not in categories and "Old:Gone" not in categories and "Travel" not in categories

    only_memory = client.get(url, params={"merchant": "brand new place", "limit": 1}, headers=primary_headers).json()
    assert only_memory == {
        "merchant": [{"category": "Coffee", "count": 1}],
        "frequent": [{"category": "Dining", "count": 3}],
    }

    unknown = client.get(url, params={"merchant": "Nowhere"}, headers=primary_headers).json()
    assert unknown["merchant"] == [] and len(unknown["frequent"]) == 3


@requires_db
def test_suggestions_validation_and_roles(client, primary_headers, secondary_headers):
    url = "/api/categories/suggestions"
    assert client.get(url, headers=primary_headers).status_code == 422
    resp = client.get(url, params={"merchant": "   "}, headers=primary_headers)
    assert resp.status_code == 422 and resp.json()["detail"] == "merchant must not be empty"
    for limit in (0, 11):
        assert client.get(url, params={"merchant": "X", "limit": limit}, headers=primary_headers).status_code == 422
    for limit in (1, 10):
        assert client.get(url, params={"merchant": "X", "limit": limit}, headers=primary_headers).status_code == 200
    assert client.get(url, params={"merchant": "X"}, headers=secondary_headers).status_code == 403
    assert client.get(url, params={"merchant": "X"}).status_code == 401
