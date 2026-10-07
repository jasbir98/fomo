#!/usr/bin/env python3
"""
fetch_happening_pages.py -- save the publisher page behind each live
`happenings` row so an extraction agent can read it offline (step 3 of
docs/plans/2026-10-07-data-enrichment.md).

Per row: try source_url, then booking_url. Headless Chromium (Playwright sync
API), en-GB, realistic desktop UA. Polite by construction:
  - robots.txt is honoured (urllib.robotparser, cached per domain; if the
    robots file can't be fetched the page is allowed -- same stance as
    weekly_edinburgh.robot_allows).
  - >= 2 s between requests to the same domain, across all workers.
  - HTTP >= 400, a bot-challenge page or a CAPTCHA is recorded as
    status="blocked" and skipped. Never bypassed, never retried with tricks.

Saved to <out-dir>/pages/<happening_id>.json:
  {id, url, final_url, status: ok|blocked|error, reason, title, text,
   json_ld, og_image, fetched_at}
plus <out-dir>/pages-index.json summarising every row.

Rows are processed gappiest first (no GBP figure and not free; no time_note;
no redemption_note; no summary), so a --limit run covers the rows that need
the data most.

Usage:
    scraper/.venv/bin/python scraper/fetch_happening_pages.py --limit 20
    scraper/.venv/bin/python scraper/fetch_happening_pages.py --only <id>,<id>
    scraper/.venv/bin/python scraper/fetch_happening_pages.py --input rows.json \
        --out-dir /tmp/pages-test

Env (live mode only): NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and
SUPABASE_SERVICE_ROLE_KEY, from .env.local / scraper/.env. Reads only.

One-off setup if Chromium is missing:
    scraper/.venv/bin/python -m playwright install chromium
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
import urllib.robotparser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
SCRAPER_DIR = ROOT / "scraper"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
ROBOTS_AGENT = "*"
DOMAIN_DELAY_S = 2.0
NAV_TIMEOUT_MS = 25_000
IDLE_WAIT_MS = 8_000
MAX_TEXT_CHARS = 15_000
MAX_JSON_LD = 20
MAX_JSON_LD_CHARS = 60_000

SELECT = (
    "id,title,venue_name,source_url,booking_url,summary,saving_label,"
    "saving_amount,is_free,time_note,redemption_note,eligibility_note,"
    "allowance_note,place_id"
)

# --- Challenge detection ----------------------------------------------------
# Copied from scraper/weekly_edinburgh.py (CHALLENGE_MARKERS and
# _looks_like_challenge_page). Not imported: that module loads dotenv, mutates
# sys.path and imports the research/LLM stack at import time. Keep in sync.
# Deliberately excludes bare "captcha"/"cloudflare"/"access denied": fully
# served pages routinely contain those without being blocked.
CHALLENGE_MARKERS = (
    "cf-chl-", "cf_chl_opt", "__cf_chl_rt_tk",
    "checking your browser before accessing",
    "just a moment...",
    "attention required! | cloudflare",
    "enable javascript and cookies to continue",
    "verify you are human", "verifying you are human",
    "request unsuccessful. incapsula",
    "sorry, you have been blocked",
    "unusual traffic from your computer network",
)


def _looks_like_challenge_page(html: str, visible_text: str) -> bool:
    lowered = html.lower()
    if any(marker in lowered for marker in CHALLENGE_MARKERS):
        return True
    if len(html) < 20_000 and len(visible_text.strip()) < 200:
        return True
    return False


# --- Env / input ------------------------------------------------------------
def load_env() -> dict:
    return {
        **dotenv_values(SCRAPER_DIR / ".env"),
        **dotenv_values(ROOT / ".env.local"),
    }


def fetch_live_rows() -> list[dict]:
    env = load_env()
    base = (env.get("NEXT_PUBLIC_SUPABASE_URL") or env.get("SUPABASE_URL") or "").rstrip("/")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not base or not key:
        sys.exit(
            "ERROR: missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) / "
            "SUPABASE_SERVICE_ROLE_KEY in .env.local or scraper/.env "
            "(or pass --input <rows.json>)"
        )
    rows: list[dict] = []
    page = 1000
    for offset in range(0, 100_000, page):
        url = f"{base}/rest/v1/happenings?status=eq.live&select={SELECT}&order=id.asc&limit={page}&offset={offset}"
        req = urllib.request.Request(url, headers={"apikey": key, "Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            chunk = json.load(resp)
        rows.extend(chunk)
        if len(chunk) < page:
            break
    return rows


def gap_score(row: dict) -> int:
    """Higher = more gaps = fetch first."""
    score = 0
    has_money = bool(row.get("saving_amount")) or "£" in (row.get("saving_label") or "")
    if not has_money and not row.get("is_free"):
        score += 1
    for field in ("time_note", "redemption_note", "summary"):
        if not (row.get(field) or "").strip():
            score += 1
    return score


# --- Politeness -------------------------------------------------------------
class DomainLimiter:
    """Reserves request slots so each domain sees >= delay seconds between hits."""

    def __init__(self, delay: float):
        self.delay = delay
        self._lock = threading.Lock()
        self._next: dict[str, float] = {}

    def wait(self, domain: str) -> None:
        with self._lock:
            now = time.monotonic()
            slot = max(now, self._next.get(domain, 0.0))
            self._next[domain] = slot + self.delay
        pause = slot - time.monotonic()
        if pause > 0:
            time.sleep(pause)


class RobotsCache:
    def __init__(self):
        self._lock = threading.Lock()
        self._parsers: dict[str, urllib.robotparser.RobotFileParser | None] = {}

    def allows(self, url: str, limiter: DomainLimiter) -> bool:
        parts = urllib.parse.urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        with self._lock:
            known = origin in self._parsers
            parser = self._parsers.get(origin)
        if not known:
            parser = self._load(origin, parts.netloc.lower(), limiter)
            with self._lock:
                self._parsers[origin] = parser
        if parser is None:
            return True
        return parser.can_fetch(ROBOTS_AGENT, url)

    @staticmethod
    def _load(origin: str, domain: str, limiter: DomainLimiter):
        limiter.wait(domain)
        try:
            req = urllib.request.Request(f"{origin}/robots.txt", headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=15) as resp:
                text = resp.read(500_000).decode("utf-8", errors="replace")
        except Exception:
            return None  # unreachable / 4xx / 5xx: allow, as weekly_edinburgh does
        parser = urllib.robotparser.RobotFileParser()
        parser.parse(text.splitlines())
        return parser


# --- Extraction -------------------------------------------------------------
_WS_RUN = re.compile(r"[ \t\f\v ]+")
_BLANK_LINES = re.compile(r"\n\s*\n+")


def collapse_text(text: str) -> str:
    """Collapse whitespace runs but keep line breaks."""
    text = text.replace("\r", "")
    text = _WS_RUN.sub(" ", text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    text = _BLANK_LINES.sub("\n", text)
    return text.strip()


EXTRACT_JS = """
() => {
  const pick = document.querySelector('main, article, [role=main]') || document.body;
  const text = pick ? pick.innerText : '';
  const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map(s => s.textContent || '');
  const og = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
  return {
    title: document.title || '',
    text,
    ld,
    og: og ? og.getAttribute('content') : null,
    visible: document.body ? document.body.innerText : '',
  };
}
"""


def parse_json_ld(blobs: list[str]) -> list:
    out = []
    for blob in blobs:
        if len(out) >= MAX_JSON_LD:
            break
        if not blob.strip() or len(blob) > MAX_JSON_LD_CHARS:
            continue
        try:
            out.append(json.loads(blob))
        except ValueError:
            continue
    return out


def fetch_one(page, url: str, robots: RobotsCache, limiter: DomainLimiter) -> dict:
    """Fetch one URL. Returns a result dict (never raises)."""
    base = {
        "url": url, "final_url": None, "status": "error", "reason": None,
        "title": None, "text": None, "json_ld": [], "og_image": None,
    }
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return {**base, "reason": "not an http(s) URL"}
    domain = parts.netloc.lower()
    if not robots.allows(url, limiter):
        return {**base, "status": "blocked", "reason": "robots.txt disallows this page"}
    limiter.wait(domain)
    try:
        resp = page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
    except Exception as exc:  # noqa: BLE001
        return {**base, "reason": f"navigation failed: {type(exc).__name__}: {str(exc).splitlines()[0][:160]}"}
    try:
        page.wait_for_load_state("networkidle", timeout=IDLE_WAIT_MS)
    except Exception:  # noqa: BLE001
        pass  # chatty pages never go idle; carry on with what has rendered
    status_code = resp.status if resp else None
    final_url = page.url
    base["final_url"] = final_url
    if status_code is not None and status_code >= 400:
        return {**base, "status": "blocked", "reason": f"blocked/challenged (HTTP {status_code})"}
    try:
        html = page.content()
        data = page.evaluate(EXTRACT_JS)
    except Exception as exc:  # noqa: BLE001
        return {**base, "reason": f"extract failed: {type(exc).__name__}"}
    title = (data.get("title") or "").strip()
    if _looks_like_challenge_page(html, data.get("visible") or ""):
        return {**base, "status": "blocked", "title": title, "reason": f"blocked/challenged (HTTP {status_code})"}
    if "captcha" in title.lower():
        return {**base, "status": "blocked", "title": title, "reason": "CAPTCHA page"}
    text = collapse_text(data.get("text") or "")[:MAX_TEXT_CHARS]
    og = data.get("og")
    if og:
        og = urllib.parse.urljoin(final_url, og)
    return {
        **base,
        "status": "ok",
        "title": title,
        "text": text,
        "json_ld": parse_json_ld(data.get("ld") or []),
        "og_image": og,
    }


def candidate_urls(row: dict) -> list[str]:
    urls: list[str] = []
    for key in ("source_url", "booking_url"):
        u = (row.get(key) or "").strip()
        if u and u not in urls:
            urls.append(u)
    return urls


def process_row(row: dict, page, robots: RobotsCache, limiter: DomainLimiter) -> dict:
    urls = candidate_urls(row)
    attempts: list[dict] = []
    result = None
    for url in urls:
        res = fetch_one(page, url, robots, limiter)
        attempts.append(res)
        if res["status"] == "ok":
            result = res
            break
    if result is None:
        if attempts:
            # Prefer reporting a block over a generic error.
            result = next((a for a in attempts if a["status"] == "blocked"), attempts[0])
            if len(attempts) > 1:
                result = {**result, "reason": "; ".join(f"{a['url']}: {a['reason']}" for a in attempts)}
        else:
            result = {
                "url": None, "final_url": None, "status": "error", "reason": "no source_url or booking_url",
                "title": None, "text": None, "json_ld": [], "og_image": None,
            }
    return {"id": row["id"], **result, "fetched_at": datetime.now(timezone.utc).isoformat()}


# --- Workers ----------------------------------------------------------------
def run_worker(rows: list[dict], out_pages: Path, robots: RobotsCache, limiter: DomainLimiter,
               results: dict, lock: threading.Lock, total: int) -> None:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=USER_AGENT,
            locale="en-GB",
            viewport={"width": 1366, "height": 900},
            timezone_id="Europe/London",
        )
        page = context.new_page()
        try:
            for row in rows:
                record = process_row(row, page, robots, limiter)
                (out_pages / f"{row['id']}.json").write_text(
                    json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                with lock:
                    results[row["id"]] = {
                        "id": row["id"], "title": row.get("title"), "status": record["status"],
                        "url": record["final_url"] or record["url"], "reason": record["reason"],
                        "text_chars": len(record["text"] or ""),
                    }
                    print(f"[{len(results)}/{total}] {record['status']:<7} {row.get('title','')[:50]} "
                          f"{'- ' + record['reason'] if record['reason'] else ''}", flush=True)
        finally:
            context.close()
            browser.close()


def main() -> None:
    ap = argparse.ArgumentParser(description="Save publisher pages behind live happenings for enrichment.")
    ap.add_argument("--input", help="JSON file: array of happening rows (skips Supabase).")
    ap.add_argument("--limit", type=int, help="Process at most N rows (after ordering).")
    ap.add_argument("--only", help="Comma-separated happening ids.")
    ap.add_argument("--out-dir", help="Default scraper/out/enrich-YYYY-MM-DD")
    ap.add_argument("--concurrency", type=int, default=3, help="Browser pages in parallel (default 3).")
    args = ap.parse_args()

    if args.input:
        rows = json.loads(Path(args.input).read_text(encoding="utf-8"))
    else:
        rows = fetch_live_rows()
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        rows = [r for r in rows if r["id"] in wanted]
    # Stable sort: gappiest first, input order otherwise.
    rows = sorted(rows, key=lambda r: -gap_score(r))
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        sys.exit("No rows to fetch.")

    out_dir = Path(args.out_dir) if args.out_dir else SCRAPER_DIR / "out" / f"enrich-{datetime.now().strftime('%Y-%m-%d')}"
    out_pages = out_dir / "pages"
    out_pages.mkdir(parents=True, exist_ok=True)

    limiter = DomainLimiter(DOMAIN_DELAY_S)
    robots = RobotsCache()
    results: dict[str, dict] = {}
    lock = threading.Lock()
    workers = max(1, min(args.concurrency, len(rows)))
    # Round-robin split keeps each worker's slice gappiest-first.
    slices = [rows[i::workers] for i in range(workers)]
    print(f"Fetching {len(rows)} row(s) with {workers} worker(s) -> {out_pages}", flush=True)

    errors: list[BaseException] = []

    def guarded(chunk):
        try:
            run_worker(chunk, out_pages, robots, limiter, results, lock, len(rows))
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(guarded, slices))

    index = [results[r["id"]] for r in rows if r["id"] in results]
    (out_dir / "pages-index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    counts: dict[str, int] = {}
    for item in index:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    print(f"Done: {counts} of {len(rows)}. Index: {out_dir / 'pages-index.json'}")
    if errors:
        print(f"WARNING: {len(errors)} worker(s) crashed: {errors[0]!r}", file=sys.stderr)
        if "Executable doesn't exist" in str(errors[0]):
            print("Chromium missing. Run: scraper/.venv/bin/python -m playwright install chromium", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
