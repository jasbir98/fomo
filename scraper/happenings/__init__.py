"""Happenings research pipeline package — city configs for
`scraper/happenings_research.py`.

Mirrors `scraper/countries/`'s package shape. See `base.py` for the
`CityHappeningsConfig` contract and `cities/__init__.py` for the registry.
"""

from __future__ import annotations

from .base import CityHappeningsConfig
from .cities import CITIES, get_city

__all__ = ["CityHappeningsConfig", "CITIES", "get_city"]
