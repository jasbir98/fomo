"""City of Edinburgh Council school holidays, for the weekly research topics.

Source: https://www.edinburgh.gov.uk/schools/term-dates (read 20 Oct 2026). Dates are
inclusive: the first and last day of the break, weekends included.

THIS LIST MUST BE EXTENDED EVERY YEAR from that page. `upcoming_holiday` returns None once
the last entry has passed, and `warn_if_stale` logs a warning, so a stale list is noisy
rather than silently dropping the holiday topics.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class SchoolHoliday:
    name: str  # as used in a sentence: "the Christmas holidays"
    label: str  # short: "Christmas 2026"
    start: date
    end: date

    @property
    def date_range(self) -> str:
        """'21 Dec 2026 – 5 Jan 2027' (no leading zeros)."""
        def fmt(d: date) -> str:
            return f"{d.day} {d.strftime('%b %Y')}"
        return f"{fmt(self.start)} – {fmt(self.end)}"


HOLIDAYS: tuple[SchoolHoliday, ...] = (
    SchoolHoliday("the October holidays", "October 2026", date(2026, 10, 12), date(2026, 10, 19)),
    SchoolHoliday("the Christmas holidays", "Christmas 2026", date(2026, 12, 21), date(2027, 1, 5)),
    SchoolHoliday("the February break", "February 2027", date(2027, 2, 15), date(2027, 2, 19)),
    SchoolHoliday("the Easter holidays", "Easter 2027", date(2027, 4, 5), date(2027, 4, 19)),
    # Term ends Tue 29 Jun 2027; the 2027/28 autumn term starts Wed 18 Aug 2027.
    SchoolHoliday("the summer holidays", "Summer 2027", date(2027, 6, 30), date(2027, 8, 17)),
    SchoolHoliday("the October holidays", "October 2027", date(2027, 10, 18), date(2027, 10, 25)),
    SchoolHoliday("the Christmas holidays", "Christmas 2027", date(2027, 12, 21), date(2028, 1, 5)),
    SchoolHoliday("the February break", "February 2028", date(2028, 2, 14), date(2028, 2, 18)),
    SchoolHoliday("the Easter holidays", "Easter 2028", date(2028, 4, 3), date(2028, 4, 17)),
)


def upcoming_holiday(today: date, lead_days: int = 21) -> SchoolHoliday | None:
    """The holiday whose window [start - lead_days, end] contains `today`, else None."""
    for holiday in HOLIDAYS:
        if holiday.start - timedelta(days=lead_days) <= today <= holiday.end:
            return holiday
    return None


def warn_if_stale(today: date) -> bool:
    """Log a warning (and return True) when `today` is past the last listed holiday."""
    last = HOLIDAYS[-1]
    if today > last.end:
        log.warning(
            "school_holidays.HOLIDAYS ends at %s (%s): extend it from "
            "https://www.edinburgh.gov.uk/schools/term-dates", last.end.isoformat(), last.label,
        )
        return True
    return False
