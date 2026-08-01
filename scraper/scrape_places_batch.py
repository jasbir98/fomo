#!/usr/bin/env python3
"""
scrape_places_batch.py — run scrape_tiktok/scrape_instagram over a whole list
of places, ONE browser session per platform for the entire run, with real
login handling, adaptive pacing, local backup of everything scraped, and
resumable progress.

Part of the Roameo `scraper/` ingestion tool — see scraper/README.md for the
full responsible-use disclaimer (this inherits the same rules: no CAPTCHA
solving, no fingerprint/stealth evasion, your own logged-in session only).

Login
-----
Login is handled by browser_session.py, which by default drives your REAL
Google Chrome over CDP instead of Playwright's bundled Chromium — the bundled
build is where TikTok's phone/SMS and QR login flows tend to dead-end. Log in
once:

    python scraper/browser_session.py --platform tiktok

...and every later batch run reuses that Chrome profile. If a session drops
mid-run, the batch pauses and waits for you to log back in rather than
burning through the rest of the list against a login wall.

Usage
-----
    # first time (or after a session expires)
    python scraper/browser_session.py --platform tiktok

    # then scrape
    python scraper/scrape_places_batch.py --platform tiktok
    python scraper/scrape_places_batch.py --platform both --limit-per-place 5
    python scraper/scrape_places_batch.py --platform tiktok --only-city chiyoda --max-places 10
    python scraper/scrape_places_batch.py --platform tiktok --no-upsert   # local JSONL only

Place source
------------
Every `*.json` file in --consolidated-dir (default `scraper/consolidated/`,
the output of the enrichment pipeline — see scraper/JAPAN_PLACES_PIPELINE.md),
each holding a `{"records": [...]}` list for one city. `_report.json` and
`kanto_places.json` (a different, already-merged schema) are skipped.

Unlike the previous version, the whole place list is assembled up front and
worked through with a single browser per platform — not one browser launch
per city per platform.

Search queries
--------------
TikTok gets `"{name} {city}"` by default so "Tsutaya Books" doesn't pull in
every Tsutaya on earth (falls back to {prefecture} when a record has no
city). Instagram gets `"{name}"` only, since its query is squashed into a
hashtag. Override with --tiktok-query / --instagram-query.

Output
------
Every reel is appended to `data/scraped_<platform>.jsonl` before the Supabase
upsert is attempted, so a network/Supabase failure never loses a scrape — the
upsert error is reported and the run continues.

Progress (status + reel count per place per platform) is written atomically to
--progress-file after every place, keyed by each place's `dedupe_key`, so
Ctrl-C or a crash loses at most one place's work. Re-running the same command
skips places already "done" and retries anything "blocked" or "error".
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

SCRAPER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRAPER_DIR))

import browser_session  # noqa: E402
import scrape_instagram  # noqa: E402
import scrape_tiktok  # noqa: E402
from browser_session import add_browser_args, open_session, wait_for_login  # noqa: E402
from humanize import human_idle, human_mouse_move  # noqa: E402
from upsert_supabase import upsert_reels  # noqa: E402

DEFAULT_CONSOLIDATED_DIR = SCRAPER_DIR / "consolidated"
DEFAULT_PROGRESS_FILE = SCRAPER_DIR / "data" / "batch_progress_scotland.json"
DEFAULT_BACKUP_DIR = SCRAPER_DIR / "data"

# Files in the consolidated dir that aren't per-city record lists.
CONSOLIDATED_SKIP_FILES = {"_report.json", "kanto_places.json"}

PLATFORM_CONFIG = {
    "tiktok": {
        "search_and_extract": scrape_tiktok.search_and_extract,
        "detect_block": scrape_tiktok.detect_block,
        "default_query": "{name} {city}",
    },
    "instagram": {
        "search_and_extract": scrape_instagram.search_and_extract,
        "detect_block": scrape_instagram.detect_block,
        "default_query": "{name}",
    },
}


@dataclass
class Place:
    name: str
    dedupe_key: str
    city: str
    prefecture: str
    source_file: str

    def query(self, template: str) -> str:
        # Some records have no city (22/331 in the Kanto set) — fall back to
        # prefecture so the query still gets a location suffix instead of
        # collapsing to the bare (often generic) place name.
        return " ".join(
            template.format(
                name=self.name,
                city=self.city or self.prefecture,
                prefecture=self.prefecture,
            ).split()
        )


@dataclass
class RunStats:
    scraped: int = 0
    reels: int = 0
    empty: int = 0
    errors: int = 0
    blocked: int = 0
    skipped: int = 0
    started_at: float = field(default_factory=time.monotonic)

    def summary(self, platform: str) -> str:
        mins = (time.monotonic() - self.started_at) / 60
        return (
            f"[batch:{platform}] finished in {mins:.1f} min — "
            f"{self.scraped} place(s) scraped, {self.reels} reel(s), "
            f"{self.empty} empty, {self.errors} error(s), {self.blocked} blocked"
        )


# ------------------------------------------------------------------ place list


def discover_consolidated_files(consolidated_dir: Path) -> list[Path]:
    # Accept either a directory of consolidated JSONs or a single JSON file
    # (e.g. `consolidated/scot-pilot-2026-07-25/_promoted_places.json`).
    if consolidated_dir.is_file():
        return [consolidated_dir]
    # Recurse so nested pipeline outputs like
    # consolidated/scot-pilot-2026-07-25/_promoted_places.json are picked up
    # alongside flat per-city files in consolidated/*.json.
    return sorted(
        p for p in consolidated_dir.rglob("*.json")
        if p.name not in CONSOLIDATED_SKIP_FILES
    )


def load_places(city_file: Path) -> list[Place]:
    """Load one city's place records from a consolidated/*.json file.

    Each record needs at least a `name`; `dedupe_key` (falling back to the
    name) is the stable progress key, so re-running skips places already done
    even when the same name shows up in another city.
    """
    try:
        data = json.loads(city_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[batch] couldn't read {city_file.name}: {exc}", file=sys.stderr)
        return []

    if isinstance(data, dict):
        # Consolidated per-city files use "records"; the Scotland promoted-places
        # export (consolidated/scot-pilot-*/_promoted_places.json) uses "places".
        records = data.get("records") or data.get("places") or []
    else:
        records = data
    places: list[Place] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        name = (record.get("name") or "").strip()
        if not name:
            continue
        places.append(
            Place(
                name=name,
                dedupe_key=record.get("dedupe_key") or name,
                city=(record.get("city") or "").strip(),
                prefecture=(record.get("prefecture") or "").strip(),
                source_file=city_file.stem,
            )
        )
    return places


def build_place_list(args: argparse.Namespace) -> list[Place]:
    city_files = discover_consolidated_files(args.consolidated_dir)
    if not city_files:
        print(f"[batch] no place files found in {args.consolidated_dir}", file=sys.stderr)
        sys.exit(1)

    only = {c.lower() for c in (args.only_city or [])}
    skip = {c.lower() for c in (args.skip_city or [])}

    places: list[Place] = []
    seen_keys: set[str] = set()
    for city_file in city_files:
        stem = city_file.stem.lower()
        if only and stem not in only:
            continue
        if stem in skip:
            continue
        for place in load_places(city_file):
            # The same place can appear in two city files; scrape it once.
            if place.dedupe_key in seen_keys:
                continue
            seen_keys.add(place.dedupe_key)
            places.append(place)

    if only:
        missing = only - {p.source_file.lower() for p in places}
        if missing:
            print(f"[batch] warning: no consolidated file matched: {', '.join(sorted(missing))}", file=sys.stderr)
    return places


# -------------------------------------------------------------------- progress


def load_progress(progress_file: Path) -> dict:
    if not progress_file.exists():
        return {}
    try:
        data = json.loads(progress_file.read_text())
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        print(f"[batch] warning: couldn't read {progress_file}, starting fresh progress.", file=sys.stderr)
        return {}


def save_progress(progress_file: Path, progress: dict) -> None:
    """Write progress atomically — a Ctrl-C mid-write can't corrupt the file."""
    progress_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = progress_file.with_suffix(progress_file.suffix + ".tmp")
    tmp.write_text(json.dumps(progress, indent=2, ensure_ascii=False))
    os.replace(tmp, progress_file)


def is_done(platform_progress: dict, place: Place) -> bool:
    """Done under the current dedupe_key, or under a legacy plain-name key.

    Progress used to be keyed by place name; this keeps those older runs from
    being re-scraped from scratch.
    """
    for key in (place.dedupe_key, place.name):
        entry = platform_progress.get(key)
        if isinstance(entry, dict) and entry.get("status") == "done":
            return True
    return False


def record_result(
    progress: dict,
    progress_file: Path,
    platform: str,
    place: Place,
    status: str,
    count: int = 0,
    detail: str | None = None,
) -> None:
    entry = {
        "status": status,
        "count": count,
        "city": place.city,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    if detail:
        entry["detail"] = detail[:300]
    progress.setdefault(platform, {})[place.dedupe_key] = entry
    save_progress(progress_file, progress)


# ---------------------------------------------------------------------- output


def append_backup(backup_file: Path, reels: list[dict]) -> None:
    """Append every scraped reel to a local JSONL before touching Supabase."""
    backup_file.parent.mkdir(parents=True, exist_ok=True)
    with backup_file.open("a", encoding="utf-8") as fh:
        for reel in reels:
            fh.write(json.dumps(reel, ensure_ascii=False) + "\n")


# ------------------------------------------------------------------- the run


def scrape_place(
    page: Page,
    platform: str,
    place: Place,
    query: str,
    limit: int,
    retries: int,
) -> tuple[list[dict], str | None]:
    """Scrape one place, retrying transient failures. Returns (reels, error)."""
    config = PLATFORM_CONFIG[platform]
    last_error: str | None = None

    for attempt in range(retries + 1):
        try:
            return config["search_and_extract"](page, query, limit), None
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            if attempt < retries:
                backoff = 5 * (attempt + 1)
                print(
                    f"[batch:{platform}] '{query}' failed ({last_error}) — retrying in {backoff}s",
                    file=sys.stderr,
                )
                time.sleep(backoff)
    return [], last_error


def run_platform(platform: str, places: list[Place], args: argparse.Namespace, progress: dict) -> RunStats:
    config = PLATFORM_CONFIG[platform]
    platform_progress: dict = progress.setdefault(platform, {})
    stats = RunStats()

    pending = [p for p in places if args.force or not is_done(platform_progress, p)]
    stats.skipped = len(places) - len(pending)
    if args.max_places:
        pending = pending[: args.max_places]

    if not pending:
        print(f"[batch:{platform}] all {len(places)} place(s) already done, nothing to do.")
        return stats

    template = args.tiktok_query if platform == "tiktok" else args.instagram_query
    backup_file = args.backup_dir / f"scraped_{platform}.jsonl"

    print(
        f"[batch:{platform}] {len(pending)} place(s) to scrape "
        f"({stats.skipped} already done), query template: {template!r}"
    )
    if args.dry_run:
        for place in pending[:20]:
            print(f"  [dry-run] {place.source_file}: {place.query(template)}")
        if len(pending) > 20:
            print(f"  [dry-run] ... and {len(pending) - 20} more")
        return stats

    with sync_playwright() as pw:
        session = open_session(
            pw,
            platform,
            mode=args.browser_mode,
            headless=args.headless,
            cdp_port=args.cdp_port,
            chrome_user_data_dir=args.chrome_user_data_dir,
            chrome_path=args.chrome_path,
        )
        page = session.page

        try:
            if not wait_for_login(page, platform, timeout_seconds=args.login_timeout or None):
                print(f"[batch:{platform}] giving up — never saw a logged-in session.", file=sys.stderr)
                return stats

            consecutive_empty = 0
            cooldowns_used = 0

            for i, place in enumerate(pending, start=1):
                query = place.query(template)
                human_idle(page, 1.0, 2.5)

                reels, error = scrape_place(
                    page, platform, place, query, args.limit_per_place, args.retries
                )

                if error:
                    stats.errors += 1
                    print(f"[batch:{platform}] ({i}/{len(pending)}) '{query}' -> error: {error}", file=sys.stderr)
                    record_result(progress, args.progress_file, platform, place, "error", detail=error)
                elif reels:
                    consecutive_empty = 0
                    destination = args.destination or place.prefecture or place.city or "Japan"
                    for reel in reels:
                        reel["destination"] = destination
                        reel["location"] = place.name

                    append_backup(backup_file, reels)

                    if args.no_upsert:
                        print(f"[batch:{platform}] --no-upsert: {len(reels)} reel(s) kept in {backup_file.name} only")
                    else:
                        try:
                            upsert_reels(reels)
                        except Exception as exc:
                            # The reels are already safe on disk — don't lose the
                            # whole run to a transient Supabase/network failure.
                            print(
                                f"[batch:{platform}] upsert failed ({exc}); reels are in {backup_file}",
                                file=sys.stderr,
                            )

                    stats.scraped += 1
                    stats.reels += len(reels)
                    record_result(progress, args.progress_file, platform, place, "done", count=len(reels))
                    print(
                        f"[batch:{platform}] ({i}/{len(pending)}) '{query}' -> {len(reels)} reel(s). "
                        f"running total: {stats.reels}"
                    )
                else:
                    consecutive_empty += 1
                    block_reason = config["detect_block"](page)
                    status = "blocked" if block_reason else "empty"
                    if block_reason:
                        stats.blocked += 1
                    else:
                        stats.empty += 1
                        stats.scraped += 1
                    record_result(
                        progress, args.progress_file, platform, place,
                        "done" if status == "empty" else "blocked",
                        count=0, detail=block_reason,
                    )
                    print(
                        f"[batch:{platform}] ({i}/{len(pending)}) '{query}' -> 0 reel(s)"
                        + (f" ({block_reason})" if block_reason else "")
                    )

                # A run of empties usually means the session dropped or we're
                # being soft-throttled. Check login, then cool off, rather than
                # grinding through the rest of the list against a wall.
                if consecutive_empty >= args.block_threshold:
                    logged_in = browser_session.PLATFORMS[platform]["logged_in"](page)
                    if not logged_in:
                        print(f"\n[batch:{platform}] session looks logged out — pausing for you to log back in.")
                        if not wait_for_login(page, platform, timeout_seconds=args.login_timeout or None):
                            print(f"[batch:{platform}] giving up — never saw a logged-in session.", file=sys.stderr)
                            break
                        consecutive_empty = 0
                    else:
                        cooldowns_used += 1
                        if cooldowns_used > args.max_cooldowns:
                            print(
                                f"[batch:{platform}] still empty after {cooldowns_used} cooldown(s) — "
                                f"stopping this platform. Re-run later to resume.",
                                file=sys.stderr,
                            )
                            break
                        print(
                            f"[batch:{platform}] {consecutive_empty} empty in a row but still logged in — "
                            f"cooling off for {args.cooldown:.0f}s ({cooldowns_used}/{args.max_cooldowns})."
                        )
                        time.sleep(args.cooldown)
                        consecutive_empty = 0

                if i == len(pending):
                    break

                human_mouse_move(page)
                if i % args.batch_size == 0:
                    rest = random.uniform(args.batch_rest_min, args.batch_rest_max)
                    print(f"[batch:{platform}] taking a longer break ({rest:.0f}s) after {i} places...")
                    time.sleep(rest)
                else:
                    time.sleep(random.uniform(args.place_delay_min, args.place_delay_max))

        except KeyboardInterrupt:
            print(f"\n[batch:{platform}] interrupted — progress saved, re-run the same command to resume.")
            raise
        finally:
            save_progress(args.progress_file, progress)
            session.close(keep_browser=not args.close_browser)

    print(stats.summary(platform))
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Batch-scrape TikTok/Instagram reels for a list of place names.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--consolidated-dir", type=Path, default=DEFAULT_CONSOLIDATED_DIR)
    parser.add_argument("--platform", choices=["tiktok", "instagram", "both"], default="both")
    parser.add_argument(
        "--destination",
        default=None,
        help="Trip destination tag for every reel. Default: each place's own prefecture (falls back to city).",
    )
    parser.add_argument("--limit-per-place", type=int, default=5)

    parser.add_argument("--only-city", action="append", help="Only this consolidated file stem (repeatable), e.g. chiyoda.")
    parser.add_argument("--skip-city", action="append", help="Skip this consolidated file stem (repeatable).")
    parser.add_argument("--max-places", type=int, default=0, help="Cap places per platform this run (0 = no cap).")
    parser.add_argument("--dry-run", action="store_true", help="Print the queries that would run, then exit.")

    parser.add_argument("--tiktok-query", default=PLATFORM_CONFIG["tiktok"]["default_query"],
                        help="Query template. Fields: {name} {city} {prefecture}.")
    parser.add_argument("--instagram-query", default=PLATFORM_CONFIG["instagram"]["default_query"],
                        help="Query template (squashed to a hashtag, so keep it short).")

    parser.add_argument("--batch-size", type=int, default=8, help="Places per batch before a longer rest.")
    parser.add_argument("--batch-rest-min", type=float, default=90.0)
    parser.add_argument("--batch-rest-max", type=float, default=180.0)
    parser.add_argument("--place-delay-min", type=float, default=10.0)
    parser.add_argument("--place-delay-max", type=float, default=25.0)
    parser.add_argument("--retries", type=int, default=1, help="Retries per place on a transient error.")
    parser.add_argument("--block-threshold", type=int, default=3,
                        help="Consecutive empty places before checking login / cooling off.")
    parser.add_argument("--cooldown", type=float, default=300.0, help="Cooldown seconds after a run of empties.")
    parser.add_argument("--max-cooldowns", type=int, default=2, help="Give up on a platform after this many cooldowns.")
    parser.add_argument("--login-timeout", type=float, default=0,
                        help="Seconds to wait for manual login (0 = wait indefinitely).")

    parser.add_argument("--progress-file", type=Path, default=DEFAULT_PROGRESS_FILE)
    parser.add_argument("--backup-dir", type=Path, default=DEFAULT_BACKUP_DIR,
                        help="Where scraped_<platform>.jsonl backups are appended.")
    parser.add_argument("--no-upsert", action="store_true", help="Skip Supabase; keep the JSONL backup only.")
    parser.add_argument("--headless", action="store_true", default=False)
    parser.add_argument("--force", action="store_true", help="Re-scrape places already marked done.")
    add_browser_args(parser)
    args = parser.parse_args()

    places = build_place_list(args)
    if not places:
        print("[batch] no places matched the current filters.", file=sys.stderr)
        sys.exit(1)

    progress = load_progress(args.progress_file)
    platforms = ["tiktok", "instagram"] if args.platform == "both" else [args.platform]

    cities = sorted({p.source_file for p in places})
    print(
        f"[batch] {len(places)} place(s) across {len(cities)} city file(s): {', '.join(cities)}\n"
        f"[batch] platform(s): {', '.join(platforms)} | browser mode: {args.browser_mode} | "
        f"destination tag: {args.destination or 'per-place prefecture'}"
    )

    results: dict[str, RunStats] = {}
    try:
        for platform in platforms:
            results[platform] = run_platform(platform, places, args, progress)
    except KeyboardInterrupt:
        print("[batch] stopped. progress was saved — re-run the same command to resume.")
        sys.exit(130)

    if len(results) > 1:
        total = sum(s.reels for s in results.values())
        print(f"[batch] all platforms done — {total} reel(s) this run.")


if __name__ == "__main__":
    main()
