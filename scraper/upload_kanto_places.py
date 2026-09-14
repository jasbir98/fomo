#!/usr/bin/env python3
"""
Upload consolidated/kanto_places.json to Supabase.

Operations:
  1. PATCH each enriched record into `places` by its UUID.
  2. DELETE the 8 non-POI records + 4 merged-stub records that were removed
     during consolidation.
  3. Upsert photos into `place_photos` (one row per record that has a photo).

WRITE KEY: `places` and `place_photos` have no anon/authenticated write
policy (see supabase/lock_pipeline_tables.sql / harden_rls.sql) — this
script requires SUPABASE_SERVICE_ROLE_KEY and never falls back to an anon
key.
"""

import json
import os
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).parent
SRC = ROOT / "data" / "consolidated" / "kanto_places.json"
REPORT = ROOT / "data" / "consolidated" / "_report.json"


def _parse_env_file(path: Path) -> dict:
    env = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


def load_env():
    # scraper/.env first, then the repo-root .env.local as a fallback (that's
    # where SUPABASE_SERVICE_ROLE_KEY commonly already lives for the Next
    # app's server-only admin client), then the process environment.
    env = {**_parse_env_file(ROOT.parent / ".env.local"), **_parse_env_file(ROOT / ".env")}
    env.setdefault("SUPABASE_URL", env.get("NEXT_PUBLIC_SUPABASE_URL", ""))
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        env.setdefault(k, os.environ.get(k, ""))
    if not env["SUPABASE_URL"] or not env["SUPABASE_SERVICE_ROLE_KEY"]:
        sys.exit(
            "ERROR: places and place_photos have no anon write policy — set "
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in scraper/.env (or "
            "ensure they're already in the repo-root .env.local)."
        )
    return {"SUPABASE_URL": env["SUPABASE_URL"], "SUPABASE_KEY": env["SUPABASE_SERVICE_ROLE_KEY"]}


# ---- Supabase helpers -------------------------------------------------------

class Supa:
    def __init__(self, url, key):
        self.base = url.rstrip("/") + "/rest/v1"
        self.h = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }

    def _url(self, table):
        return f"{self.base}/{table}"

    def patch(self, table, row_id, payload):
        r = requests.patch(
            self._url(table),
            params={"id": f"eq.{row_id}"},
            headers=self.h,
            json=payload,
            timeout=20,
        )
        return r

    def delete(self, table, row_id):
        r = requests.delete(
            self._url(table),
            params={"id": f"eq.{row_id}"},
            headers=self.h,
            timeout=20,
        )
        return r

    def upsert(self, table, payload, on_conflict=None):
        h = {**self.h, "Prefer": "resolution=merge-duplicates,return=representation"}
        params = {}
        if on_conflict:
            params["on_conflict"] = on_conflict
        r = requests.post(
            self._url(table),
            params=params,
            headers=h,
            json=payload,
            timeout=20,
        )
        return r

    def select(self, table, col, val):
        r = requests.get(
            self._url(table),
            params={"select": "id", col: f"eq.{val}"},
            headers=self.h,
            timeout=20,
        )
        return r


# ---- field mapping ----------------------------------------------------------

# Columns that exist in the `places` table
PLACES_COLS = {
    "id", "name", "category", "rating", "image_url", "distance_label",
    "tips", "reviews", "hours", "hours_status", "station", "badges",
    "google_place_id", "lat", "lng", "address", "price_level",
    "destination", "source", "fetched_at", "city", "prefecture",
    "country", "description", "last_verified_at",
}


def to_places_row(r):
    """Map a consolidated kanto_places record to a places-table payload."""
    row = {k: v for k, v in r.items() if k in PLACES_COLS}

    # tips: may be list of strings or list of objects — store as jsonb list
    tips = row.get("tips")
    if isinstance(tips, list):
        row["tips"] = tips  # jsonb handles both str and dict items
    else:
        row["tips"] = []

    # reviews: we cleared fabricated ones → send empty list
    row["reviews"] = r.get("reviews") or []

    # image_url: we cleared stock images → send null
    row["image_url"] = r.get("image_url")  # already None if stock was cleared

    return row


# ---- main -------------------------------------------------------------------

def main():
    env = load_env()
    supa = Supa(env["SUPABASE_URL"], env["SUPABASE_KEY"])

    places = json.load(open(SRC))
    report = json.load(open(REPORT))

    # IDs to delete: non-POI records + merged stubs
    delete_ids = [d["id"] for d in report.get("dropped", []) if d.get("id")]
    delete_ids += [m["dropped_id"] for m in report.get("merged", []) if m.get("dropped_id")]

    print(f"Records to update : {len(places)}")
    print(f"Records to delete : {len(delete_ids)}")

    # ── 1. PATCH enriched records ────────────────────────────────────────────
    updated = 0
    errors = []
    for rec in places:
        row = to_places_row(rec)
        rid = row["id"]
        r = supa.patch("places", rid, row)
        if r.status_code in (200, 204):
            updated += 1
        else:
            errors.append({"id": rid, "name": rec.get("name"),
                           "status": r.status_code, "body": r.text[:200]})
        # tiny pause so we don't hammer the REST API
        time.sleep(0.02)

    print(f"\n✓ Patched {updated}/{len(places)} records")
    if errors:
        print(f"✗ {len(errors)} errors:")
        for e in errors[:10]:
            print(f"  {e['name']} ({e['id']}) → {e['status']}: {e['body']}")

    # ── 2. DELETE non-POI + merged-stub rows ─────────────────────────────────
    deleted = 0
    del_errors = []
    for did in delete_ids:
        r = supa.delete("places", did)
        if r.status_code in (200, 204):
            deleted += 1
        elif r.status_code == 404:
            deleted += 1  # already gone — fine
        else:
            del_errors.append({"id": did, "status": r.status_code, "body": r.text[:200]})
        time.sleep(0.02)

    print(f"✓ Deleted {deleted}/{len(delete_ids)} stale rows")
    if del_errors:
        print(f"✗ {len(del_errors)} delete errors:")
        for e in del_errors[:5]:
            print(f"  {e['id']} → {e['status']}: {e['body']}")

    # ── 3. Upsert photos into place_photos ───────────────────────────────────
    photo_rows = []
    for rec in places:
        p = rec.get("photo")
        if not p or not p.get("url"):
            continue
        photo_rows.append({
            "place_id": rec["id"],
            "url": p["url"],
            "credit": p.get("credit") or "unknown",
            "license": p.get("license") or "unknown",
            "source_url": p.get("source_url") or p["url"],
            "display_order": 0,
            "provider": "wikimedia",
            "is_exact_place": True,
            "attribution_required": True,
        })

    photo_ok = 0
    photo_errors = []
    # batch in chunks of 20
    CHUNK = 20
    for i in range(0, len(photo_rows), CHUNK):
        batch = photo_rows[i:i+CHUNK]
        r = supa.upsert("place_photos", batch, on_conflict="place_id,url")
        if r.status_code in (200, 201):
            photo_ok += len(batch)
        else:
            photo_errors.append({"status": r.status_code, "body": r.text[:300]})
        time.sleep(0.05)

    print(f"✓ Upserted {photo_ok}/{len(photo_rows)} photos into place_photos")
    if photo_errors:
        print(f"✗ {len(photo_errors)} photo batch errors:")
        for e in photo_errors:
            print(f"  {e['status']}: {e['body']}")

    print("\nDone.")


if __name__ == "__main__":
    main()
