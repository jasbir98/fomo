"""Deal-source configs.

A source is {id, name, trust, status, discover, extract_hints}.

  trust   'official'   -- the publisher is the body that runs the offer. A deal that
                          passes every gate on a LIVE official source is treated like
                          a verified row (eligible for --publish).
          'commercial' -- a third party's page. Deals are always staged for review
                          with reason `commercial_source_review`.
  status  'shadow'     -- fetch, extract, gate and report; never staged or published.
          'live'       -- staged (and, for official sources, publishable).

`discover` is one of (all return page refs for discover.py):
  {'kind': 'wp_rest', 'urls': [...], 'modified_within_days': N}
        WordPress REST URL(s) returning page JSON (`content.rendered`, `link`,
        `featured_media` / `_embed`). A list response is every item; a dict is one.
  {'kind': 'sitemap', 'url': ..., 'pattern': regex, 'limit': N}
        sitemap (or sitemap index) filtered by a regex on the <loc> URL.
  {'kind': 'urls', 'urls': [...]}
        a fixed list of pages.
  {'kind': 'link_list', 'url': ..., 'href_pattern': regex, 'limit': N}
        a listing page whose matching <a href> links are the deal pages.

`edinburgh=True` marks a source whose whole catalogue is Edinburgh, so a deal with
no EH postcode in its text is still accepted (a deal that states a NON-EH postcode
is rejected regardless).

Starting a source in 'shadow' and promoting it to 'live' after one reviewed report
is the intended workflow (plan §7c).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class DealSource:
    id: str
    name: str
    trust: str  # 'official' | 'commercial'
    status: str  # 'shadow' | 'live'
    discover: dict[str, Any]
    extract_hints: str = ""
    edinburgh: bool = False
    # Pages with several deals each (a listing of venue offers) get no page-level
    # image: the page's og:image is a generic banner, not the venue's.
    multi_deal_pages: bool = False
    # Regex for the opening tag of one offer card on a multi-offer page. When it matches,
    # the page is split into cards deterministically and each LLM call sees a handful of
    # whole cards (runner.SEGMENT_BATCH) instead of an arbitrary slice of the page.
    segment: str | None = None
    # An eligibility the whole scheme shares and the page states once (not per offer card).
    default_eligibility: str | None = None
    default_category: str = "food"

    def __post_init__(self) -> None:
        if self.trust not in ("official", "commercial"):
            raise ValueError(f"{self.id}: trust must be 'official' or 'commercial'")
        if self.status not in ("shadow", "live"):
            raise ValueError(f"{self.id}: status must be 'shadow' or 'live'")
        if self.discover.get("kind") not in ("wp_rest", "sitemap", "urls", "link_list"):
            raise ValueError(f"{self.id}: unknown discover kind {self.discover.get('kind')!r}")


_FOREVER_PAGES_URL = "https://edinburgh.org/wp-json/wp/v2/pages?parent=5095&per_page=100&orderby=modified&_embed"

SOURCES: tuple[DealSource, ...] = (
    DealSource(
        id="forever-edinburgh-offers",
        name="Forever Edinburgh offers",
        trust="official",
        status="shadow",
        edinburgh=True,
        discover={
            "kind": "wp_rest",
            "urls": [_FOREVER_PAGES_URL],
            # ~67 pages, most long expired; the list is ordered by modified date, so
            # only pages touched in the last 120 days are considered.
            "modified_within_days": 120,
        },
        extract_hints=(
            "Each page is one offer from Forever Edinburgh's offers-and-deals directory, usually a single "
            "deal: the venue, what you get, the price, and a 'Terms and conditions' list holding the valid "
            "dates, days and times, booking rules and who can claim it. Return at most one deal per page "
            "unless the page clearly lists several separate offers. Offers that are only a full-price "
            "package, a hotel stay, or a ticket at a normal price with no saving, discount, free item or "
            "special reduced price are not deals: leave them out."
        ),
    ),
    DealSource(
        id="more-by-the-shore",
        name="More By The Shore specials",
        trust="official",
        status="shadow",
        edinburgh=True,
        multi_deal_pages=True,
        segment=r"<div data-promotion-container\s",
        discover={
            "kind": "wp_rest",
            "urls": ["https://edinburgh.org/wp-json/wp/v2/pages?slug=more-by-the-shore-specials&_embed"],
        },
        extract_hints=(
            "One page lists around 35 offers from Leith and Newhaven businesses. Each venue block has the "
            "venue name, a description, an Edinburgh address with an EH postcode, a valid date range "
            "(e.g. '01 October - 08 November 2026'), a 'Terms & Conditions' section and sometimes a promo "
            "code. Return one deal per venue block whose offer is a saving: a discount, a free item, a "
            "2-for-1, or a stated special price below a normal price. Blocks that only describe a product "
            "or exclusive menu item with a plain price are not deals: leave them out. The venue's own "
            "website link follows its block: use it as booking_url."
        ),
    ),
    DealSource(
        id="resident-rewards",
        name="Forever Edinburgh Resident Rewards",
        trust="official",
        status="shadow",
        edinburgh=True,
        multi_deal_pages=True,
        segment=r"<div data-promotion-container\s",
        default_eligibility="local_resident",
        discover={
            "kind": "wp_rest",
            "urls": [
                "https://edinburgh.org/wp-json/wp/v2/pages/7239",
                "https://edinburgh.org/wp-json/wp/v2/pages?parent=7239&per_page=100",
            ],
        },
        extract_hints=(
            "Edinburgh Resident Rewards: offers for people who live in Edinburgh, with eligibility "
            "'local_resident' when the page says the offer is for residents (usually with proof of address "
            "or an Edinburgh postcode). Pages list partner offers, reward days and exclusive deals; return "
            "one deal per distinct offer that states a saving, a free entry or a discounted price. Generic "
            "programme description with no concrete offer is not a deal: leave it out."
        ),
    ),
)


def get_sources(ids: list[str] | None = None) -> tuple[DealSource, ...]:
    if not ids:
        return SOURCES
    wanted = {i.lower() for i in ids}
    chosen = tuple(s for s in SOURCES if s.id.lower() in wanted)
    missing = wanted - {s.id.lower() for s in chosen}
    if missing:
        raise ValueError(f"unknown deal source id(s): {', '.join(sorted(missing))}; known: {', '.join(s.id for s in SOURCES)}")
    return chosen
