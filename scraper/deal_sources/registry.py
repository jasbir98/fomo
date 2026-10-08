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
  {'kind': 'sitemap', 'url' | 'urls': ..., 'pattern': regex, 'limit': N,
   'modified_within_days': N}
        sitemap(s) (or sitemap indexes) filtered by a regex on the <loc> URL. With
        `modified_within_days`, only URLs whose <lastmod> is that recent are kept
        (a URL with no <lastmod> is dropped).
  {'kind': 'urls', 'urls': [...]}
        a fixed list of pages.
  {'kind': 'link_list', 'url': ..., 'href_pattern': regex, 'limit': N}
        a listing page whose matching <a href> links are the deal pages.

`edinburgh=True` marks a source whose whole catalogue is Edinburgh, so a deal with
no EH postcode in its text is still accepted (a deal that states a NON-EH postcode
is rejected regardless).

`edinburgh_evidence` is a verbatim string (matched after normalising case and
whitespace) that the page itself states to prove the location, e.g. a venue
address with its EH postcode in the page footer. When it is on the page, every
deal from that page passes the Edinburgh rule (a NON-EH postcode in a deal's own
text still rejects it). Use it on multi-offer pages, where a deal's own text does
not carry the address.

`national_ok=True` lets a national offer through the Edinburgh rule when the deal
states no postcode at all (e.g. a chain's UK-wide offer valid at its Edinburgh
restaurants). The record gets scope `national` and `national_venue` as its venue
name. A deal that states a non-EH postcode is still rejected. Never set it on a
page that lists different local offers for different towns.

`multi_deal_pages=True` marks a page that lists several offers (no page-level
image; the EH rule looks at each deal's own text, plus `edinburgh_evidence`).

Starting a source in 'shadow' and promoting it to 'live' after one reviewed report
is the intended workflow (plan §7c).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
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
    # Verbatim page text that proves the offers are in Edinburgh (see module docstring).
    edinburgh_evidence: str | None = None
    # A UK-wide offer valid at the chain's Edinburgh venues (see module docstring).
    national_ok: bool = False
    national_venue: str | None = None

    def __post_init__(self) -> None:
        if self.trust not in ("official", "commercial"):
            raise ValueError(f"{self.id}: trust must be 'official' or 'commercial'")
        if self.status not in ("shadow", "live"):
            raise ValueError(f"{self.id}: status must be 'shadow' or 'live'")
        if self.discover.get("kind") not in ("wp_rest", "sitemap", "urls", "link_list"):
            raise ValueError(f"{self.id}: unknown discover kind {self.discover.get('kind')!r}")
        if self.edinburgh_evidence is not None and not self.edinburgh_evidence.strip():
            raise ValueError(f"{self.id}: edinburgh_evidence is empty")
        if self.national_ok and not self.national_venue:
            raise ValueError(f"{self.id}: national_ok needs national_venue")


_FOREVER_PAGES_URL = "https://edinburgh.org/wp-json/wp/v2/pages?parent=5095&per_page=100&orderby=modified&_embed"

SOURCES: tuple[DealSource, ...] = (
    DealSource(
        id="forever-edinburgh-offers",
        name="Forever Edinburgh offers",
        trust="official",
        status="live",
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
        status="live",
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
        status="live",
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
    DealSource(
        id="itison-edinburgh",
        name="itison Edinburgh deals",
        trust="commercial",
        status="live",
        discover={
            "kind": "link_list",
            "url": "https://www.itison.com/edinburgh",
            # One page per deal in the Edinburgh section; category pages are not deals.
            "href_pattern": r"^https://www\.itison\.com/Edinburgh/deals/(?!category/)[^/?#]+$",
            "limit": 45,
        },
        extract_hints=(
            "itison is a voucher and experience marketplace. Its Edinburgh listing also links to deals in other "
            "towns (Glasgow, St Andrews, Pitlochry and so on): those have no Edinburgh postcode and are not deals "
            "for this source. Each page is one offer. Its 'At a glance' section gives the offer; the 'Options' "
            "block shows 'Was £x / Now £y / Save up to z%' or a 'Save' line; 'Valid ...' gives the validity dates; "
            "the venue address with its postcode is under the title. Return only the page's main offer. Ignore "
            "'Recommended for you' and any other deals on the page. Keep only an offer that states a saving: a "
            "'Was' price above the 'Now' price, a 'Save' amount or percentage, a 2-for-1, or a free item. A "
            "voucher spend or a set-price experience with no stated saving is not a deal: leave it out. Leave "
            "booking_url out."
        ),
    ),
    DealSource(
        id="fort-kinnaird-offers",
        name="Fort Kinnaird offers",
        trust="commercial",
        status="live",
        multi_deal_pages=True,
        # The Location block of the offers page: "Newcraighall / Edinburgh / EH15 3RD".
        edinburgh_evidence="Newcraighall Edinburgh EH15 3RD",
        discover={
            "kind": "urls",
            "urls": [
                "https://www.fortkinnaird.com/offers?type=student",
                "https://www.fortkinnaird.com/offers?type=dining",
                "https://www.fortkinnaird.com/offers?type=kids-dining-offers",
            ],
        },
        extract_hints=(
            "Fort Kinnaird is a shopping and leisure centre in Edinburgh (EH15 3RD). Each offer card is one shop, "
            "restaurant or leisure business in the centre, with a title such as 'Clarks Student Discount' or "
            "'Frankie & Benny's | Student offer', then the offer. The venue is that business. Keep an offer that "
            "states a saving: a percentage off, a free item, a 2-for-1, a 'Kids Eat Free' or a stated price below "
            "the normal one such as 'a main and drink for just £12'. A plain menu item with no saving is not a deal. "
            "Eligibility is 'student' for a student offer, 'anyone' otherwise; the 'Blue Light' and 'Birthday' "
            "filters are not on this source. Skip the news items, shop lists and navigation. Leave booking_url out."
        ),
    ),
    DealSource(
        id="omni-centre-offers",
        name="OMNi Edinburgh student offers",
        trust="commercial",
        status="live",
        multi_deal_pages=True,
        # The footer of the OMNi site: "OMNi Centre / Greenside Row, Edinburgh EH1 3AA".
        edinburgh_evidence="Greenside Row, Edinburgh EH1 3AA",
        discover={
            "kind": "urls",
            "urls": ["https://omniedinburgh.co.uk/offers/student-discounts-and-more"],
        },
        extract_hints=(
            "OMNi is the leisure and dining centre in Greenside Row, Edinburgh. This page lists student discounts "
            "from the businesses in the centre (Vue, Boom Battle Bar, Escape Hunt, Slug and Lettuce, Nando's, "
            "Cosmo and others). Each bullet is one offer: the percentage or deal, the business, and sometimes a "
            "code or a link to its terms. The venue is the business named in the offer. Keep only offers that state "
            "a saving: a percentage off, a 2-for-1, a free item or a stated price below the normal one. Offers that "
            "are only a membership price or an event with no saving are not deals. Eligibility is 'student' "
            "(the page is a student offers page). Leave booking_url out."
        ),
    ),
    DealSource(
        id="edinburgh-leisure-offers",
        name="Edinburgh Leisure offers",
        trust="official",
        status="live",
        edinburgh=True,
        discover={
            "kind": "sitemap",
            "urls": [
                "https://www.edinburghleisure.co.uk/page-sitemap.xml",
                "https://www.edinburghleisure.co.uk/post-sitemap.xml",
            ],
            # Offer, free-session and joining-fee pages. "free" and "try" need word
            # boundaries so that "freedom-of-information" and "country" do not match.
            "pattern": r"offer|(?:^|[/-])free(?:[-/]|$)|(?:^|[/-])try(?:[-/]|$)|joining-fee",
            "modified_within_days": 90,
        },
        extract_hints=(
            "Edinburgh Leisure runs the council's leisure centres, pools and gyms in Edinburgh. Each page is one "
            "offer: a free or reduced trial session, a joining-fee offer, or a membership offer. Return the deal "
            "when the page states what is free or reduced and until when (the dates or 'until' wording). A news "
            "story about an offer that has ended, or a page about membership terms with no offer, is not a deal. "
            "Eligibility is 'anyone' unless the page says who qualifies. An offer for a group that is not in the "
            "eligibility list (for example under-5s, or a disability group) is left out. Leave booking_url out "
            "unless the page links the booking page itself."
        ),
    ),
    DealSource(
        id="pizzaexpress-offers",
        name="PizzaExpress national offers",
        trust="commercial",
        status="shadow",
        multi_deal_pages=True,
        national_ok=True,
        national_venue="PizzaExpress (Edinburgh restaurants)",
        discover={
            "kind": "urls",
            "urls": ["https://www.pizzaexpress.com/offers"],
        },
        extract_hints=(
            "PizzaExpress national offers. Each offer card is a title, the offer and its terms. The offers apply "
            "at PizzaExpress restaurants across the UK, including Edinburgh, so the deal is not tied to one "
            "address. Keep an offer that states a saving: a 'Buy a Main, get another for £1' style deal, a discount "
            "or a free item. A plain set price (a menu or a feast priced at a normal amount) is not a deal. Leave "
            "address out: the 'Brought to you by' line in the terms is the company's head office, not a restaurant. "
            "Leave booking_url out: the offer links go to claim pages that robots.txt disallows."
        ),
    ),
)


def get_sources(ids: list[str] | None = None, today: date | None = None) -> tuple[DealSource, ...]:
    """The sources for a run: the static list plus the annual promotions whose window holds
    `today` (London date by default). Named ids may also be annual entries outside their
    window: an explicit request is honoured."""
    from deal_sources.annual import annual_sources  # annual imports this module

    if not ids:
        return SOURCES + annual_sources(today)
    pool = SOURCES + annual_sources(today, all_entries=True)
    wanted = {i.lower() for i in ids}
    chosen = tuple(s for s in pool if s.id.lower() in wanted)
    missing = wanted - {s.id.lower() for s in chosen}
    if missing:
        raise ValueError(f"unknown deal source id(s): {', '.join(sorted(missing))}; known: {', '.join(s.id for s in pool)}")
    return chosen
