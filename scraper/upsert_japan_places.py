#!/usr/bin/env python3
"""
upsert_japan_places.py — upserts validated Japan place records into
places_staging via Supabase REST. It does not write directly to `places`.
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

ALLOWED_COLUMNS = {
    "batch_id",
    "dedupe_key",
    "region",
    "prefecture",
    "city",
    "country",
    "name",
    "category",
    "description",
    "tips",
    "hours",
    "hours_status",
    "station",
    "google_place_id",
    "lat",
    "lng",
    "address",
    "rating",
    "price_level",
    "image_url",
    "badges",
    "source_urls",
    "field_sources",
    "photo",
    "extraction_model",
    "extraction_status",
    "validation_errors",
    "approved",
    "rejected_reason",
    "fetched_at",
    "last_verified_at",
}


def _get_credentials() -> tuple[str, str]:
    supabase_url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    supabase_key = os.environ.get("SUPABASE_KEY", "").strip()
    if not supabase_url or not supabase_key:
        print(
            "[upsert-japan] Missing SUPABASE_URL / SUPABASE_KEY. Copy "
            "scraper/.env.example to scraper/.env and fill in credentials.",
            file=sys.stderr,
        )
        sys.exit(1)
    return supabase_url, supabase_key


def _clean_row(record: dict[str, Any]) -> dict[str, Any] | None:
    if not record.get("batch_id") or not record.get("dedupe_key"):
        return None
    # PostgREST's bulk-insert requires every object in the array to have the
    # same set of keys (PGRST102 "All object keys must match" otherwise), so
    # every ALLOWED_COLUMNS key must be present (as null if absent) rather
    # than only including keys the record happens to define.
    return {key: record.get(key) for key in ALLOWED_COLUMNS}


def upsert_staging(records: list[dict[str, Any]]) -> int:
    rows = []
    skipped = 0
    for record in records:
        cleaned = _clean_row(record)
        if cleaned is None:
            skipped += 1
            continue
        rows.append(cleaned)

    if skipped:
        print(f"[upsert-japan] skipped {skipped} record(s) without batch_id/dedupe_key", file=sys.stderr)

    if not rows:
        print("[upsert-japan] nothing to upsert.")
        return 0

    supabase_url, supabase_key = _get_credentials()
    endpoint = f"{supabase_url}/rest/v1/places_staging"
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    params = {"on_conflict": "batch_id,dedupe_key"}

    response = requests.post(endpoint, headers=headers, params=params, json=rows, timeout=30)
    if response.status_code >= 300:
        print(f"[upsert-japan] FAILED ({response.status_code}): {response.text}", file=sys.stderr)
        response.raise_for_status()

    print(f"[upsert-japan] upserted {len(rows)} row(s) into places_staging.")
    return len(rows)


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: python scraper/upsert_japan_places.py path/to/extracted.json", file=sys.stderr)
        sys.exit(1)

    json_path = Path(sys.argv[1])
    if not json_path.exists():
        print(f"[upsert-japan] file not found: {json_path}", file=sys.stderr)
        sys.exit(1)

    payload = json.loads(json_path.read_text())
    records = payload.get("records", payload) if isinstance(payload, dict) else payload
    if not isinstance(records, list):
        print("[upsert-japan] expected records array or list of objects.", file=sys.stderr)
        sys.exit(1)

    upsert_staging(records)


if __name__ == "__main__":
    main()