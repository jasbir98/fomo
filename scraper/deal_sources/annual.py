"""Annual promotions (annual.yaml) as `urls` sources, read only inside their window.

An entry is read from six weeks before the first day of its `usual_month` through the
last day of that month, so a promotion announced for an August-to-September window is
picked up before it starts and dropped once it has passed. get_sources() (registry.py)
includes the entries whose window contains today; naming one with --deal-source reads it
whatever the date.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import yaml

from deal_sources.registry import DealSource

ANNUAL_PATH = Path(__file__).with_name("annual.yaml")
LEAD_WEEKS = 6
LONDON = ZoneInfo("Europe/London")
REQUIRED_KEYS = ("id", "name", "usual_month", "url", "trust")


@dataclass(frozen=True)
class Annual:
    id: str
    name: str
    usual_month: int
    url: str
    trust: str


def _check_entry(row: Any, index: int) -> Annual:
    if not isinstance(row, dict):
        raise ValueError(f"annual.yaml entry {index} is not a mapping")
    missing = [k for k in REQUIRED_KEYS if not row.get(k)]
    if missing:
        raise ValueError(f"annual.yaml entry {index} ({row.get('id')!r}) lacks {', '.join(missing)}")
    month = row["usual_month"]
    if isinstance(month, bool) or not isinstance(month, int) or not 1 <= month <= 12:
        raise ValueError(f"annual.yaml {row['id']}: usual_month must be 1-12")
    url = str(row["url"])
    if not url.startswith(("http://", "https://")):
        raise ValueError(f"annual.yaml {row['id']}: url must be http(s)")
    if row["trust"] not in ("official", "commercial"):
        raise ValueError(f"annual.yaml {row['id']}: trust must be official or commercial")
    return Annual(str(row["id"]), str(row["name"]), month, url, str(row["trust"]))


def load_annual(path: Path = ANNUAL_PATH) -> tuple[Annual, ...]:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or []
    if not isinstance(data, list):
        raise ValueError("annual.yaml must be a list of entries")
    entries = tuple(_check_entry(row, i) for i, row in enumerate(data, 1))
    ids = [e.id for e in entries]
    if len(set(ids)) != len(ids):
        raise ValueError("annual.yaml has duplicate ids")
    return entries


def window_for(usual_month: int, year: int) -> tuple[date, date]:
    """First and last day on which an entry for `usual_month` in `year` is read."""
    first = date(year, usual_month, 1)
    last = date(year, usual_month, calendar.monthrange(year, usual_month)[1])
    return first - timedelta(weeks=LEAD_WEEKS), last


def in_window(entry: Annual, today: date) -> bool:
    # Check the neighbouring years too: a January entry's window opens in the previous year.
    return any(start <= today <= end
               for start, end in (window_for(entry.usual_month, y) for y in (today.year - 1, today.year, today.year + 1)))


def london_today() -> date:
    return datetime.now(LONDON).date()


def annual_sources(today: date | None = None, *, all_entries: bool = False) -> tuple[DealSource, ...]:
    """Annual entries as shadow `urls` sources: the ones whose window holds `today`, or all."""
    today = today or london_today()
    return tuple(
        DealSource(
            id=entry.id,
            name=entry.name,
            trust=entry.trust,
            status="shadow",
            discover={"kind": "urls", "urls": [entry.url]},
            extract_hints=(
                f"{entry.name}: a national promotion that runs each year around month {entry.usual_month}. "
                "Its page lists the offers and the venues taking part. Return only offers that state a saving "
                "or a free entry, and only at a venue or event in Edinburgh (an EH postcode or an Edinburgh "
                "address stated in the offer)."
            ),
        )
        for entry in load_annual()
        if all_entries or in_window(entry, today)
    )
