#!/usr/bin/env python3
"""Capture the README screenshots from a running, seeded Settl (see seed.py).

    pip install playwright pillow   # Pillow is optional: it only shrinks the PNGs
    SETTL_URL=http://127.0.0.1 \
    SETTL_PRIMARY_PASSWORD=... SETTL_SECONDARY_PASSWORD=... \
    python3 shoot.py [output_dir]

Writes into docs/images/ by default. Uses the installed Google Chrome when there is
one, else Playwright's own Chromium (`playwright install chromium`).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from playwright.sync_api import Browser, Page, sync_playwright

BASE = os.environ.get("SETTL_URL", "http://127.0.0.1").rstrip("/")
PRIMARY_PASSWORD = os.environ.get("SETTL_PRIMARY_PASSWORD", "")
SECONDARY_PASSWORD = os.environ.get("SETTL_SECONDARY_PASSWORD", "")
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "docs" / "images"
DESKTOP = {"width": 1440, "height": 900}
PHONE = {"width": 390, "height": 844}
PAD = 16  # breathing room around cropped elements, in CSS pixels


def launch(p) -> Browser:
    try:
        return p.chromium.launch(channel="chrome")
    except Exception:  # Chrome not installed: fall back to the bundled Chromium
        return p.chromium.launch()


def new_page(browser: Browser, theme: str = "light", viewport: dict = DESKTOP, scale: int = 2) -> Page:
    context = browser.new_context(viewport=viewport, device_scale_factor=scale, locale="en-GB",
                                  reduced_motion="reduce", color_scheme=theme)
    context.add_init_script(
        f"try {{ localStorage.setItem('pf.theme', '{theme}');"
        " localStorage.setItem('settl.tip.claim-types', 'seen');"
        " localStorage.setItem('pf.view', 'macro'); } catch (e) {}"
    )
    return context.new_page()


def settle(page: Page, ms: int = 800) -> None:
    page.wait_for_load_state("networkidle")
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(ms)


def login(page: Page, password: str) -> None:
    page.goto(BASE + "/login")
    page.fill("#password", password)
    page.keyboard.press("Enter")
    page.wait_for_url(lambda url: not url.endswith("/login"))
    settle(page)


def go(page: Page, path: str) -> None:
    page.goto(BASE + path)
    settle(page, 1200)


def shot_clip(page: Page, name: str, x: float, y: float, width: float, height: float) -> None:
    page.screenshot(path=str(OUT / name), full_page=True,
                    clip={"x": max(0, x), "y": max(0, y), "width": width, "height": height})
    print("  wrote", name)


def box(page: Page, selector: str) -> dict:
    b = page.locator(selector).first.bounding_box()
    assert b, f"{selector} is not on the page"
    scroll = page.evaluate("({x: window.scrollX, y: window.scrollY})")
    return {"x": b["x"] + scroll["x"], "y": b["y"] + scroll["y"], "width": b["width"], "height": b["height"]}


def element(page: Page, selector: str, name: str, pad: int = PAD) -> None:
    b = box(page, selector)
    shot_clip(page, name, b["x"] - pad, b["y"] - pad, b["width"] + 2 * pad, b["height"] + 2 * pad)


def dashboard_top(page: Page, name: str) -> None:
    """The first screen of the dashboard: header, headline card and By category, cut between two category rows."""
    page.evaluate("window.scrollTo(0, 0)")
    limit = DESKTOP["height"] - 90  # stays clear of the account footer at the bottom of the sidebar
    bottoms = [b["y"] + b["height"] for b in
               (li.bounding_box() for li in page.locator('section[aria-label="By category"] li').all()) if b]
    fitting = [b for b in bottoms if b <= limit]
    height = (fitting[-1] + 12) if fitting else DESKTOP["height"]
    page.screenshot(path=str(OUT / name), clip={"x": 0, "y": 0, "width": DESKTOP["width"], "height": height})
    print("  wrote", name)


def rows_clip(page: Page, card_selector: str, row_selector: str, rows: int, name: str) -> None:
    """A card cropped after its n-th row."""
    card = box(page, card_selector)
    row = page.locator(row_selector).nth(rows - 1)
    row_box = row.bounding_box()
    scroll_y = page.evaluate("window.scrollY")
    bottom = row_box["y"] + scroll_y + row_box["height"]
    shot_clip(page, name, card["x"] - PAD, card["y"] - PAD, card["width"] + 2 * PAD, bottom - card["y"] + PAD)


def main() -> None:
    if not PRIMARY_PASSWORD or not SECONDARY_PASSWORD:
        sys.exit("Set SETTL_PRIMARY_PASSWORD and SETTL_SECONDARY_PASSWORD (and SETTL_URL).")
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = launch(p)

        page = new_page(browser)
        go(page, "/login")
        page.locator("#password").blur()
        page.screenshot(path=str(OUT / "login.png"))
        print("  wrote login.png")

        login(page, PRIMARY_PASSWORD)
        go(page, "/")
        dashboard_top(page, "dashboard.png")
        element(page, 'section[aria-label="Settlement"]', "settlement.png")

        go(page, "/review")
        rows_clip(page, "section#approval-queue", 'section#approval-queue tbody tr:has(button[aria-label^="Approve "])',
                  6, "queue.png")

        # The category picker open on the Waitrose line: Suggested, Most used, then every group.
        row_selector = 'section#approval-queue tbody tr:has(button[aria-label="Category for Waitrose"])'
        # Bring the row near the top so the menu opens downwards, under it.
        page.evaluate(
            "(sel) => { const r = document.querySelector(sel).getBoundingClientRect();"
            " window.scrollBy(0, r.top - 120); }",
            row_selector,
        )
        page.wait_for_timeout(300)
        page.get_by_role("button", name="Category for Waitrose").click()
        page.wait_for_selector('[role="listbox"][aria-label="Categories"]')
        page.wait_for_timeout(600)
        menu = page.evaluate(
            """() => {
                let el = document.querySelector('[role="listbox"][aria-label="Categories"]');
                while (el && !['fixed', 'absolute'].includes(getComputedStyle(el).position)) el = el.parentElement;
                const r = el.getBoundingClientRect();
                return {x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height};
            }"""
        )
        row = box(page, row_selector)
        top = min(row["y"] + 1, menu["y"] - PAD)
        bottom = max(row["y"] + row["height"], menu["y"] + menu["height"] + PAD)
        shot_clip(page, "category-picker.png", row["x"], top, row["width"], bottom - top)
        page.keyboard.press("Escape")

        go(page, "/transactions?period=" + latest_period(page) + "&account_id=acc_cc_amex&include_transfers=false")
        rows_clip(page, 'section[aria-label="Results"]', 'section[aria-label="Results"] tbody tr', 9, "transactions.png")

        page.get_by_role("button", name="Edit split for M&S").first.click()
        page.wait_for_selector('[role="dialog"]')
        page.wait_for_timeout(600)
        page.evaluate("document.activeElement && document.activeElement.blur()")
        page.wait_for_timeout(200)
        element(page, '[role="dialog"]', "split.png", pad=0)
        page.keyboard.press("Escape")

        go(page, "/settings?tab=accounts")
        panel = box(page, '[role="tabpanel"]')
        shot_clip(page, "settings.png", 0, 0, DESKTOP["width"], panel["y"] + panel["height"] + 32)
        page.context.close()

        dark = new_page(browser, theme="dark")
        login(dark, PRIMARY_PASSWORD)
        go(dark, "/")
        dashboard_top(dark, "dark.png")
        dark.context.close()

        phone = new_page(browser, viewport=PHONE, scale=2)
        login(phone, SECONDARY_PASSWORD)
        go(phone, "/claim")
        # A claim half typed, as Sam would on the way home.
        phone.locator("#claim-amount").fill("24.50")
        phone.locator("#claim-merchant").fill("Window cleaner")
        phone.locator("#claim-description").fill("Paid in cash")
        phone.evaluate("document.activeElement && document.activeElement.blur()")
        phone.wait_for_timeout(300)
        phone.screenshot(path=str(OUT / "claim-mobile.png"))
        print("  wrote claim-mobile.png")
        phone.context.close()
        browser.close()
    optimise(OUT)


def latest_period(page: Page) -> str:
    return page.evaluate(
        """async () => {
            const s = JSON.parse(localStorage.getItem('pf.session'));
            const r = await fetch('/api/periods', {headers: {Authorization: 'Bearer ' + s.token}});
            const periods = await r.json();
            return periods.map(p => p.period_key).sort().pop();
        }"""
    )


def optimise(directory: Path) -> None:
    """Re-save the PNGs losslessly with zlib's best effort, when Pillow is installed."""
    try:
        from PIL import Image
    except ImportError:
        return
    for path in sorted(directory.glob("*.png")):
        before = path.stat().st_size
        trial = path.with_suffix(".tmp.png")
        with Image.open(path) as image:
            image.load()
            image.save(trial, optimize=True)
        if trial.stat().st_size < before:
            trial.replace(path)
        else:
            trial.unlink()
        print(f"  {path.name}: {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
