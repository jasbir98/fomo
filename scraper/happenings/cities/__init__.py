"""City registry for the happenings research pipeline.

Add a new city by creating `scraper/happenings/cities/<slug>.py` with a
`CityHappeningsConfig` (see ../base.py) and registering it in `CITIES` below.
"""

from __future__ import annotations

from ..base import CityHappeningsConfig
from .edinburgh import EDINBURGH

CITIES: dict[str, CityHappeningsConfig] = {
    "edinburgh": EDINBURGH,
}


def get_city(slug: str) -> CityHappeningsConfig:
    try:
        return CITIES[slug]
    except KeyError as exc:
        raise ValueError(
            f"unknown --city {slug!r}. Must be one of: {', '.join(sorted(CITIES))}"
        ) from exc


__all__ = ["CityHappeningsConfig", "CITIES", "get_city", "EDINBURGH"]
