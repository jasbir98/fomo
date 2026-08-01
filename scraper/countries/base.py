"""Shared country-config contract for the places discovery/extraction pipeline.

Each country config supplies only the pieces that actually differ between
countries: the administrative-unit -> region grouping used by
discover_cities.py's Stage 1 loop, and a couple of prompt fragments consumed
by discover_cities.py (Stage 1) and discover_and_extract_city.py (Stage 2).
Everything else — resumability, dedupe-key format, citation/validation
rules, the places_staging schema — is shared code and stays in the two
scripts.

Add a new country by creating `scraper/countries/<name>.py` with a
`CountryConfig` instance and registering it in `scraper/countries/__init__.py`.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CountryConfig:
    # Stored in `places.country` / `places_staging.country`, e.g. "JP", "GB".
    code: str
    # Human-readable country name used in prompts and CLI help, e.g. "Japan", "Scotland".
    name: str
    # Adjective form used in Stage 1 prompt copy, e.g. "Japanese", "Scottish".
    demonym: str
    # What one entry of admin_unit_region is called in prompts/CLI help,
    # e.g. "prefecture", "council area".
    admin_unit_label: str
    # Administrative unit -> region grouping. Must be a complete,
    # non-overlapping partition of the country (mirrors Japan's 47
    # prefectures grouped into 9 regions) so the Stage 1 discovery loop
    # covers the whole country with no gaps or double-counting.
    admin_unit_region: dict[str, str]
    # Comma-separated example categories for Stage 2 prompts, e.g.
    # "shrines, temples, parks, museums, viewpoints, markets, landmarks, gardens".
    category_examples: str
    # Sentence(s) naming preferred/avoided sources for Stage 2 research.
    source_guidance: str

    @property
    def admin_units(self) -> list[str]:
        """Ordered list of admin units (dict preserves insertion order)."""
        return list(self.admin_unit_region.keys())

    @property
    def regions(self) -> list[str]:
        """Ordered list of unique regions, in first-seen order."""
        seen: dict[str, None] = {}
        for region in self.admin_unit_region.values():
            seen.setdefault(region, None)
        return list(seen.keys())
