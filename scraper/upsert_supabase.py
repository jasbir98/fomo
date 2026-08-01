#!/usr/bin/env python3
"""
upsert_supabase.py — pushes scraped reel rows into a Roameo Supabase table
via the Supabase REST API (PostgREST). Defaults to `scraped_reels` (the raw
staging table every scrape lands in) — pass `table="social_posts"` to
instead promote already-classified rows into the curated table the app
reads from. See scraper/JAPAN_PLACES_PIPELINE.md / classify_reels.py for
why the two tables exist.

This is a plain HTTP helper — no Supabase Python SDK dependency, just
`requests`. It is imported by scrape_tiktok.py / scrape_instagram.py /
classify_reels.py, and can also be run standalone against a JSON file
produced by `--dump-json`:

    python scraper/upsert_supabase.py path/to/reels.json
    python scraper/upsert_supabase.py path/to/reels.json --table social_posts

Credentials are read from `scraper/.env` (via python-dotenv), NOT the Next
app's `.env.local` — this is a fully separate tool. See `.env.example`.

IMPORTANT: the `Prefer: resolution=merge-duplicates` upsert strategy below
relies on `video_url` having a UNIQUE constraint/index in Postgres so
PostgREST has an `ON CONFLICT` target. Both `scraped_reels` and
`social_posts` already have this (see supabase/add_scraped_reels_staging.sql
/ add_social_video_columns.sql). If you see upsert errors mentioning "there
is no unique or exclusion constraint", that index is missing on whichever
table you're targeting.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

SCRAPER_DIR = Path(__file__).resolve().parent
load_dotenv(SCRAPER_DIR / ".env")

# Only these columns are ever sent — anything else on a reel dict is dropped
# defensively so a stray key can't cause a PostgREST schema-mismatch error.
ALLOWED_COLUMNS = {
    "author_handle",
    "avatar_url",
    "image_url",
    "caption",
    "likes",
    "location",
    "platform",
    "video_url",
    "thumbnail_url",
    "destination",
    "place_id",
}


def _get_credentials() -> tuple[str, str]:
    supabase_url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    supabase_key = os.environ.get("SUPABASE_KEY", "").strip()
    if not supabase_url or not supabase_key:
        print(
            "[upsert] Missing SUPABASE_URL / SUPABASE_KEY. Copy scraper/.env.example "
            "to scraper/.env and fill in your project's URL + anon/service key.",
            file=sys.stderr,
        )
        sys.exit(1)
    return supabase_url, supabase_key


def _clean_row(reel: dict[str, Any]) -> dict[str, Any] | None:
    """Keep only known columns; skip rows with no video_url (our dedupe key)."""
    video_url = reel.get("video_url")
    if not video_url:
        return None
    return {k: reel.get(k) for k in ALLOWED_COLUMNS if k in reel}


def upsert_reels(reels: list[dict[str, Any]], table: str = "scraped_reels") -> int:
    """Upsert a list of reel dicts into `table`, deduped on `video_url`.

    Defaults to `scraped_reels` (raw staging). Pass `table="social_posts"` to
    promote already-classified rows into the curated table the app reads
    from — see classify_reels.py.

    Returns the number of rows actually sent (post-filtering). Rows missing
    `video_url` are silently skipped (logged to stderr) since that's the
    dedupe key and there's nothing sane to upsert on without it.
    """
    rows = []
    skipped = 0
    for reel in reels:
        cleaned = _clean_row(reel)
        if cleaned is None:
            skipped += 1
            continue
        rows.append(cleaned)

    if skipped:
        print(f"[upsert] skipped {skipped} reel(s) with no video_url", file=sys.stderr)

    if not rows:
        print("[upsert] nothing to upsert.")
        return 0

    supabase_url, supabase_key = _get_credentials()
    endpoint = f"{supabase_url}/rest/v1/{table}"
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    params = {"on_conflict": "video_url"}

    resp = requests.post(endpoint, headers=headers, params=params, json=rows, timeout=30)

    if resp.status_code >= 300:
        print(f"[upsert] FAILED ({resp.status_code}): {resp.text}", file=sys.stderr)
        resp.raise_for_status()

    print(f"[upsert] upserted {len(rows)} row(s) into {table}.")
    return len(rows)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--table")]
    table = "scraped_reels"
    for a in sys.argv[1:]:
        if a.startswith("--table="):
            table = a.split("=", 1)[1]
    if len(args) != 1:
        print(
            "Usage: python scraper/upsert_supabase.py path/to/reels.json [--table=scraped_reels|social_posts]",
            file=sys.stderr,
        )
        sys.exit(1)

    json_path = Path(args[0])
    if not json_path.exists():
        print(f"[upsert] file not found: {json_path}", file=sys.stderr)
        sys.exit(1)

    reels = json.loads(json_path.read_text())
    if not isinstance(reels, list):
        print("[upsert] expected the JSON file to contain a list of reel objects.", file=sys.stderr)
        sys.exit(1)

    upsert_reels(reels, table=table)


if __name__ == "__main__":
    main()
