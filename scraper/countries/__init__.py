"""Country configs for the places discovery/extraction pipeline.

Add a new country by creating `scraper/countries/<name>.py` with a
`CountryConfig` (see base.py) and registering it in `COUNTRIES` below.
"""

from __future__ import annotations

from .base import CountryConfig
from .japan import JAPAN
from .scotland import SCOTLAND

COUNTRIES: dict[str, CountryConfig] = {
    "japan": JAPAN,
    "scotland": SCOTLAND,
}


def get_country(name: str) -> CountryConfig:
    try:
        return COUNTRIES[name]
    except KeyError as exc:
        raise ValueError(
            f"unknown --country {name!r}. Must be one of: {', '.join(sorted(COUNTRIES))}"
        ) from exc


__all__ = ["CountryConfig", "COUNTRIES", "get_country", "JAPAN", "SCOTLAND"]
