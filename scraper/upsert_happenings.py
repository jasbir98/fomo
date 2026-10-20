#!/usr/bin/env python3
"""
upsert_happenings.py — pushes happening records (from
`scraper/happenings_research.py`'s `{"records": [...]}` output) into the
Roameo Supabase `happenings_staging` table via the Supabase REST API
(PostgREST). Upserts on `(batch_id, slug)`.

Copies upsert_supabase.py's style exactly: a plain HTTP helper — no Supabase
Python SDK dependency, just `requests` — with its own `ALLOWED_COLUMNS`
whitelist so a stray/unexpected key on a record can never cause a PostgREST
schema-mismatch error. Credentials are read from `scraper/.env` (via
python-dotenv), NOT the Next app's `.env.local` — this is a fully separate
tool, same as upsert_supabase.py. See `.env.example`.

Usage:
    python scraper/upsert_happenings.py scraper/out/<batch-id>/edinburgh-happenings-calendar.json
    python scraper/upsert_happenings.py scraper/out/<batch-id>/edinburgh-happenings-offers.json

Requires SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY
— happenings_staging has no anon write policy, see
supabase/archive/lock_pipeline_tables.sql, so upsert_supabase._get_credentials() (reused
here) requires the service-role key and never falls back to anon. IMPORTANT: the
`Prefer: resolution=merge-duplicates` upsert strategy relies on
`(batch_id, slug)` having a UNIQUE constraint/index on `happenings_staging`
in Postgres so PostgREST has an `ON CONFLICT` target (see
supabase/archive/add_happenings.sql). If you see upsert errors mentioning "there is
no unique or exclusion constraint", that index is missing.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

SCRAPER_DIR = Path(__file__).resolve().parent
load_dotenv(SCRAPER_DIR / ".env")

sys.path.insert(0, str(SCRAPER_DIR))
from upsert_supabase import _get_credentials  # noqa: E402 — reuse the same credential loader/error hint.

# Only these columns are ever sent — anything else on a record dict is
# dropped defensively so a stray key (e.g. a validation-only field the
# research script keeps around) can't cause a PostgREST schema-mismatch
# error. Mirrors happenings_research.py's build_full_record() output shape.
ALLOWED_COLUMNS = {
    "batch_id",
    "research_mode",
    "slug",
    "title",
    "summary",
    "kind",
    "category",
    "scope",
    "editorial_tag",
    "saving_label",
    "saving_amount",
    "currency",
    "is_free",
    "promo_code",
    "redemption_note",
    "eligibility",
    "family_fit",
    "eligibility_note",
    "allowance_note",
    "price_text",
    "includes",
    "season_valid_until",
    "starts_at",
    "ends_at",
    "recurrence",
    "time_note",
    "booking_opens_at",
    "sellout_risk",
    "sellout_note",
    "venue_name",
    "address",
    "district",
    "city",
    "region",
    "country_code",
    "lat",
    "lng",
    "place_id",
    "image_url",
    "image_quality",
    "booking_url",
    "cta_label",
    "source_name",
    "source_url",
    "source_urls",
    "field_sources",
    "confidence",
    "priority",
    "extraction_model",
    "extraction_status",
    "validation_errors",
    "approved",
    "status",
    "verified_at",
}


# Columns added by supabase/add_deal_source_columns.sql. They are only sent when
# a row actually has a value, so a batch with none (every topic-only run) still
# upserts cleanly on a database where that migration has not been run yet.
SPARSE_COLUMNS = {"price_text", "includes", "season_valid_until", "family_fit"}

# family_fit (happenings_staging.family_fit) may not exist in the database yet. If PostgREST
# says so, the column is dropped from the batch and the upsert retried, with one warning.
_MISSING_COLUMN_CODES = ("PGRST204", "42703")
_family_fit_warned = False


def _is_missing_column(resp: Any, column: str) -> bool:
    """True when a failed response says `column` does not exist (PGRST204 / 42703 / message text)."""
    text = getattr(resp, "text", "") or ""
    if column not in text:
        return False
    lowered = text.lower()
    return any(code in text for code in _MISSING_COLUMN_CODES) or "could not find the" in lowered or "does not exist" in lowered


def _clean_row(record: dict[str, Any]) -> dict[str, Any] | None:
    """Keep only known columns; skip rows with no batch_id/slug (our dedupe key)."""
    if not record.get("batch_id") or not record.get("slug"):
        return None
    return {
        k: record.get(k)
        for k in ALLOWED_COLUMNS
        if k in record and not (k in SPARSE_COLUMNS and record.get(k) is None)
    }


def upsert_happenings(records: list[dict[str, Any]], table: str = "happenings_staging") -> int:
    """Upsert a list of happening record dicts into `table`, deduped on
    `(batch_id, slug)`. Returns the number of rows actually sent
    (post-filtering). Rows missing batch_id/slug are silently skipped
    (logged to stderr) since that's the dedupe key."""
    rows = []
    skipped = 0
    for record in records:
        cleaned = _clean_row(record)
        if cleaned is None:
            skipped += 1
            continue
        rows.append(cleaned)

    if skipped:
        print(f"[upsert-happenings] skipped {skipped} record(s) with no batch_id/slug", file=sys.stderr)

    # Postgres refuses the whole ON CONFLICT upsert if one request repeats a
    # conflict key ("cannot affect row a second time"), so keep the first row
    # per (batch_id, slug) rather than lose the batch.
    unique: dict[tuple[Any, Any], dict[str, Any]] = {}
    for row in rows:
        key = (row["batch_id"], row["slug"])
        if key in unique:
            print(f"[upsert-happenings] dropped duplicate slug {row['slug']!r} in this batch", file=sys.stderr)
            continue
        unique[key] = row
    rows = list(unique.values())

    if not rows:
        print("[upsert-happenings] nothing to upsert.")
        return 0

    # PostgREST's bulk JSON endpoint rejects a list whose objects do not all
    # expose exactly the same keys (PGRST102).  Optional fields such as a
    # newly linked ``place_id`` or a promo code naturally appear on only some
    # records, so normalise the batch after filtering to known columns.  This
    # is an API-shape requirement, not a Supabase migration problem.
    batch_columns = set().union(*(row.keys() for row in rows))
    rows = [{column: row.get(column) for column in batch_columns} for row in rows]

    supabase_url, supabase_key = _get_credentials()
    endpoint = f"{supabase_url}/rest/v1/{table}"
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    params = {"on_conflict": "batch_id,slug"}

    resp = requests.post(endpoint, headers=headers, params=params, json=rows, timeout=30)

    global _family_fit_warned
    if resp.status_code >= 300 and "family_fit" in batch_columns and _is_missing_column(resp, "family_fit"):
        if not _family_fit_warned:
            _family_fit_warned = True
            print(f"[upsert-happenings] WARN: {table}.family_fit column not found - run the family_fit migration. "
                  "Upserting without family_fit for now.", file=sys.stderr)
        rows = [{k: v for k, v in row.items() if k != "family_fit"} for row in rows]
        resp = requests.post(endpoint, headers=headers, params=params, json=rows, timeout=30)

    if resp.status_code >= 300:
        print(f"[upsert-happenings] FAILED ({resp.status_code}): {resp.text}", file=sys.stderr)
        resp.raise_for_status()

    print(f"[upsert-happenings] upserted {len(rows)} row(s) into {table}.")
    return len(rows)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--table")]
    table = "happenings_staging"
    for a in sys.argv[1:]:
        if a.startswith("--table="):
            table = a.split("=", 1)[1]
    if len(args) != 1:
        print(
            "Usage: python scraper/upsert_happenings.py path/to/happenings.json [--table=happenings_staging]",
            file=sys.stderr,
        )
        sys.exit(1)

    json_path = Path(args[0])
    if not json_path.exists():
        print(f"[upsert-happenings] file not found: {json_path}", file=sys.stderr)
        sys.exit(1)

    data = json.loads(json_path.read_text())
    records = data.get("records") if isinstance(data, dict) else data
    if not isinstance(records, list):
        print(
            "[upsert-happenings] expected the JSON file to contain {\"records\": [...]} or a bare list.",
            file=sys.stderr,
        )
        sys.exit(1)

    succeeded = upsert_happenings(records, table=table)
    failed = len(records) - succeeded
    print(f"[upsert-happenings] succeeded={succeeded} failed={failed}")


if __name__ == "__main__":
    main()
