#!/usr/bin/env python3
"""
scrape_tiktok.py — offline Playwright scraper for TikTok search results.

Part of the Roameo `scraper/` ingestion tool. See scraper/README.md for the
full responsible-use disclaimer, ToS/legal caveats, and sanctioned API
fallbacks (Apify, RapidAPI, TikTok Display API) for when this is blocked.

This drives a REAL, visible-by-default browser using YOUR OWN logged-in
TikTok session, stored in a persistent profile at scraper/.pw-profile/tiktok/.
It does NOT automate login, does NOT solve CAPTCHAs, and does NOT attempt any
fingerprint/stealth bot-detection evasion. If TikTok shows a login wall or a
CAPTCHA, this script detects it, prints a message, and exits.

Usage:
    python scraper/scrape_tiktok.py --query "Tokyo" --limit 20
    python scraper/scrape_tiktok.py --query "kyoto travel" --dump-json out.json
    python scraper/scrape_tiktok.py --query "shibuya" --headless

First run: use the default (visible) browser window and log into TikTok
normally in that window. The persistent profile remembers the session for
subsequent runs, including `--headless` ones.

Selector note: the `data-e2e` attributes below are TikTok's search-result
markup at the time this was written. TikTok changes its DOM fairly often —
if extraction starts returning 0 reels, re-run with --no-headless, open
devtools on a search results page, and update the selectors in
`extract_reels()` below.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

from playwright.sync_api import Page, sync_playwright

SCRAPER_DIR = Path(__file__).resolve().parent
PROFILE_DIR = SCRAPER_DIR / ".pw-profile" / "tiktok"

sys.path.insert(0, str(SCRAPER_DIR))
from upsert_supabase import upsert_reels  # noqa: E402


def parse_count(text: str | None) -> int:
    """Parse TikTok-style counts like '1.2M', '23.4K', '1,234' -> int.

    Falls back to stripping non-digits if the K/M/B suffix pattern doesn't
    match (e.g. plain '842'). Returns 0 for empty/unparseable input.
    """
    if not text:
        return 0
    cleaned = text.strip().upper().replace(",", "")
    match = re.match(r"^([\d.]+)\s*([KMB])?$", cleaned)
    if not match:
        digits = re.sub(r"[^\d]", "", cleaned)
        return int(digits) if digits else 0
    number, suffix = match.groups()
    try:
        value = float(number)
    except ValueError:
        return 0
    multiplier = {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000}.get(suffix or "", 1)
    return int(value * multiplier)


def polite_delay(a: float = 2.0, b: float = 5.0) -> None:
    """Randomized delay between scroll/extraction steps — keep this low-and-slow."""
    time.sleep(random.uniform(a, b))


def detect_block(page: Page) -> str | None:
    """Best-effort detection of a login wall / CAPTCHA / interstitial.

    Returns a human-readable reason if blocked, else None. This function only
    DETECTS — callers are expected to print the reason and stop, never to try
    to dismiss/solve/bypass whatever is shown.
    """
    try:
        if page.locator('div[data-e2e="modal-login-title"]').count() > 0:
            return "TikTok is showing a login modal (session may be logged out/expired)."
        if page.locator('iframe[src*="captcha"]').count() > 0:
            return "TikTok is showing a CAPTCHA iframe."
        if page.locator("text=/verify.*human/i").count() > 0:
            return "TikTok is showing a bot-verification challenge."
        if page.locator("text=/Something went wrong/i").count() > 0:
            return "TikTok returned an error/interstitial page."
    except Exception:
        # A failure in the check itself isn't a block — let extraction proceed
        # and fail safely per-item instead.
        pass
    return None


def extract_reels(page: Page, limit: int) -> list[dict]:
    """Extract up to `limit` reels currently rendered on the search page.

    Best-effort selectors — see module docstring. Every card is wrapped in
    its own try/except so one malformed card can't abort the whole batch.
    """
    reels: dict[str, dict] = {}

    cards = page.locator(
        'div[data-e2e="search_video-item"], div[data-e2e="search-card-video-container"]'
    )
    count = cards.count()

    for i in range(count):
        if len(reels) >= limit:
            break
        card = cards.nth(i)
        try:
            link = card.locator("a").first
            href = link.get_attribute("href") if link.count() > 0 else None
            if not href:
                continue

            match = re.search(r"(https?://www\.tiktok\.com/@[\w.\-]+/video/\d+)", href)
            if not match:
                continue
            video_url = match.group(1)
            if video_url in reels:
                continue

            author_match = re.search(r"@([\w.\-]+)/video", video_url)
            author_handle = author_match.group(1) if author_match else None

            thumbnail_url = None
            img = card.locator("img").first
            if img.count() > 0:
                thumbnail_url = img.get_attribute("src")

            caption = None
            try:
                desc = card.locator('[data-e2e="search-card-desc"]')
                if desc.count() > 0:
                    caption = desc.first.inner_text().strip() or None
                elif img.count() > 0:
                    alt = img.get_attribute("alt")
                    caption = alt.strip() if alt else None
            except Exception:
                pass

            likes = 0
            try:
                like_el = card.locator(
                    'strong[data-e2e="video-count"], [data-e2e="search-card-like-count"]'
                )
                if like_el.count() > 0:
                    likes = parse_count(like_el.first.inner_text())
            except Exception:
                pass

            reels[video_url] = {
                "platform": "tiktok",
                "video_url": video_url,
                "thumbnail_url": thumbnail_url,
                "author_handle": author_handle,
                "caption": caption,
                "likes": likes,
            }
        except Exception as exc:
            print(f"  [warn] skipped a card during extraction: {exc}", file=sys.stderr)
            continue

    return list(reels.values())


def search_and_extract(page: Page, query: str, limit: int) -> list[dict]:
    """Search TikTok for `query` on an already-open `page` and collect up to
    `limit` reels. Does not launch or close a browser context — callers own
    that (either `scrape_tiktok()` below for a one-off run, or the batch
    runner for a persistent context reused across many queries).
    """
    search_url = f"https://www.tiktok.com/search/video?q={quote(query)}"
    page.goto(search_url, wait_until="domcontentloaded")
    polite_delay()

    block_reason = detect_block(page)
    if block_reason:
        print(f"[tiktok] BLOCKED: {block_reason}")
        print(
            "[tiktok] Not attempting to bypass this. If it's a login wall, re-run with "
            "--no-headless once and log in manually in the browser window that opens — "
            "the persistent profile remembers it next time. See scraper/README.md for "
            "sanctioned fallbacks (Apify, RapidAPI, TikTok Display API) if scraping stays blocked."
        )
        return []

    collected: list[dict] = []
    seen_urls: set[str] = set()
    max_stall_attempts = 6
    stalls = 0

    while len(collected) < limit and stalls < max_stall_attempts:
        batch = extract_reels(page, limit=limit * 2)
        added = 0
        for reel in batch:
            if reel["video_url"] not in seen_urls:
                seen_urls.add(reel["video_url"])
                collected.append(reel)
                added += 1
            if len(collected) >= limit:
                break

        if len(collected) >= limit:
            break

        stalls = stalls + 1 if added == 0 else 0

        page.mouse.wheel(0, random.randint(1800, 2600))
        polite_delay()

        block_reason = detect_block(page)
        if block_reason:
            print(f"[tiktok] BLOCKED mid-scroll: {block_reason}")
            break

    collected = collected[:limit]
    print(f"[tiktok] collected {len(collected)} reel(s) for '{query}'")
    return collected


def scrape_tiktok(query: str, limit: int, headless: bool) -> list[dict]:
    print(f"[tiktok] searching for '{query}' (limit={limit}, headless={headless})")
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=headless,
            viewport={"width": 1280, "height": 900},
        )
        page = context.new_page()
        collected = search_and_extract(page, query, limit)
        context.close()
        return collected


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scrape TikTok search results into Roameo social_posts rows."
    )
    parser.add_argument("--query", required=True, help="Keyword, hashtag, or location to search TikTok for.")
    parser.add_argument("--limit", type=int, default=20, help="Max reels to collect (default: 20).")
    parser.add_argument(
        "--destination",
        default=None,
        help="Trip destination to tag rows with (defaults to --query).",
    )
    parser.add_argument("--headless", dest="headless", action="store_true", help="Run the browser headless.")
    parser.add_argument(
        "--no-headless",
        dest="headless",
        action="store_false",
        help="Show the browser window (default — needed for first-run login).",
    )
    parser.set_defaults(headless=False)
    parser.add_argument(
        "--dump-json",
        metavar="PATH",
        help="Write results to this JSON file instead of upserting to Supabase.",
    )
    args = parser.parse_args()

    destination = args.destination or args.query
    reels = scrape_tiktok(args.query, args.limit, args.headless)

    for reel in reels:
        reel["destination"] = destination
        reel["location"] = destination

    if args.dump_json:
        Path(args.dump_json).write_text(json.dumps(reels, indent=2, ensure_ascii=False))
        print(f"[tiktok] wrote {len(reels)} reel(s) to {args.dump_json} (skipped Supabase upsert)")
        return

    if not reels:
        print("[tiktok] nothing to upsert.")
        return

    upsert_reels(reels)


if __name__ == "__main__":
    main()
