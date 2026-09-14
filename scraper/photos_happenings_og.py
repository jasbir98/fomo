#!/usr/bin/env python3
"""
photos_happenings_og.py — attach the publisher's own preview image
(og:image / twitter:image) to live `happenings` rows that have no
image_url yet.

These are NOT openly-licensed photos like scraper/photos_wikimedia.py's —
they're the source's own promotional/social-share image, used the same way
any link-preview card would. `happenings.image_quality` is deliberately
left at its 'thin' default here regardless of the image's actual size (see
the comment on that column in supabase/add_happenings.sql: happenings are
a value-prop chip and must never win the Home ranker's photo-hero slot —
setting 'ok' would defeat that on-purpose design and is never done here).

Per-happening flow:
  1. Try, in order: source_url, booking_url, then any other URL cited in
     happening_sources for this happening_id.
  2. GET the page with a normal browser-like User-Agent, parse
     <meta property="og:image"> / <meta name="twitter:image"> (first
     found wins), resolve a relative URL against the page URL.
  3. HEAD (falling back to a small ranged GET) the image URL: must be an
     image/* content-type; skip filenames containing logo/icon/favicon;
     download and check pixel width with Pillow, rejecting anything
     under MIN_WIDTH (favicons/sprites masquerading as content images).
  4. Track how many DISTINCT happenings each candidate image URL is used
     for. If the same og:image is shared by more than one happening
     (a site-wide default share card), it is a generic default, not a
     venue-specific image — none of those happenings get it. This
     requires two passes: gather all candidates first, then filter.
  5. If no acceptable og:image, and the happening's venue_name matches a
     live `places` row that already has a Wikimedia photo (from
     photos_wikimedia.py's run), reuse that place's photo (image_url only
     — happenings has no place_photos-style multi-photo table).

Idempotent: only happenings with image_url IS NULL are considered, and a
rerun after a partial run naturally picks up wherever it left off.

Usage:
    python3 scraper/photos_happenings_og.py --dry-run
    python3 scraper/photos_happenings_og.py
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
import urllib.parse
from html.parser import HTMLParser
from pathlib import Path

import requests
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "scraper" / "out" / "photos-2026-09-13"
OUT_DIR.mkdir(parents=True, exist_ok=True)

PAGE_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FomoPhotos/1.0")
MIN_WIDTH = 400
BAD_FILENAME_RE = re.compile(r"(logo|icon|favicon|sprite)", re.I)


def load_env() -> dict:
    env = {
        **dotenv_values(ROOT / "scraper" / ".env"),
        **dotenv_values(ROOT / ".env.local"),
    }
    url = env.get("NEXT_PUBLIC_SUPABASE_URL") or env.get("SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY") or env.get("SUPABASE_KEY")
    if not url or not key:
        sys.exit("ERROR: missing Supabase URL/key in .env.local or scraper/.env")
    return {"url": url, "key": key}


class Supa:
    def __init__(self, url: str, key: str):
        self.base = url.rstrip("/") + "/rest/v1"
        self.h = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    def get(self, table: str, params: dict) -> list[dict]:
        r = requests.get(f"{self.base}/{table}", headers=self.h, params=params, timeout=30)
        r.raise_for_status()
        return r.json()

    def patch(self, table: str, row_id: str, payload: dict) -> requests.Response:
        return requests.patch(
            f"{self.base}/{table}", headers=self.h,
            params={"id": f"eq.{row_id}"}, json=payload, timeout=30,
        )


class MetaImageParser(HTMLParser):
    """Pulls og:image / twitter:image content out of <meta> tags regardless
    of attribute order, without requiring a full HTML parser dependency."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.og_image: str | None = None
        self.twitter_image: str | None = None

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "meta":
            return
        d = {k.lower(): (v or "") for k, v in attrs}
        key = (d.get("property") or d.get("name") or "").lower()
        content = d.get("content")
        if not content:
            return
        if key == "og:image" and not self.og_image:
            self.og_image = content
        elif key == "twitter:image" and not self.twitter_image:
            self.twitter_image = content


def fetch_og_image(page_url: str) -> tuple[str | None, str]:
    """Returns (absolute image url or None, reason if None)."""
    try:
        r = requests.get(page_url, headers={"User-Agent": PAGE_UA, "Accept": "text/html"}, timeout=20)
    except Exception as exc:
        return None, f"fetch error: {exc}"
    if r.status_code != 200:
        return None, f"HTTP {r.status_code}"
    parser = MetaImageParser()
    try:
        parser.feed(r.text)
    except Exception as exc:
        return None, f"parse error: {exc}"
    raw = parser.og_image or parser.twitter_image
    if not raw:
        return None, "no og:image/twitter:image meta tag"
    abs_url = urllib.parse.urljoin(r.url, raw)
    return abs_url, ""


def verify_image(url: str) -> tuple[bool, int | None, str]:
    """Returns (ok, width_px_or_None, reason_if_rejected)."""
    fname = urllib.parse.urlsplit(url).path.rsplit("/", 1)[-1]
    if BAD_FILENAME_RE.search(fname):
        return False, None, f"filename looks like a logo/icon ({fname})"
    try:
        r = requests.get(url, headers={"User-Agent": PAGE_UA}, timeout=20, stream=True)
    except Exception as exc:
        return False, None, f"fetch error: {exc}"
    if r.status_code != 200:
        return False, None, f"HTTP {r.status_code}"
    ctype = r.headers.get("Content-Type", "")
    if not ctype.startswith("image/"):
        return False, None, f"not an image (Content-Type: {ctype})"
    if ctype.startswith("image/svg"):
        # Vector graphics here are theming/brand assets (help-center logos,
        # icon sprites), never a real venue/event photo — and Pillow can't
        # measure a width for them, which would otherwise silently bypass
        # MIN_WIDTH below. Reject outright rather than let a None width pass.
        return False, None, f"vector image, not a photo (Content-Type: {ctype})"
    try:
        from PIL import Image
        data = r.content  # small marketing images; fine to read fully
        with Image.open(io.BytesIO(data)) as im:
            width = im.width
    except Exception:
        width = None
    if width is not None and width < MIN_WIDTH:
        return False, width, f"too small ({width}px wide)"
    return True, width, ""


def gather_other_source_urls(supa: Supa, happening_id: str) -> list[str]:
    try:
        rows = supa.get("happening_sources", {"select": "source_url", "happening_id": f"eq.{happening_id}"})
    except Exception:
        return []
    urls, seen = [], set()
    for r in rows:
        u = r.get("source_url")
        if u and u not in seen:
            seen.add(u)
            urls.append(u)
    return urls


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    env = load_env()
    supa = Supa(env["url"], env["key"])

    happenings = supa.get("happenings", {
        "select": "id,slug,title,venue_name,place_id,source_url,booking_url,image_url,status",
        "status": "eq.live",
    })
    todo = [h for h in happenings if not h.get("image_url")]
    print(f"[happ-photos] {len(happenings)} live happenings, {len(todo)} without image_url, "
          f"write={'no' if args.dry_run else 'yes'}", flush=True)
    if args.limit:
        todo = todo[: args.limit]

    # Pass 1: gather a candidate og:image (or reason for none) per happening.
    candidates: dict[str, dict] = {}
    for h in todo:
        urls_to_try = [u for u in (h.get("source_url"), h.get("booking_url")) if u]
        urls_to_try += gather_other_source_urls(supa, h["id"])
        found = None
        reasons = []
        for page_url in urls_to_try:
            img_url, reason = fetch_og_image(page_url)
            if img_url:
                found = {"image_url": img_url, "page_url": page_url}
                break
            reasons.append(f"{page_url}: {reason}")
        candidates[h["id"]] = found or {"reasons": reasons}
        time.sleep(0.2)  # light politeness even though these are diverse third-party sites

    # Detect generic/shared og:image URLs (same URL reused across >1 happening).
    url_counts: dict[str, int] = {}
    for c in candidates.values():
        if c.get("image_url"):
            url_counts[c["image_url"]] = url_counts.get(c["image_url"], 0) + 1
    shared = {u for u, n in url_counts.items() if n > 1}

    # Build a lookup of place photos (from photos_wikimedia.py) for the venue-name fallback.
    places = supa.get("places", {"select": "id,name,image_url,image_quality", "prefecture": "eq.City of Edinburgh"})
    places_by_name = {p["name"].strip().lower(): p for p in places if p.get("image_url")}

    def find_place_fallback(venue_name: str | None):
        if not venue_name:
            return None
        vn = venue_name.strip().lower()
        for name, p in places_by_name.items():
            if name == vn or name in vn or vn in name:
                return p
        return None

    attached: list[dict] = []
    missed: list[dict] = []

    for i, h in enumerate(todo, start=1):
        cand = candidates[h["id"]]
        chosen_url = None
        method = None
        page_url = None
        width = None
        reasons: list[str] = list(cand.get("reasons") or [])

        if cand.get("image_url"):
            if cand["image_url"] in shared:
                reasons.append(f"og:image {cand['image_url']} shared by {url_counts[cand['image_url']]} happenings — generic default, skipped")
            else:
                ok, width, why = verify_image(cand["image_url"])
                if ok:
                    chosen_url, method, page_url = cand["image_url"], "og-image", cand["page_url"]
                else:
                    reasons.append(f"{cand['image_url']}: {why}")

        if not chosen_url:
            fallback = find_place_fallback(h.get("venue_name"))
            if fallback:
                chosen_url, method, page_url = fallback["image_url"], "place-photo-fallback", None
            else:
                reasons.append("no matching place with a photo for venue-name fallback")

        if chosen_url:
            attached.append({
                "happening_id": h["id"], "title": h["title"], "url": chosen_url,
                "method": method, "page_url": page_url, "width": width,
            })
            print(f"[happ-photos] {i}/{len(todo)} {h['title']!r} <- {method} {width or ''}px", flush=True)
            if not args.dry_run:
                r = supa.patch("happenings", h["id"], {
                    "image_url": chosen_url, "image_quality": "thin",
                })
                if r.status_code not in (200, 204):
                    print(f"[happ-photos]   ! patch failed: {r.status_code} {r.text[:200]}", file=sys.stderr)
        else:
            missed.append({"happening_id": h["id"], "title": h["title"], "reasons": reasons})
            print(f"[happ-photos] {i}/{len(todo)} {h['title']!r} -> no photo "
                  f"({reasons[-1] if reasons else 'no candidate'})", flush=True)

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "dry_run": args.dry_run,
        "total_candidates": len(todo),
        "attached_count": len(attached),
        "missed_count": len(missed),
        "shared_default_images_skipped": sorted(shared),
        "attached": attached,
        "missed": missed,
        "note": (
            "og:image URLs are the publisher's own promotional/social-share images, "
            "not openly-licensed photos. image_quality is deliberately left at 'thin' "
            "so happenings never win the Home ranker's photo-hero slot (see "
            "supabase/add_happenings.sql's comment on image_quality)."
        ),
    }
    out_path = OUT_DIR / ("happenings_dry_run.json" if args.dry_run else "happenings_report.json")
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[happ-photos] wrote report to {out_path}")
    print(f"[happ-photos] done. attached={len(attached)} missed={len(missed)}")


if __name__ == "__main__":
    main()
