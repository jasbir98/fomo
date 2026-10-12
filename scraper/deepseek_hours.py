"""
deepseek_hours.py — keep every DeepSeek call out of DeepSeek's peak hours.

DeepSeek bills double during peak hours (https://api-docs.deepseek.com/quick_start/pricing,
checked 2026-10-12): 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday.
Weekends and every other hour are off-peak at half price. Fomo never calls
DeepSeek from a script during peak. The same windows are mirrored in
scripts/sources/core/deepseek.mjs for the Node daily ingest. Change both
together.

GitHub starts scheduled workflows hours late (a 06:17 cron started at 15:32
on 2026-10-12), so cron times alone can't guarantee this. Hence:
  - `make_research_client` (llm_client.py) refuses to build a DeepSeek client
    during peak, raising DeepSeekPeakHours;
  - the weekly workflow runs `python3 scraper/deepseek_hours.py --wait 60`
    first, which returns as soon as there is a clear off-peak hour ahead.

CLI:
  python3 scraper/deepseek_hours.py              # print status, exit 0 off-peak / 1 peak
  python3 scraper/deepseek_hours.py --wait 60    # sleep until 60 clear minutes, then exit 0
  python3 scraper/deepseek_hours.py --check 60   # exit 1 (with the next start time) if not clear now
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timedelta, timezone

PEAK_HOURS_UTC: tuple[tuple[int, int], ...] = ((1, 4), (6, 10))  # [start, end) hours, Mon-Fri


class DeepSeekPeakHours(RuntimeError):
    """Raised instead of calling DeepSeek during its peak window."""


def in_peak(now: datetime | None = None) -> bool:
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if now.weekday() >= 5:  # Saturday, Sunday
        return False
    return any(start <= now.hour < end for start, end in PEAK_HOURS_UTC)


def next_clear_start(now: datetime | None = None, need_minutes: int = 0) -> datetime:
    """Earliest time >= now from which `need_minutes` run entirely off-peak."""
    t = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(second=0, microsecond=0)
    for _ in range(8 * 24 * 60):  # peaks repeat weekly; a week of minutes always finds a gap
        if not any(in_peak(t + timedelta(minutes=m)) for m in range(0, need_minutes + 1, 5)):
            return t
        t += timedelta(minutes=1)
    raise RuntimeError("no off-peak window found")  # unreachable with the windows above


def peak_message(now: datetime | None = None, need_minutes: int = 0) -> str:
    start = next_clear_start(now, need_minutes)
    return f"DeepSeek peak hours (01-04 and 06-10 UTC, Mon-Fri). Next clear start: {start:%a %H:%M} UTC."


def guard() -> None:
    """Raise DeepSeekPeakHours when called during peak."""
    if in_peak():
        raise DeepSeekPeakHours(peak_message())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--wait", type=int, metavar="MINUTES", help="sleep until MINUTES of clear off-peak time lie ahead")
    group.add_argument("--check", type=int, metavar="MINUTES", help="exit 1 unless MINUTES of clear off-peak time lie ahead")
    args = parser.parse_args()
    need = args.wait if args.wait is not None else (args.check or 0)
    now = datetime.now(timezone.utc)
    start = next_clear_start(now, need)
    if start <= now + timedelta(minutes=1):
        print(f"[deepseek-hours] off-peak now ({now:%a %H:%M} UTC); {need} clear minute(s) ahead.")
        return 0
    if args.wait is None:
        print(f"::error::{peak_message(now, need)}")
        return 1
    seconds = (start - now).total_seconds()
    print(f"[deepseek-hours] {peak_message(now, need)} Waiting {seconds / 60:.0f} min.", flush=True)
    time.sleep(seconds)
    return 0


if __name__ == "__main__":
    sys.exit(main())
