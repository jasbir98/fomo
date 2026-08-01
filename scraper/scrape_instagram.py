#!/usr/bin/env python3
"""
scrape_instagram.py — offline Playwright scraper for Instagram Reels via the
hashtag explore page.

Part of the Roameo `scraper/` ingestion tool. See scraper/README.md for the
full responsible-use disclaimer, ToS/legal caveats, and sanctioned API
fallbacks (Apify, RapidAPI, Instagram Graph API) for when this is blocked.

This drives a REAL, visible-by-default browser using YOUR OWN logged-in
Instagram session, stored in a persistent profile at
scraper/.pw-profile/instagram/. It does NOT automate login, does NOT solve
CAPTCHAs/checkpoints, and does NOT attempt any fingerprint/stealth
bot-detection evasion. If Instagram shows a login wall, an age gate, or a
checkpoint challenge, this script detects it, prints a message, and exits.

`--query` is used as a HASHTAG (spaces/punctuation are stripped), since
Instagram's public explore surface is hashtag-based, not free-text search —
pass something like a destination or place name, e.g. "Tokyo" or "shibuya".

Usage:
    python scraper/scrape_instagram.py --query "Tokyo" --limit 20
    python scraper/scrape_instagram.py --query "kyototravel" --dump-json out.json
    python scraper/scrape_instagram.py --query "shibuya" --headless

First run: use the default (visible) browser window and log into Instagram
normally. The persistent profile remembers the session for later runs.

Selector/approach note: Instagram's hashtag explore grid doesn't expose
caption/like-count/author in the grid DOM itself, so this script visits each
individual reel permalink (up to --limit, with a polite delay before each
visit) and extracts details primarily from the page's `og:description` /
`og:image` meta tags, which historically encode "X likes, Y comments -
username on <date>: "<caption>"" — a more stable extraction point than CSS
classes, but still best-effort. If Instagram changes this format, update
`extract_from_post_page()` below.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

SCRAPER_DIR = Path(__file__).resolve().parent
PROFILE_DIR = SCRAPER_DIR / ".pw-profile" / "instagram"

sys.path.insert(0, str(SCRAPER_DIR))
from upsert_supabase import upsert_reels  # noqa: E402


def parse_count(text: str | None) -> int:
    """Parse Instagram-style counts like '1.2M', '23.4K', '1,234' -> int."""
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
    """Randomized delay between page visits — keep this low-and-slow/polite."""
    time.sleep(random.uniform(a, b))


def to_hashtag(query: str) -> str:
    """Turn a free-text query into an Instagram-safe hashtag (alnum only)."""
    return re.sub(r"[^0-9A-Za-z]", "", query).lower()


def detect_block(page: Page) -> str | None:
    """Best-effort detection of a login wall / age gate / checkpoint challenge.

    Returns a human-readable reason if blocked, else None. Detection only —
    never attempts to dismiss, solve, or route around whatever is shown.
    """
    try:
        url = page.url
        if "accounts/login" in url:
            return "Instagram redirected to the login page (session expired/logged out)."
        if "challenge" in url:
            return "Instagram is showing a checkpoint/challenge page."
        if page.locator("text=/Log in to see photos and videos/i").count() > 0:
            return "Instagram is showing a 'log in to see content' wall."
        if page.locator("text=/Sorry, this page isn.?t available/i").count() > 0:
            return "Instagram returned a 'page not available' error (possibly rate-limited)."
    except Exception:
        pass
    return None


def collect_reel_links(page: Page, hashtag: str, limit: int) -> list[str]:
    """Scroll the hashtag explore grid and collect up to `limit` unique reel shortcodes."""
    url = f"https://www.instagram.com/explore/tags/{hashtag}/"
    page.goto(url, wait_until="domcontentloaded")
    polite_delay()

    block_reason = detect_block(page)
    if block_reason:
        print(f"[instagram] BLOCKED on explore page: {block_reason}")
        return []

    shortcodes: list[str] = []
    seen: set[str] = set()
    max_stall_attempts = 6
    stalls = 0

    while len(shortcodes) < limit and stalls < max_stall_attempts:
        anchors = page.locator('a[href^="/reel/"]')
        count = anchors.count()
        added = 0
        for i in range(count):
            if len(shortcodes) >= limit:
                break
            href = anchors.nth(i).get_attribute("href")
            if not href:
                continue
            match = re.match(r"^/reel/([\w-]+)/?", href)
            if not match:
                continue
            code = match.group(1)
            if code not in seen:
                seen.add(code)
                shortcodes.append(code)
                added += 1

        if len(shortcodes) >= limit:
            break

        stalls = stalls + 1 if added == 0 else 0
        page.mouse.wheel(0, random.randint(1800, 2600))
        polite_delay()

        block_reason = detect_block(page)
        if block_reason:
            print(f"[instagram] BLOCKED mid-scroll: {block_reason}")
            break

    return shortcodes


def extract_from_post_page(page: Page, shortcode: str) -> dict | None:
    """Visit a single reel permalink and extract fields, mainly from meta tags."""
    video_url = f"https://www.instagram.com/reel/{shortcode}/"
    page.goto(video_url, wait_until="domcontentloaded")

    block_reason = detect_block(page)
    if block_reason:
        print(f"[instagram] BLOCKED on {video_url}: {block_reason}")
        return None

    thumbnail_url = None
    try:
        og_image = page.locator('meta[property="og:image"]')
        if og_image.count() > 0:
            thumbnail_url = og_image.first.get_attribute("content")
    except Exception:
        pass

    caption = None
    likes = 0
    author_handle = None

    # Instagram's og:description historically looks like:
    #   "1,234 likes, 56 comments - some_user on January 1, 2026: "caption text""
    # This is best-effort — if IG changes the format, this regex will simply
    # fail to match and we fall back to DOM selectors below.
    try:
        og_desc = page.locator('meta[property="og:description"]')
        if og_desc.count() > 0:
            desc_text = og_desc.first.get_attribute("content") or ""
            match = re.match(
                r'^([\d,.]+[KMB]?)\s+likes?,\s*[\d,.]+[KMB]?\s+comments?\s*-\s*([\w.\-]+)\s+on\s+.*?:\s*"?(.*?)"?$',
                desc_text,
            )
            if match:
                likes = parse_count(match.group(1))
                author_handle = match.group(2)
                caption = match.group(3).strip() or None
    except Exception:
        pass

    if not author_handle:
        try:
            header_link = page.locator("header a[role='link']").first
            if header_link.count() > 0:
                href = header_link.get_attribute("href") or ""
                handle_match = re.match(r"^/([\w.\-]+)/?", href)
                if handle_match:
                    author_handle = handle_match.group(1)
        except Exception:
            pass

    if not caption:
        try:
            title = page.title()
            # Titles are often "<caption or username> • Instagram Reel"
            if title and "Instagram" in title:
                caption = title.split("•")[0].strip() or None
        except Exception:
            pass

    return {
        "platform": "instagram",
        "video_url": video_url,
        "thumbnail_url": thumbnail_url,
        "author_handle": author_handle,
        "caption": caption,
        "likes": likes,
    }


def search_and_extract(page: Page, query: str, limit: int) -> list[dict]:
    """Search Instagram (via hashtag explore) for `query` on an already-open
    `page` and collect up to `limit` reels. Does not launch or close a
    browser context — callers own that (either `scrape_instagram()` below for
    a one-off run, or the batch runner for a persistent context reused across
    many queries).
    """
    hashtag = to_hashtag(query)
    print(f"[instagram] searching #{hashtag} (from query '{query}', limit={limit})")

    shortcodes = collect_reel_links(page, hashtag, limit)
    print(f"[instagram] found {len(shortcodes)} candidate reel(s), visiting each for details")

    collected: list[dict] = []
    for shortcode in shortcodes:
        polite_delay()
        try:
            reel = extract_from_post_page(page, shortcode)
        except Exception as exc:
            print(f"  [warn] failed to extract reel/{shortcode}: {exc}", file=sys.stderr)
            continue
        if reel is None:
            # extract_from_post_page already printed a block reason —
            # stop visiting further posts rather than hammering a block.
            break
        if not reel.get("video_url"):
            continue
        collected.append(reel)

    print(f"[instagram] collected {len(collected)} reel(s) for '{query}'")
    return collected


def scrape_instagram(query: str, limit: int, headless: bool) -> list[dict]:
    print(f"[instagram] preparing search for '{query}' (limit={limit}, headless={headless})")
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
        description="Scrape Instagram Reels (via hashtag explore) into Roameo social_posts rows."
    )
    parser.add_argument(
        "--query",
        required=True,
        help="Keyword/location to search as an Instagram hashtag (spaces/punctuation stripped).",
    )
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
    reels = scrape_instagram(args.query, args.limit, args.headless)

    for reel in reels:
        reel["destination"] = destination
        reel["location"] = destination

    if args.dump_json:
        Path(args.dump_json).write_text(json.dumps(reels, indent=2, ensure_ascii=False))
        print(f"[instagram] wrote {len(reels)} reel(s) to {args.dump_json} (skipped Supabase upsert)")
        return

    if not reels:
        print("[instagram] nothing to upsert.")
        return

    upsert_reels(reels)


if __name__ == "__main__":
    main()
