#!/usr/bin/env python3
"""Daily re-verification of live happenings against their own source pages.

The app shows "Checked Nd ago" on every card and hides it once a row is 14
days old (lib/happenings/format.ts). This keeps rows well inside that window:
every live row not confirmed in the last 7 days has its source page reloaded
and its hard facts (saving label, promo code, dates, weekly days) matched
again, with the check the weekly pipeline uses (weekly_edinburgh.verify_record),
except that a reworded saving label passes when its £ amounts and percentages
are on the page. No AI calls, so it is safe in DeepSeek's
peak hours.

  - every fact still on the page -> verified_at = now
  - the source answers 404/410   -> status = retired
  - anything else (block, timeout, changed wording) -> left as it is and
    listed in the report, so a person can look; the row keeps its old
    verified_at and drops its "Checked" line once it passes 14 days.

Usage:
  python3 scraper/recheck_live.py --dry-run   # report only, no writes
  python3 scraper/recheck_live.py             # apply
"""

from __future__ import annotations

import argparse
import concurrent.futures
import os
from datetime import datetime, timezone

from weekly_edinburgh import overdue_live_rows, patch_live_rechecks, verify_record

RECHECK_AFTER_DAYS = 7


def main() -> None:
    parser = argparse.ArgumentParser(description="Re-verify live happenings older than N days against their source pages.")
    parser.add_argument("--after-days", type=int, default=RECHECK_AFTER_DAYS)
    parser.add_argument("--dry-run", action="store_true", help="Report what would change; write nothing.")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    rows, failure = overdue_live_rows(args.after_days)
    if failure:
        raise SystemExit(failure)

    confirmed: list[dict] = []
    retired: list[dict] = []
    unconfirmed: list[tuple[dict, list[str]]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for row, reasons in pool.map(lambda row: verify_record(row, recheck=True), rows):
            if not reasons:
                confirmed.append(row)
            elif any("HTTP 404" in r or "HTTP 410" in r for r in reasons):
                retired.append(row)
            else:
                unconfirmed.append((row, reasons))

    note = None
    if not args.dry_run and (confirmed or retired):
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        note = patch_live_rechecks([r["id"] for r in confirmed], [r["id"] for r in retired], now)

    verb = "would be" if args.dry_run else "were"
    lines = [
        f"### Live recheck ({'dry run' if args.dry_run else 'applied'})",
        "",
        f"{len(rows)} live rows older than {args.after_days} days: {len(confirmed)} {verb} re-confirmed, "
        f"{len(retired)} {verb} retired (404/410), {len(unconfirmed)} could not be confirmed.",
    ]
    if note:
        lines += ["", f"**Write failed:** {note}"]
    if retired:
        lines += ["", "**Retired**", ""] + [f"- {r['title']} ({r['source_url']})" for r in retired]
    if unconfirmed:
        lines += ["", "**Not confirmed** (left live, check by hand)", ""]
        lines += [f"- {r['title']} — {'; '.join(reasons)} ({r['source_url']})" for r, reasons in unconfirmed]
    report = "\n".join(lines) + "\n"
    print(report)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as fh:
            fh.write(report)
    if note:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
