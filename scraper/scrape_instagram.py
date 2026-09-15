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

Grid pre-filtering: hashtag grids are mostly photos (Instagram doesn't offer
a "reels only" hashtag view), and visiting every tile just to discard photos
wastes page loads and inflates the "empty" streak that trips the batch
runner's cool-off. `collect_reel_links()` classifies each tile from the grid
DOM alone (href shape + icon overlay — see `classify_tile_html()`) so photos
can be skipped without ever being opened. Update `classify_tile_html()` if
Instagram changes these grid-level signals.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from dataclasses import dataclass, field
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
    """Turn a free-text query into an Instagram-safe hashtag (alnum only).

    For Edinburgh --city mode: the query is already a place name, and we
    search by the bare name as a hashtag (e.g. #thegolftavern).
    """
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
        if page.locator("text=/Page isn.?t available/i").count() > 0:
            return "Instagram returned a 'page isn't available' error (possibly rate-limited)."
        if page.locator("text=/content isn.?t available/i").count() > 0:
            return "Instagram returned a 'content isn't available' error (possibly rate-limited)."
    except Exception:
        pass
    return None


# Matches /p/<code>/, /reel/<code>/, /reels/<code>/, /tv/<code>/, optionally
# prefixed with a username segment (e.g. /someuser/reel/<code>/) and/or the
# full https://www.instagram.com origin. Query strings (e.g. ?img_index=1)
# are ignored since the regex only anchors on the path.
POST_LINK_RE = re.compile(
    r"^(?:https://www\.instagram\.com)?/(?:[\w.]+/)?(?:p|reels?|tv)/([\w-]+)"
)

# Hard caps on how long we'll scroll/inspect the grid hunting for reel
# candidates. A sparse or photo-heavy hashtag shouldn't turn into an
# unbounded scroll marathon — past these, work with whatever was found.
MAX_GRID_SCROLLS = 8
MAX_GRID_TILES = 60

# Icon aria-labels Instagram overlays on grid tiles — the only signal besides
# the href shape available without opening the post. Best-effort/observed,
# like everything else here; if Instagram changes these, update
# `classify_tile_html()`.
VIDEO_ICON_RE = re.compile(r"clip|reel|video", re.I)
PHOTO_ICON_RE = re.compile(r"carousel|album|multiple images|multiple photos", re.I)


def classify_tile_html(html: str | None) -> str:
    """Classify one grid tile's outer HTML as "reel", "photo", or "unknown"
    — WITHOUT visiting the post. Lets `collect_reel_links()` skip the
    photo-heavy bulk of a hashtag grid instead of opening every tile.

    Signals, most specific first:
      1. An href to /reel/ or /reels/ -> definite reel.
      2. A clip/video icon overlay (aria-label containing "Clip", "Reel" or
         "Video") -> reel candidate even under a /p/ href, since Instagram
         also serves plain in-feed video posts and IGTV that way.
      3. A carousel/album icon overlay -> definite photo (multi-image post,
         no video signal).
      4. A bare /p/ href with no icon at all -> photo. Instagram always
         overlays an icon on video/carousel tiles, so an undecorated tile is
         a plain single photo.
      5. Anything else (href missing/unrecognised, icon unreadable) ->
         "unknown", left for the caller to visit as a last resort.

    Pure/offline on purpose so it can be unit-tested against hand-written
    tile HTML — the real scan only ever calls it with a tile's outerHTML.
    """
    if not html:
        return "unknown"
    href_match = re.search(r'href=["\']([^"\']+)', html)
    href = href_match.group(1) if href_match else ""
    if re.search(r"/reels?/[\w-]+", href):
        return "reel"
    icon_labels = " ".join(re.findall(r'aria-label=["\']([^"\']*)["\']', html))
    if VIDEO_ICON_RE.search(icon_labels):
        return "reel"
    if PHOTO_ICON_RE.search(icon_labels):
        return "photo"
    if re.search(r"/p/[\w-]+", href):
        return "photo"
    return "unknown"


@dataclass
class GridScan:
    """What `collect_reel_links()` found on the hashtag explore grid, before
    any individual post was visited."""

    reel_candidates: list[str] = field(default_factory=list)
    unknown_candidates: list[str] = field(default_factory=list)
    photo_count: int = 0
    total_tiles: int = 0
    blocked_reason: str | None = None


def collect_reel_links(page: Page, hashtag: str, limit: int) -> GridScan:
    """Scroll the hashtag explore grid, classifying each tile as it appears
    (see `classify_tile_html()`) so photos are skipped without ever being
    opened. Keeps scrolling until `limit` reel candidates are found, or
    MAX_GRID_SCROLLS/MAX_GRID_TILES caps out, or the grid stalls (stops
    producing new tiles)."""
    url = f"https://www.instagram.com/explore/tags/{hashtag}/"
    page.goto(url, wait_until="domcontentloaded")

    scan = GridScan()

    try:
        page.wait_for_selector('a[href*="/p/"], a[href*="/reel/"]', timeout=15000)
    except Exception:
        block_reason = detect_block(page)
        if block_reason:
            scan.blocked_reason = block_reason
            print(f"[instagram] BLOCKED on explore page: {block_reason}")
        else:
            print(f"[instagram] no post links found on explore page (final url: {page.url})")
        return scan

    polite_delay()

    block_reason = detect_block(page)
    if block_reason:
        scan.blocked_reason = block_reason
        print(f"[instagram] BLOCKED on explore page: {block_reason}")
        return scan

    seen: set[str] = set()
    max_stall_attempts = 6
    stalls = 0
    scrolls = 0

    while True:
        anchors = page.locator('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]')
        count = anchors.count()
        added = 0
        for i in range(count):
            if scan.total_tiles >= MAX_GRID_TILES:
                break
            anchor = anchors.nth(i)
            href = anchor.get_attribute("href")
            if not href:
                continue
            match = POST_LINK_RE.match(href)
            if not match:
                continue
            code = match.group(1)
            if code in seen:
                continue
            seen.add(code)
            scan.total_tiles += 1
            added += 1

            try:
                tile_html = anchor.evaluate("el => el.outerHTML")
            except Exception:
                tile_html = href  # still lets the href-based signal work

            kind = classify_tile_html(tile_html)
            if kind == "reel":
                scan.reel_candidates.append(code)
            elif kind == "photo":
                scan.photo_count += 1
            else:
                scan.unknown_candidates.append(code)

        if len(scan.reel_candidates) >= limit or scan.total_tiles >= MAX_GRID_TILES:
            break

        stalls = stalls + 1 if added == 0 else 0
        scrolls += 1
        if stalls >= max_stall_attempts or scrolls >= MAX_GRID_SCROLLS:
            break

        page.mouse.wheel(0, random.randint(1800, 2600))
        polite_delay()

        block_reason = detect_block(page)
        if block_reason:
            scan.blocked_reason = block_reason
            print(f"[instagram] BLOCKED mid-scroll: {block_reason}")
            break

    return scan


def extract_from_post_page(page: Page, shortcode: str) -> dict | None:
    """Visit a single post permalink (works for photos and reels/videos alike)
    and extract fields, mainly from meta tags.

    Returns a dict with `video_url: None` when the post is not a video (the
    caller filters those out) — NOT `None`, since `None` from this function
    means "blocked" to the caller (`search_and_extract` stops visiting
    further posts when it sees `None`, to avoid hammering a block).
    """
    post_url = f"https://www.instagram.com/p/{shortcode}/"
    page.goto(post_url, wait_until="domcontentloaded")

    try:
        page.wait_for_selector('meta[property="og:type"], video', timeout=5000)
    except Exception:
        pass

    block_reason = detect_block(page)
    if block_reason:
        print(f"[instagram] BLOCKED on {post_url}: {block_reason}")
        return None

    is_video = False
    try:
        og_type = page.locator('meta[property="og:type"]')
        if og_type.count() > 0:
            type_content = (og_type.first.get_attribute("content") or "").lower()
            if "video" in type_content:
                is_video = True
    except Exception:
        pass

    if not is_video:
        try:
            if (
                page.locator('meta[property="og:video"]').count() > 0
                or page.locator('meta[property="og:video:secure_url"]').count() > 0
            ):
                is_video = True
        except Exception:
            pass

    if not is_video:
        try:
            if page.locator("video").count() > 0:
                is_video = True
        except Exception:
            pass

    if not is_video:
        try:
            if "/reel/" in page.url:
                is_video = True
            else:
                canonical = page.locator('link[rel="canonical"]')
                if canonical.count() > 0:
                    canonical_href = canonical.first.get_attribute("href") or ""
                    if "/reel/" in canonical_href:
                        is_video = True
        except Exception:
            pass

    if not is_video:
        return {
            "platform": "instagram",
            "video_url": None,
            "thumbnail_url": None,
            "author_handle": None,
            "caption": None,
            "likes": 0,
        }

    # Keep this exact canonical form — the DB dedupes on video_url and
    # existing rows use it.
    video_url = f"https://www.instagram.com/reel/{shortcode}/"

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
    # ...but variants exist too: singular "1 like"/"1 comment", counts
    # omitted entirely, or the leading "likes, comments -" clause missing
    # altogether. Try each pattern in order (most-specific first) and fall
    # back to DOM selectors below if none match — best-effort throughout.
    OG_DESC_PATTERNS = [
        # "1,234 likes, 56 comments - user on <date>: "caption""
        r'^([\d,.]+[KMB]?)\s+[Ll]ikes?,\s*[\d,.]+[KMB]?\s+[Cc]omments?\s*-\s*([\w.\-]+)\s+on\s+.*?:\s*"?(.*?)"?$',
        # "1,234 likes - user on <date>: "caption"" (no comment count)
        r'^([\d,.]+[KMB]?)\s+[Ll]ikes?\s*-\s*([\w.\-]+)\s+on\s+.*?:\s*"?(.*?)"?$',
        # "user on <date>: "caption"" (no like/comment counts at all)
        r'^()([\w.\-]+)\s+on\s+.*?:\s*"?(.*?)"?$',
    ]
    try:
        og_desc = page.locator('meta[property="og:description"]')
        if og_desc.count() > 0:
            desc_text = og_desc.first.get_attribute("content") or ""
            for pattern in OG_DESC_PATTERNS:
                match = re.match(pattern, desc_text)
                if match:
                    likes_group, author_group, caption_group = match.groups()
                    likes = parse_count(likes_group) if likes_group else 0
                    author_handle = author_group
                    caption = caption_group.strip() or None
                    break
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


class ReelResults(list):
    """list[dict] of scraped reels, plus a `grid_had_tiles` flag so the batch
    runner's cool-off heuristic (scrape_places_batch.py) can tell "the grid
    was genuinely empty or blocked" apart from "the grid had tiles, they
    just weren't reels" — only the former is a real block signal. Always set
    explicitly below before this is returned; the batch runner's own
    `getattr(..., False)` default is what keeps a plain list (e.g. from
    another platform's search_and_extract, which knows nothing about this
    attribute) on today's behaviour.
    """

    grid_had_tiles: bool = False


def search_and_extract(page: Page, query: str, limit: int) -> ReelResults:
    """Search Instagram (via hashtag explore) for `query` on an already-open
    `page` and collect up to `limit` reels. Does not launch or close a
    browser context — callers own that (either `scrape_instagram()` below for
    a one-off run, or the batch runner for a persistent context reused across
    many queries).
    """
    hashtag = to_hashtag(query)
    print(f"[instagram] searching #{hashtag} (from query '{query}', limit={limit})")

    scan = collect_reel_links(page, hashtag, limit)

    if scan.blocked_reason:
        result = ReelResults()
        result.grid_had_tiles = False
        return result

    fallback_needed = max(0, limit - len(scan.reel_candidates))
    fallback_used = scan.unknown_candidates[:fallback_needed]
    candidates = scan.reel_candidates + fallback_used

    fallback_note = (
        f", {len(fallback_used)} unclassified tile(s) held as a last-resort fallback"
        if fallback_used
        else ""
    )
    print(
        f"[instagram] found {scan.total_tiles} tile(s) -> {len(scan.reel_candidates)} reel "
        f"candidate(s) ({scan.photo_count} photo(s) skipped without visiting{fallback_note})"
    )

    collected: list[dict] = []
    skipped_non_video = 0
    for shortcode in candidates:
        if len(collected) >= limit:
            break
        polite_delay()
        try:
            reel = extract_from_post_page(page, shortcode)
        except Exception as exc:
            print(f"  [warn] failed to extract post/{shortcode}: {exc}", file=sys.stderr)
            continue
        if reel is None:
            # extract_from_post_page already printed a block reason —
            # stop visiting further posts rather than hammering a block.
            break
        if not reel.get("video_url"):
            skipped_non_video += 1
            continue
        collected.append(reel)

    print(
        f"[instagram] collected {len(collected)} reel(s) "
        f"(skipped {skipped_non_video} non-video post(s)) for '{query}'"
    )

    result = ReelResults(collected)
    # Grid had real content (some kind of tile) even if none of it panned
    # out as a reel — that's not a block signal, see ReelResults docstring.
    result.grid_had_tiles = scan.total_tiles > 0
    return result


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
