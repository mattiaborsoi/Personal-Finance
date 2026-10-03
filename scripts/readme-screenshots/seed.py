#!/usr/bin/env python3
"""Fill a fresh, empty Settl with a believable synthetic household for the README screenshots.

Everything here is invented: Alex (primary) and Sam (secondary), their incomes, the
amounts and the card digits (the sanitised ones from config.example.yaml). The script
talks only to the HTTP API of the Settl at SETTL_URL and needs nothing beyond the
Python standard library.

    SETTL_URL=http://127.0.0.1 \
    SETTL_PRIMARY_PASSWORD=... SETTL_SECONDARY_PASSWORD=... \
    python3 seed.py

Optional: SETTL_DEMO_MONTHS (default 8) and SETTL_DEMO_END (YYYY-MM, default the
previous calendar month). Run it once, against a stack started with
LLM_PROVIDER=none and EMBEDDING_PROVIDER=hash and config.example.yaml as config.yaml.
"""

from __future__ import annotations

import calendar
import csv
import io
import json
import os
import random
import shutil
import sys
import tempfile
import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from urllib import error, request

BASE = os.environ.get("SETTL_URL", "http://127.0.0.1").rstrip("/")
PRIMARY_PASSWORD = os.environ.get("SETTL_PRIMARY_PASSWORD")
SECONDARY_PASSWORD = os.environ.get("SETTL_SECONDARY_PASSWORD")
MONTHS = int(os.environ.get("SETTL_DEMO_MONTHS", "8"))
PENDING_IN_LAST_MONTH = 10

ALEX, SAM = "user_primary", "user_secondary"
HSBC, BARCLAYS = "acc_checking_hsbc", "acc_checking_barclays"
AMEX, AMEX_SUPP, VIRGIN = "acc_cc_amex", "acc_cc_amex_supp", "acc_cc_virgin"

rng = random.Random(20260)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #


class Api:
    def __init__(self, password: str) -> None:
        self.token = None
        self.token = self.call("POST", "/api/auth/login", {"password": password})["token"]

    def call(self, method: str, path: str, body: object | None = None, *, raw: bytes | None = None,
             content_type: str = "application/json") -> object:
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = request.Request(BASE + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", content_type)
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with request.urlopen(req, timeout=120) as resp:
                text = resp.read().decode()
        except error.HTTPError as exc:
            sys.exit(f"{method} {path} -> {exc.code}: {exc.read().decode()[:500]}")
        return json.loads(text) if text else None

    def upload(self, path: Path, account_id: str) -> dict:
        boundary = uuid.uuid4().hex
        parts = [
            f'--{boundary}\r\nContent-Disposition: form-data; name="account_id"\r\n\r\n{account_id}\r\n'.encode(),
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
            "Content-Type: text/csv\r\n\r\n".encode() + path.read_bytes() + b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
        return self.call("POST", "/api/statements/upload", raw=b"".join(parts),
                         content_type=f"multipart/form-data; boundary={boundary}")


# --------------------------------------------------------------------------- #
# The household's merchants: raw text as printed, display name, category, claim type
# --------------------------------------------------------------------------- #

M = {
    "waitrose": ("WAITROSE 0731 ISLINGTON", "Waitrose", "Groceries", "shared_proportional"),
    "pret": ("PRET A MANGER KINGS CROSS", "Pret A Manger", "Coffee", "personal"),
    "dishoom": ("DISHOOM KINGS CROSS", "Dishoom", "Dining", "shared_proportional"),
    "wagamama": ("WAGAMAMA ANGEL", "Wagamama", "Dining", "shared_proportional"),
    "hawksmoor": ("HAWKSMOOR GUILDHALL", "Hawksmoor", "Dining", "shared_proportional"),
    "amazon": ("AMAZON.CO.UK MARKETPLACE", "Amazon", "Shopping:Home", "shared_proportional"),
    "uber": ("UBER *TRIP", "Uber", "Transport:Taxi", "personal"),
    "cineworld": ("CINEWORLD ANGEL", "Cineworld", "Entertainment", "shared_equal"),
    "ms": ("M&S SIMPLY FOOD EUSTON", "M&S", "Groceries", "shared_proportional"),
    "sainsburys": ("SAINSBURYS S/MKTS HOLLOWAY", "Sainsbury's", "Groceries", "shared_proportional"),
    "ocado": ("OCADO RETAIL LTD", "Ocado", "Groceries", "shared_proportional"),
    "boots": ("BOOTS THE CHEMIST 1123", "Boots", "Health:Pharmacy", "secondary_personal"),
    "gails": ("GAILS BAKERY HIGHBURY", "Gail's", "Coffee", "secondary_personal"),
    "uniqlo": ("UNIQLO OXFORD STREET", "Uniqlo", "Shopping:Clothing", "secondary_personal"),
    "johnlewis": ("JOHN LEWIS OXFORD ST", "John Lewis", "Shopping:Home", "shared_proportional"),
    "trainline": ("TRAINLINE.COM", "Trainline", "Transport:Public", "personal"),
    "tesco": ("TESCO STORES 2841", "Tesco", "Groceries", "shared_proportional"),
    "nandos": ("NANDOS HOLLOWAY RD", "Nando's", "Dining", "shared_proportional"),
    "waterstones": ("WATERSTONES PICCADILLY", "Waterstones", "Shopping:Gifts", "primary_personal"),
    "ba": ("BRITISH AIRWAYS 1252", "British Airways", "Travel:Flights", "shared_proportional"),
    "booking": ("BOOKING.COM HOTEL LISBOA", "Booking.com", "Travel:Hotels", "shared_proportional"),
    "timeout": ("TIME OUT MARKET LISBOA", "Time Out Market", "Dining", "shared_proportional"),
    "bolt": ("BOLT.EU LISBOA", "Bolt", "Transport:Taxi", "shared_proportional"),
}

# Deterministic rules (Settings > Rules): a match is auto-approved.
RULES = [
    {"pattern": r"(?i)ACME ANALYTICS.*SALARY", "category": "Income:Salary", "claim_type": "personal", "merchant": "Acme Analytics"},
    {"pattern": r"(?i)NORTHSTAR DESIGN.*SALARY", "category": "Income:Salary", "claim_type": "personal", "merchant": "Northstar Design"},
    {"pattern": r"(?i)HARBOUR\s*LETTINGS", "category": "Housing:Rent", "claim_type": "shared_proportional", "merchant": "Harbour Lettings"},
    {"pattern": r"(?i)COUNCIL\s*TAX", "category": "Bills:CouncilTax", "claim_type": "shared_proportional", "merchant": "Council tax"},
    {"pattern": r"(?i)OCTOPUS\s*ENERGY", "category": "Bills:Energy", "claim_type": "shared_proportional", "merchant": "Octopus Energy"},
    {"pattern": r"(?i)THAMES\s*WATER", "category": "Bills:Water", "claim_type": "shared_proportional", "merchant": "Thames Water"},
    {"pattern": r"(?i)HYPEROPTIC", "category": "Bills:Internet", "claim_type": "shared_proportional", "merchant": "Hyperoptic"},
    {"pattern": r"(?i)LEGAL\s*&?\s*GENERAL", "category": "Insurance:Life", "claim_type": "shared_equal", "merchant": "Legal & General"},
    {"pattern": r"(?i)\bEE LIMITED", "category": "Bills:Phone", "claim_type": "personal", "merchant": "EE"},
    {"pattern": r"(?i)NETFLIX", "category": "Subscriptions:Entertainment", "claim_type": "shared_proportional", "merchant": "Netflix"},
    {"pattern": r"(?i)SPOTIFY", "category": "Subscriptions:Entertainment", "claim_type": "shared_equal", "merchant": "Spotify"},
    {"pattern": r"(?i)APPLE\.COM/BILL", "category": "Subscriptions:Cloud", "claim_type": "shared_proportional", "merchant": "iCloud+"},
    {"pattern": r"(?i)PUREGYM", "category": "Health:Gym", "claim_type": "personal", "merchant": "PureGym"},
    {"pattern": r"(?i)TFL TRAVEL", "category": "Transport:Public", "claim_type": "personal", "merchant": "TfL"},
    {"pattern": r"(?i)PARTNER\s*TRANSFER", "category": "Transfers:Settlement", "claim_type": "personal", "merchant": "Partner settlement"},
    {"pattern": r"(?i)ROBINHOOD", "category": "Transfers:Investment", "claim_type": "personal", "merchant": "Robinhood",
     "is_internal_transfer": True, "transfer_to_account": "acc_invest_robinhood"},
]


# --------------------------------------------------------------------------- #
# Statement lines
# --------------------------------------------------------------------------- #


def money(value: float | Decimal) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def amt(lo: float, hi: float) -> Decimal:
    return money(rng.uniform(lo, hi))


@dataclass
class Line:
    day: date
    raw: str
    amount: Decimal  # negative = money out
    key: str | None = None  # merchant key in M when it needs approving


def month_list(end: date, count: int) -> list[date]:
    out, y, m = [], end.year, end.month
    for _ in range(count):
        out.append(date(y, m, 1))
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return out[::-1]


def on(month: date, day: int) -> date:
    return month.replace(day=min(day, calendar.monthrange(month.year, month.month)[1]))


def spend(lines: list[Line], month: date, key: str, lo: float, hi: float, days: list[int]) -> None:
    for d in days:
        lines.append(Line(on(month, d), M[key][0], -amt(lo, hi), key))


def card_lines(month: date, index: int, holiday: bool, last: bool) -> dict[str, list[Line]]:
    """Every card's purchases for one month (repayments are added separately)."""
    amex: list[Line] = []
    spend(amex, month, "waitrose", 46, 118, sorted(rng.sample(range(2, 29), 4)))
    spend(amex, month, "pret", 3.45, 8.90, sorted(rng.sample(range(1, 29), rng.randint(6, 9))))
    for key in rng.sample(["dishoom", "wagamama", "hawksmoor", "nandos"], 2):
        spend(amex, month, key, 38, 128, [rng.randint(5, 27)])
    spend(amex, month, "amazon", 14, 64, [rng.randint(3, 25)])
    if index % 2:
        spend(amex, month, "uber", 9, 24, [rng.randint(4, 26)])
    if index % 3 == 1:
        spend(amex, month, "cineworld", 21.98, 25.98, [rng.randint(6, 24)])
    amex += [
        Line(on(month, 9), "NETFLIX.COM", Decimal("-15.99")),
        Line(on(month, 11), "SPOTIFY P1A2B3C4", Decimal("-19.99")),
        Line(on(month, 14), "APPLE.COM/BILL", Decimal("-8.99")),
    ]
    if holiday:
        amex += [
            Line(on(month, 3), M["ba"][0], Decimal("-486.20"), "ba"),
            Line(on(month, 3), M["booking"][0], Decimal("-712.40"), "booking"),
            Line(on(month, 19), M["timeout"][0], Decimal("-64.80"), "timeout"),
            Line(on(month, 20), M["bolt"][0], Decimal("-18.35"), "bolt"),
            Line(on(month, 21), M["timeout"][0], Decimal("-52.10"), "timeout"),
        ]
    if last:
        # The receipt the README splits: food for both of them and something for Alex.
        amex.append(Line(on(month, 27), M["ms"][0], Decimal("-10.00"), "ms"))
        amex.append(Line(on(month, 26), M["dishoom"][0], Decimal("-96.40"), "dishoom"))
        amex.append(Line(on(month, 26), M["cineworld"][0], Decimal("-23.98"), "cineworld"))

    supp: list[Line] = []
    spend(supp, month, "sainsburys", 22, 68, sorted(rng.sample(range(2, 29), 2)))
    spend(supp, month, "ocado", 84, 132, [rng.randint(8, 22)])
    spend(supp, month, "gails", 4.20, 9.80, sorted(rng.sample(range(1, 29), rng.randint(3, 5))))
    spend(supp, month, "boots", 7.5, 24, [rng.randint(3, 27)])
    if last:
        supp.append(Line(on(month, 28), M["gails"][0], Decimal("-7.85"), "gails"))
    if index % 2 == 0:
        spend(supp, month, "uniqlo", 29.9, 79.9, [rng.randint(5, 26)])

    virgin: list[Line] = []
    for d in sorted(rng.sample(range(1, 29), rng.randint(9, 13))):
        virgin.append(Line(on(month, d), "TFL TRAVEL CHARGE", -money(rng.choice([2.80, 2.80, 5.60, 8.10, 3.40]))))
    virgin.append(Line(on(month, 2), "PUREGYM LTD", Decimal("-29.99")))
    if index % 2 == 0 or last:
        spend(virgin, month, "johnlewis", 45, 180, [rng.randint(6, 24)])
    if index % 3 == 2:
        spend(virgin, month, "trainline", 24, 72, [rng.randint(4, 20)])
    return {AMEX: amex, AMEX_SUPP: supp, VIRGIN: virgin}


def energy(month: date) -> Decimal:
    by_month = {1: 168, 2: 152, 3: 131, 4: 104, 5: 82, 6: 69, 7: 66, 8: 68, 9: 84, 10: 112, 11: 139, 12: 161}
    return money(by_month[month.month] + rng.uniform(-6, 6))


def hsbc_lines(month: date, partner_payment: Decimal | None, amex_bill: Decimal, virgin_bill: Decimal) -> list[Line]:
    lines = [
        Line(on(month, 1), "HARBOUR LETTINGS RENT", Decimal("-2350.00")),
        Line(on(month, 1), "COUNCIL TAX DD", Decimal("-171.00")),
        Line(on(month, 3), "OCTOPUS ENERGY", -energy(month)),
        Line(on(month, 6), "THAMES WATER", Decimal("-42.50")),
        Line(on(month, 8), "HYPEROPTIC LTD", Decimal("-35.00")),
        Line(on(month, 10), "LEGAL & GENERAL", Decimal("-24.90")),
        Line(on(month, 12), "AMERICAN EXPRESS DD", -amex_bill),
        Line(on(month, 15), "VIRGIN MONEY CC", -virgin_bill),
        Line(on(month, 18), "EE LIMITED", Decimal("-32.00")),
        Line(on(month, 25), "ACME ANALYTICS LTD SALARY", Decimal("4612.40")),
        Line(on(month, 26), "ROBINHOOD SECURITIES", Decimal("-500.00")),
    ]
    if partner_payment is not None and partner_payment > 0:
        lines.append(Line(on(month, 4), "PARTNER TRANSFER SAM", partner_payment))
    return lines


def barclays_lines(month: date, index: int, last: bool) -> list[Line]:
    lines = [
        Line(on(month, 25), "NORTHSTAR DESIGN SALARY", Decimal("3710.55")),
        Line(on(month, 20), "EE LIMITED", Decimal("-28.00")),
    ]
    for d in sorted(rng.sample(range(1, 29), rng.randint(6, 9))):
        lines.append(Line(on(month, d), "TFL TRAVEL CHARGE", -money(rng.choice([2.80, 2.80, 5.60, 3.40]))))
    spend(lines, month, "tesco", 18, 46, sorted(rng.sample(range(2, 29), 2)))
    if index % 2 == 1 or last:
        spend(lines, month, "nandos", 34, 58, [rng.randint(5, 27)])
    if index % 3 == 0 or last:
        spend(lines, month, "waterstones", 12.99, 24.99, [27 if last else rng.randint(4, 25)])
    return lines


def write_csv(path: Path, lines: list[Line], opening: Decimal | None) -> Decimal | None:
    """Bank-style export: Date, Description, Paid Out, Paid In (and Balance on current accounts)."""
    balance = opening
    rows = []
    for line in sorted(lines, key=lambda l: l.day):
        out = f"{-line.amount:.2f}" if line.amount < 0 else ""
        inn = f"{line.amount:.2f}" if line.amount > 0 else ""
        row = [line.day.strftime("%d/%m/%Y"), line.raw, out, inn]
        if balance is not None:
            balance += line.amount
            row.append(f"{balance:.2f}")
        rows.append(row)
    with path.open("w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["Date", "Description", "Paid Out", "Paid In"] + (["Balance"] if opening is not None else []))
        writer.writerows(rows)
    return balance


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main() -> None:
    if not PRIMARY_PASSWORD or not SECONDARY_PASSWORD:
        sys.exit("Set SETTL_PRIMARY_PASSWORD and SETTL_SECONDARY_PASSWORD (and SETTL_URL).")
    alex, sam = Api(PRIMARY_PASSWORD), Api(SECONDARY_PASSWORD)
    if alex.call("GET", "/api/statements"):
        sys.exit("This Settl already has statements: run the seed against a fresh, empty stack.")

    today = date.today()
    end_env = os.environ.get("SETTL_DEMO_END")
    end = date.fromisoformat(end_env + "-01") if end_env else (today.replace(day=1) - timedelta(days=1)).replace(day=1)
    months = month_list(end, MONTHS)
    holiday_index = max(1, len(months) - 4)
    print(f"Seeding {months[0]:%B %Y} to {months[-1]:%B %Y} at {BASE}")

    alex.call("PUT", "/api/settings/household", {
        "users": {
            "primary": {"display_name": "Alex", "base_salary_pa": 78000, "additional_income_pa": 0},
            "secondary": {"display_name": "Sam", "base_salary_pa": 62000, "additional_income_pa": 0},
        },
        "split_strategy": "salary_proportional",
        "settlement_day_of_month": 5,
    })
    alex.call("PUT", "/api/settings/rules", {"rules": RULES})

    tmp = Path(tempfile.mkdtemp(prefix="settl-demo-"))
    hsbc_balance, barclays_balance = Decimal("8240.17"), Decimal("5122.64")
    amex_bill, virgin_bill = Decimal("1186.45"), Decimal("164.30")
    partner_payment: Decimal | None = None
    held_back: list[str] = []
    split_id = note_id = None

    for i, month in enumerate(months):
        last = i == len(months) - 1
        cards = card_lines(month, i, i == holiday_index, last)
        # Card repayments: last month's bill, paid by direct debit from Alex's current account.
        cards[AMEX].append(Line(on(month, 14), "PAYMENT RECEIVED - THANK YOU", amex_bill))
        cards[VIRGIN].append(Line(on(month, 16), "PAYMENT RECEIVED THANK YOU", virgin_bill))
        files = {
            HSBC: hsbc_lines(month, partner_payment, amex_bill, virgin_bill),
            BARCLAYS: barclays_lines(month, i, last),
            **cards,
        }
        names = {HSBC: "hsbc-current", BARCLAYS: "barclays-current", AMEX: "amex-7715",
                 AMEX_SUPP: "amex-3348", VIRGIN: "virgin-5502"}
        for account, lines in files.items():
            path = tmp / f"{names[account]}-{month:%Y-%m}.csv"
            if account == HSBC:
                hsbc_balance = write_csv(path, lines, hsbc_balance)
            elif account == BARCLAYS:
                barclays_balance = write_csv(path, lines, barclays_balance)
            else:
                write_csv(path, lines, None)
            result = alex.upload(path, account)
            if result.get("warnings"):
                print("  warnings:", result["warnings"])
        # Next month's direct debits pay this month's card spend.
        amex_bill = -sum(l.amount for l in cards[AMEX] + cards[AMEX_SUPP] if l.amount < 0)
        virgin_bill = -sum(l.amount for l in cards[VIRGIN] if l.amount < 0)

        # Approve what the rules did not, filing each line the way the household does.
        pending = alex.call("GET", f"/api/transactions?period={month:%Y-%m}&status=pending_review&limit=500")["items"]
        by_raw = {v[0]: (k, v) for k, v in M.items()}
        pending.sort(key=lambda t: (t["transaction_date"], t["raw_description"]))
        hold: set[str] = set()
        if last:
            keep = [t for t in pending if by_raw.get(t["raw_description"], ("",))[0] not in ("ms", "dishoom")]
            # Leave the newest few lines for the Review page, one per merchant where possible.
            seen: set[str] = set()
            for t in reversed(keep):
                if len(hold) >= PENDING_IN_LAST_MONTH:
                    break
                if t["raw_description"] in seen and len(hold) < PENDING_IN_LAST_MONTH - 2:
                    continue
                seen.add(t["raw_description"])
                hold.add(t["id"])
        for t in pending:
            entry = by_raw.get(t["raw_description"])
            if entry is None:
                print("  unknown pending line:", t["raw_description"])
                continue
            key, (raw, merchant, category, claim_type) = entry
            if t["id"] in hold:
                held_back.append(t["id"])
                continue
            if last and key == "ms":
                split_id = t["id"]
                continue
            alex.call("POST", f"/api/transactions/{t['id']}/approve",
                      {"category": category, "claim_type": claim_type, "cleaned_merchant": merchant, "remember": True})
            if last and key == "dishoom" and t["amount"] == "-96.40":
                note_id = t["id"]

        if i == 0:
            # Start the running balance clean: everything before this point was settled up.
            alex.call("POST", "/api/settlement/entries", {
                "kind": "checkpoint", "entry_date": on(month, 31).isoformat(), "amount": "0.00",
                "note": "Settled up before we started using Settl",
            })
        if last:
            alex.call("POST", "/api/settlement/entries", {
                "kind": "payment", "entry_date": on(month, 13).isoformat(), "amount": "60.00",
                "paid_by": SAM, "note": "Cash for the theatre tickets",
            })

        # Sam logs a couple of things paid in cash or on a card Settl does not see.
        claims = [
            (on(month, 7 + i % 5), "Columbia Road flowers", "Flowers for the flat", "15.00", "shared_proportional"),
        ]
        if i % 2 == 0 or last:
            claims.append((on(month, 18), "Window cleaner", "Paid in cash", "25.00", "shared_proportional"))
        if last:
            claims.append((on(month, 23), "Farmers' market", "Veg box and eggs", "18.60", "shared_proportional"))
        for claim_date, merchant, description, amount, claim_type in claims:
            if claim_date <= today:
                sam.call("POST", "/api/claims", {"claim_date": claim_date.isoformat(), "amount": amount,
                                                 "merchant": merchant, "description": description,
                                                 "claim_type": claim_type})
        if not last:
            alex.call("POST", f"/api/settlement/{month:%Y-%m}/mark-settled")

        settlement = alex.call("GET", f"/api/settlement/{month:%Y-%m}")
        owed = Decimal(settlement["balance"]["balance_out"])
        print(f"  {month:%Y-%m}: {len(pending)} lines reviewed, Sam owes Alex {owed}")
        # Sam pays it early next month, rounded to the nearest five pounds (the first month was settled up).
        partner_payment = (owed / 5).quantize(Decimal("1"), rounding=ROUND_HALF_UP) * 5 if i > 0 else None

    # The M&S receipt: food for both of them, flowers for Alex.
    if split_id:
        alex.call("PUT", f"/api/transactions/{split_id}/split", {"parts": [
            {"amount": "-6.00", "category": "Groceries", "claim_type": "shared_proportional"},
            {"amount": "-4.00", "category": "Shopping:Gifts", "claim_type": "personal"},
        ]})
        alex.call("PATCH", f"/api/transactions/{split_id}", {"cleaned_merchant": "M&S"})
        alex.call("PATCH", f"/api/transactions/{split_id}", {"note": "Lunch for the two of us, and flowers for Mum"})
    if note_id:
        alex.call("PATCH", f"/api/transactions/{note_id}", {"note": "Sam's birthday dinner"})

    shutil.rmtree(tmp, ignore_errors=True)

    # Close every month but the newest, as a household that settles monthly would.
    for month in months[:-1]:
        alex.call("POST", f"/api/periods/{month:%Y-%m}/close")

    latest = months[-1].strftime("%Y-%m")
    settlement = alex.call("GET", f"/api/settlement/{latest}")
    print(f"Done: {len(held_back)} lines left to review in {latest}; "
          f"outstanding {settlement['balance']['balance_out']} (positive = Sam owes Alex)")


if __name__ == "__main__":
    main()
