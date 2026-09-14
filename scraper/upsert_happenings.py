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
supabase/lock_pipeline_tables.sql, so upsert_supabase._get_credentials() (reused
here) requires the service-role key and never falls back to anon. IMPORTANT: the
`Prefer: resolution=merge-duplicates` upsert strategy relies on
`(batch_id, slug)` having a UNIQUE constraint/index on `happenings_staging`
in Postgres so PostgREST has an `ON CONFLICT` target (see
supabase/add_happenings.sql). If you see upsert errors mentioning "there is
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
    "eligibility_note",
    "allowance_note",
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


def _clean_row(record: dict[str, Any]) -> dict[str, Any] | None:
    """Keep only known columns; skip rows with no batch_id/slug (our dedupe key)."""
    if not record.get("batch_id") or not record.get("slug"):
        return None
    return {k: record.get(k) for k in ALLOWED_COLUMNS if k in record}


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
