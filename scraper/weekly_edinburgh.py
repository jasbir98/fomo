#!/usr/bin/env python3
"""Safe weekly refresh for Edinburgh happenings.

This is deliberately an orchestration script rather than another broad
"what's on" prompt.  It reads publisher pages first, researches small,
independent gaps in parallel, verifies every factual claim against the cited
page, and only promotes rows that passed that last check.  It never deletes.

The default invocation is a first-run-safe preview: it can write reviewed
rows to ``happenings_staging`` but will not approve or promote anything.
Pass ``--publish`` only after reviewing a prior report.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import copy
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.robotparser
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable

import requests
from dotenv import load_dotenv

SCRAPER_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRAPER_DIR.parent
OUT_ROOT = SCRAPER_DIR / "out"
load_dotenv(SCRAPER_DIR / ".env")
load_dotenv(REPO_ROOT / ".env.local", override=False)
sys.path.insert(0, str(SCRAPER_DIR))

from happenings.cities.edinburgh import EDINBURGH  # noqa: E402
from happenings_research import (  # noqa: E402
    FINAL_SUBMIT_PROMPT,
    HAPPENING_SCHEMA,
    RESEARCH_MAX_TOKENS,
    SUBMIT_CALL_KWARGS,
    SUBMIT_MAX_TOKENS,
    build_full_record,
    sanitize_history,
    web_search_tool_for_model,
)
from llm_client import RESEARCH_CALL_KWARGS, default_research_model, make_research_client  # noqa: E402
from upsert_happenings import upsert_happenings  # noqa: E402
from identity import Catalogue, reconcile  # noqa: E402

USER_AGENT = "FomoWeeklyEdinburgh/1.0 (+https://fomo.app; polite publisher-data refresh)"
WEEKLY_CAP_USD = 3.00
VERIFY_AFTER_DAYS = 21


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    mode: str = "calendar"


# These are publisher landing pages, not search-engine result pages.  Pages
# that forbid the bot, rate-limit it, or challenge it are logged and skipped;
# this script makes no retry or browser-bypass attempt for them.
#
# URLs below were re-checked live on 2026-09-14 after the first run reported
# zero direct-source records: several were simply wrong (moved/renamed pages
# returning HTTP 404) and are fixed here. A number of the *reachable* pages
# genuinely carry no schema.org JSON-LD at all -- their "what's on" listings
# are rendered client-side by a JS bundle with no server-rendered markup for
# it (Capital Theatres, National Museums Scotland, the council, Filmhouse,
# Cameo/Picturehouses, the Fringe/EIF/Book Festival sites all confirmed this
# way). That is a real, structural limitation of these publishers, not a
# parser bug -- per the module doc, a page with no structured event data is
# still a successful "read", just not a source of direct records. They stay
# in this list because a future template change could add it back for free.
DIRECT_SOURCES: tuple[Source, ...] = (
    Source("Forever Edinburgh", "https://edinburgh.org/whats-on/"),
    Source("Forever Edinburgh Resident Rewards", "https://edinburgh.org/residentrewards/", "offers"),
    Source("parkrun", "https://www.parkrun.org.uk/events/", "whats-on"),
    Source("National Galleries of Scotland", "https://www.nationalgalleries.org/events", "calendar"),
    # Old URL 404'd (path renamed without the trailing "explore-our-collections/").
    Source("National Museums Scotland", "https://www.nms.ac.uk/whats-on", "calendar"),
    Source("Royal Botanic Garden Edinburgh", "https://www.rbge.org.uk/whats-on/", "whats-on"),
    # usherhall.co.uk now redirects its whole site to Culture Edinburgh's own
    # domain; the old /whats-on/ path 404'd there.
    Source("Usher Hall", "https://cultureedinburgh.com/whats-on", "book-early"),
    Source("Festival Theatre", "https://www.capitaltheatres.com/whats-on/", "book-early"),
    Source("Queen's Hall", "https://www.thequeenshall.net/whats-on/", "book-early"),
    # leiththeatre.org redirects to the .co.uk domain's /upcoming-events path;
    # point at it directly rather than relying on the redirect every run.
    Source("Leith Theatre", "https://www.leiththeatre.co.uk/upcoming-events", "book-early"),
    Source("Summerhall", "https://www.summerhall.co.uk/whats-on/", "calendar"),
    # thestand.co.uk/edinburgh/whats-on/ 404'd; no dedicated Edinburgh
    # what's-on path exists, so read the site root instead.
    Source("The Stand", "https://www.thestand.co.uk/", "calendar"),
    # filmhousecinema.co.uk does not resolve at all (the pre-2022 domain);
    # Filmhouse reopened in 2025 at filmhouse.org.uk.
    Source("Filmhouse", "https://www.filmhouse.org.uk/", "offers"),
    # "cameo-picturehouse" is not this cinema's current slug on picturehouses.com
    # (it 404-redirects to the site root); the live slug is "the-cameo".
    Source("Cameo", "https://www.picturehouses.com/cinema/the-cameo", "offers"),
    Source("Dominion Cinema", "https://www.dominioncinema.co.uk/", "offers"),
    Source("Edinburgh Festival Fringe", "https://www.edfringe.com/", "book-early"),
    Source("Edinburgh International Festival", "https://www.eif.co.uk/", "book-early"),
    Source("Edinburgh International Book Festival", "https://www.edbookfest.co.uk/", "book-early"),
    # 5pm.co.uk, National Galleries of Scotland, and parkrun genuinely block
    # this User-Agent (HTTP 403/401 on the page itself, not just robots.txt)
    # -- confirmed live, not a URL or parser problem. Left in place: this
    # script never bypasses bot protection, so they stay logged as blocked.
    Source("5pm", "https://www.5pm.co.uk/edinburgh/", "offers"),
    Source("City of Edinburgh Council", "https://www.edinburgh.gov.uk/events", "calendar"),
)


@dataclass(frozen=True)
class Topic:
    name: str
    mode: str
    seeds: tuple[str, ...]
    priority: int


# Each topic has a small, explicit seed list.  Priority order protects the
# most time-sensitive/redeemable material if the $3 budget is exhausted.
TOPICS: tuple[Topic, ...] = (
    Topic("Hogmanay ticket releases", "book-early", ("edinburghshogmanay.com",), 100),
    Topic("Fringe ticket releases", "book-early", ("edfringe.com",), 99),
    Topic("Tattoo ticket releases", "book-early", ("edintattoo.co.uk",), 98),
    Topic("Murrayfield rugby ticket releases", "book-early", ("scottishrugby.org",), 97),
    Topic("major Edinburgh concerts on sale", "book-early", ("usherhall.co.uk", "ticketmaster.co.uk"), 96),
    Topic("EIF ticket releases", "book-early", ("eif.co.uk",), 95),
    Topic("Book Festival ticket releases", "book-early", ("edbookfest.co.uk",), 94),
    Topic("Edinburgh resident rewards", "offers", ("edinburgh.org/residentrewards/",), 93),
    # Wedge topics (2026-09-26): students + young professionals. Kept narrow on
    # purpose — deepseek-flash front-loads the first category of a broad prompt
    # and stops. Day-specific offers should come back as recurrence "weekly"
    # with the weekday(s) set, so the app can show "today's deals".
    Topic("student deals in Edinburgh", "offers", ("studentbeans.com", "myunidays.com"), 92),
    Topic("Edinburgh student nights by weekday", "whats-on", ("fatsoma.com", "fixr.co", "eusa.ed.ac.uk"), 92),
    Topic("students' association events", "whats-on", ("eusa.ed.ac.uk", "napierstudents.com", "hwunion.com", "qmusu.org.uk"), 91),
    Topic("Edinburgh happy hours", "offers", ("5pm.co.uk", "designmynight.com/edinburgh"), 91),
    Topic("Edinburgh 2-for-1 and bottomless brunch deals", "offers", ("designmynight.com/edinburgh",), 90),
    Topic("Edinburgh weekday pizza and burger deals", "offers", ("francomanca.co.uk", "honestburgers.co.uk"), 90),
    Topic("Edinburgh cheap lunch deals under £10", "offers", ("5pm.co.uk",), 89),
    Topic("Edinburgh pub quiz nights", "whats-on", ("designmynight.com/edinburgh",), 89),
    Topic("under-26 theatre tickets", "offers", ("lyceum.org.uk", "traverse.co.uk", "capitaltheatres.com"), 89),
    Topic("under-26 concessions", "offers", ("youngscot.org", "nationalgalleries.org"), 88),
    Topic("cheap cinema days", "offers", ("filmhousecinema.co.uk", "dominioncinema.co.uk", "cameopicturehouse.co.uk"), 88),
    Topic("free and cheap comedy nights", "whats-on", ("monkeybarrelcomedy.com", "thestand.co.uk"), 87),
    Topic("free public lectures and talks", "whats-on", ("ed.ac.uk/events", "napier.ac.uk"), 86),
    Topic("Edinburgh pub chain offers", "offers", ("jdwetherspoon.com", "greeneking.co.uk"), 86),
    Topic("Edinburgh restaurant chain offers", "offers", ("nandos.co.uk", "turtlebay.co.uk"), 85),
    Topic("over-60 concessions", "offers", ("edinburgh.org", "nms.ac.uk"), 60),
    Topic("free museum admission", "offers", ("nms.ac.uk", "nationalgalleries.org"), 85),
    Topic("free festival shows", "calendar", ("freefringe.org", "edfringe.com"), 84),
    Topic("Edinburgh comedy nights", "whats-on", ("thestand.co.uk", "summerhall.co.uk"), 83),
    Topic("Edinburgh open mics", "whats-on", ("edinburgh.org", "thelist.co.uk"), 82),
    Topic("Edinburgh ceilidhs", "whats-on", ("summerhall.co.uk", "edinburgh.org"), 81),
    Topic("Cramond parkrun", "whats-on", ("parkrun.org.uk/cramond",), 80),
    Topic("Portobello parkrun", "whats-on", ("parkrun.org.uk/portobello",), 79),
    Topic("Holyrood parkrun", "whats-on", ("parkrun.org.uk/holyrood",), 78),
    Topic("Edinburgh markets", "whats-on", ("edinburghfarmersmarket.co.uk", "stockbridgemarket.com"), 77),
    Topic("free walking tours", "whats-on", ("sandemansnew.com", "freewalkingtoursedinburgh.com"), 76),
    Topic("family activities", "whats-on", ("rbge.org.uk", "nms.ac.uk"), 75),
    Topic("museum lates", "whats-on", ("nms.ac.uk", "nationalgalleries.org"), 74),
    Topic("seasonal autumn events", "calendar", ("edinburgh.org/whats-on/",), 73),
    Topic("seasonal winter events", "calendar", ("edinburghchristmas.com", "edinburgh.org"), 72),
    Topic("seasonal spring events", "calendar", ("sciencefestival.co.uk", "edinburgh.org"), 71),
    Topic("seasonal summer events", "calendar", ("edinburghfestivalcity.com",), 70),
    Topic("council community events", "calendar", ("edinburgh.gov.uk/events",), 69),
    # Sports fixtures — kind should come back "event"/category "sports" (see
    # HAPPENING_SCHEMA). Domains below were live-checked 2026-09-14. Ticket
    # marketplaces (Ticketmaster/Skiddle, see lib/events/) rarely carry
    # Scottish football at all and never carry Hearts/Hibs directly — this is
    # the actual source of those fixtures for the app. Edinburgh Eagles
    # basketball has no verifiable official site as of this check, so it is
    # deliberately not seeded here (do not add an unverified domain).
    Topic("Heart of Midlothian home fixtures", "calendar", ("heartsfc.co.uk",), 68),
    Topic("Hibernian home fixtures", "calendar", ("hibernianfc.co.uk",), 67),
    Topic("Edinburgh Rugby home matches", "calendar", ("edinburghrugby.org",), 66),
    Topic("Edinburgh Marathon and Great Winter Run entries", "book-early", ("edinburghmarathon.com", "greatrun.org"), 65),
    Topic("Edinburgh Capitals ice hockey fixtures", "calendar", ("edcapitals.com",), 64),
    Topic("Spartans and Edinburgh City FC fixtures", "calendar", ("spartansfc.com", "edinburghcityfc.com"), 63),
)


class TextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.json_ld: list[str] = []
        self._in_json_ld = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "script" and dict(attrs).get("type", "").lower() == "application/ld+json":
            self._in_json_ld = True

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script":
            self._in_json_ld = False

    def handle_data(self, data: str) -> None:
        if self._in_json_ld:
            self.json_ld.append(data)
        elif data.strip():
            self.parts.append(data.strip())

    @property
    def text(self) -> str:
        return re.sub(r"\s+", " ", unescape(" ".join(self.parts)))


def canonical_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc.lower(), parsed.path.rstrip("/"), parsed.query, ""))


def robot_allows(url: str, session: requests.Session) -> tuple[bool, str | None]:
    parts = urllib.parse.urlsplit(url)
    robots_url = f"{parts.scheme}://{parts.netloc}/robots.txt"
    try:
        response = session.get(robots_url, timeout=15)
        if response.status_code >= 400:
            # A missing OR blocked robots.txt is not evidence the target page
            # itself disallows the bot. Several sites' WAFs return 401/403 on
            # a bare robots.txt fetch from a non-browser User-Agent while the
            # actual page loads fine (observed live for parkrun.org.uk and
            # Summerhall, both of which then wrongly showed as fully blocked
            # by robots.txt alone) -- let the page-level fetch and its own
            # challenge detection make the real call instead.
            return True, None
        parser = urllib.robotparser.RobotFileParser()
        parser.parse(response.text.splitlines())
        if not parser.can_fetch(USER_AGENT, url):
            return False, "robots.txt disallows this page"
    except requests.RequestException:
        pass  # an unavailable robots file is not treated as permission to bypass a page block.
    return True, None


# Precise, named vendor phrasing for bot-challenge/interstitial pages.
# Deliberately excludes bare "captcha", "cloudflare", or "access denied":
# real, fully-loaded publisher pages routinely trip those (a contact-form
# reCAPTCHA widget, a cloudflarestream.com video embed, a "you have been
# denied access to this resource" 404 body) without being blocked at all --
# both false positives were confirmed live against Forever Edinburgh and
# Edinburgh's Hogmanay in the first run, which had fully served, legitimate
# 200 pages misreported as "blocked/challenged".
CHALLENGE_MARKERS = (
    "cf-chl-", "cf_chl_opt", "__cf_chl_rt_tk",
    "checking your browser before accessing",
    "just a moment...",
    "attention required! | cloudflare",
    "enable javascript and cookies to continue",
    "verify you are human", "verifying you are human",
    "request unsuccessful. incapsula",
    "sorry, you have been blocked",
    "unusual traffic from your computer network",
)
# NOT included, on purpose, despite looking like plausible markers:
# "_incapsula_resource", "distil_r_captcha", "px-captcha", "perimeterx" --
# all four are just the *filename/id* of a vendor's passive bot-management
# script tag, which a normal, fully-served page on an Incapsula/Distil/
# PerimeterX-protected site includes on every request regardless of whether
# that request was challenged. Confirmed live: nandos.co.uk serves a
# complete, real page (472KB, 228K chars of visible text) that references
# "/_incapsula_resource?..." in a totally ordinary <script> tag, and the
# bare-identifier version of this marker misclassified it as blocked.


def _looks_like_challenge_page(html: str, visible_text: str) -> bool:
    """Best-effort detection of a bot-challenge/interstitial body on a 200.

    Two independent signals: named vendor interstitial copy (reliable but
    narrow), or a suspiciously tiny rendered body on an otherwise-normal
    response -- real content-bearing publisher pages essentially never
    render under ~200 characters of visible text in a sub-20KB document,
    while a JS-gated challenge shell routinely does.
    """
    lowered = html.lower()
    if any(marker in lowered for marker in CHALLENGE_MARKERS):
        return True
    if len(html) < 20_000 and len(visible_text.strip()) < 200:
        return True
    return False


def fetch_publisher_page(source: Source) -> tuple[str | None, str | None, str | None]:
    """Return (html, final_url, failure_reason); never works around a block."""
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"})
    allowed, reason = robot_allows(source.url, session)
    if not allowed:
        return None, None, reason
    try:
        response = session.get(source.url, timeout=25, allow_redirects=True)
    except requests.RequestException as exc:
        return None, None, f"request failed: {exc.__class__.__name__}"
    if response.status_code in (401, 403, 429, 503):
        return None, None, f"blocked/challenged (HTTP {response.status_code})"
    if response.status_code != 200:
        return None, None, f"HTTP {response.status_code}"
    text_probe = TextParser()
    text_probe.feed(response.text)
    if _looks_like_challenge_page(response.text, text_probe.text):
        return None, None, f"blocked/challenged (HTTP {response.status_code})"
    if "html" not in response.headers.get("content-type", "").lower():
        return None, None, "not an HTML page"
    return response.text, response.url, None


def iter_json_objects(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from iter_json_objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_json_objects(child)


def iso_from_jsonld(value: Any, end: bool = False) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    # Schema.org accepts a date without a time.  Preserve the stated date in
    # UTC rather than inventing a showtime; end dates end just before midnight.
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return value + ("T23:59:59+00:00" if end else "T00:00:00+00:00")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value


# schema.org Event has many named subtypes -- a cinema's ScreeningEvent, a
# venue's MusicEvent, a festival's Festival, a gallery's ExhibitionEvent --
# that are just as event-shaped as a bare "Event" and worth exactly the same
# treatment. Matching only the literal string "Event" (the original
# behaviour) silently missed every one of them; @graph arrays and nested
# objects (e.g. a festival's subEvent list) are already walked by
# iter_json_objects's recursion, so each nested Event-typed object is found
# and considered independently without any extra code here.
EVENT_TYPES = {
    "Event", "ScreeningEvent", "MusicEvent", "TheaterEvent", "Festival",
    "SocialEvent", "SportsEvent", "ExhibitionEvent", "EducationEvent",
    "FoodEvent", "ComedyEvent", "DanceEvent", "VisualArtsEvent",
    "LiteraryEvent", "ChildrensEvent", "BusinessEvent", "SaleEvent",
    "PublicationEvent", "BroadcastEvent", "CourseInstance",
}


def _offer_price(offers: Any) -> str | None:
    """Extract a price from a JSON-LD ``offers`` value.

    Handles a bare Offer, a list of Offers (first one), and an
    AggregateOffer (which states ``lowPrice`` instead of ``price`` -- the
    previous version only handled the first two and silently found no price
    on any AggregateOffer, which is a common shape for a multi-showing
    event).
    """
    if isinstance(offers, list) and offers:
        offers = offers[0]
    if not isinstance(offers, dict):
        return None
    price = offers.get("price")
    if price is None:
        price = offers.get("lowPrice")
    return str(price) if price is not None else None


def direct_records(source: Source, html: str, page_url: str, batch_id: str, now: str) -> list[dict[str, Any]]:
    """Convert only publisher JSON-LD Event objects; prose is left for review/AI.

    This intentionally keeps the direct path conservative.  A landing page
    without individually structured event data is still a successful source
    read, but it does not create a guessed record.
    """
    parser = TextParser()
    parser.feed(html)
    raw_objects: list[dict[str, Any]] = []
    for block in parser.json_ld:
        try:
            # strict=False tolerates a literal control character (e.g. a raw
            # newline) inside a JSON string, which several CMS-generated
            # JSON-LD blocks emit (observed live on nms.ac.uk's own
            # "description" field) and which the default strict parser
            # rejects outright, discarding the whole block including any
            # sibling Event data in the same @graph.
            raw_objects.extend(iter_json_objects(json.loads(block, strict=False)))
        except json.JSONDecodeError:
            continue

    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for obj in raw_objects:
        type_value = obj.get("@type")
        types = type_value if isinstance(type_value, list) else [type_value]
        if not (set(types) & EVENT_TYPES):
            continue
        title = str(obj.get("name") or "").strip()
        starts_at = iso_from_jsonld(obj.get("startDate"))
        ends_at = iso_from_jsonld(obj.get("endDate"), end=True) or starts_at
        if not title or not starts_at:
            continue
        end_dt = datetime.fromisoformat((ends_at or starts_at).replace("Z", "+00:00"))
        if end_dt.tzinfo is None:
            end_dt = end_dt.replace(tzinfo=timezone.utc)
        if end_dt < datetime.now(timezone.utc):
            continue
        event_url = obj.get("url") if isinstance(obj.get("url"), str) else page_url
        event_url = urllib.parse.urljoin(page_url, event_url)
        key = canonical_url(event_url) + "|" + title.casefold()
        if key in seen:
            continue
        seen.add(key)
        location = obj.get("location") if isinstance(obj.get("location"), dict) else {}
        address = location.get("address")
        address = address if isinstance(address, str) else None
        price = _offer_price(obj.get("offers"))
        is_free = price is not None and price.strip() in {"0", "0.0", "0.00", "£0"}
        raw = {
            "title": title,
            "summary": str(obj.get("description") or "").strip()[:500] or None,
            "kind": "event" if source.mode != "offers" else "deal",
            "category": "other",
            "scope": "venue" if location.get("name") else "city",
            "saving_label": "Free" if is_free else None,
            "is_free": is_free,
            "eligibility": "anyone",
            "starts_at": starts_at,
            "ends_at": ends_at,
            "recurrence": {"type": "once"},
            "venue_name": location.get("name") if isinstance(location.get("name"), str) else None,
            "address": address,
            "booking_url": event_url,
            "cta_label": "View event",
            "source_name": source.name,
            "source_url": event_url,
            "source_urls": [event_url],
            "field_sources": {k: event_url for k, v in {
                "title": title, "starts_at": starts_at, "ends_at": ends_at, "venue_name": location.get("name"),
                "is_free": is_free if is_free else None,
            }.items() if v},
            "confidence": "high",
            "priority": 65,
        }
        record = build_full_record(raw, batch_id, EDINBURGH, "direct", "publisher-jsonld", now)
        if record:
            records.append(record)
    return records


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    searches: int = 0

    def add_response(self, response: Any) -> None:
        usage = getattr(response, "usage", None)
        self.input_tokens += int(getattr(usage, "input_tokens", 0) or 0)
        self.output_tokens += int(getattr(usage, "output_tokens", 0) or 0)
        self.searches += sum(1 for block in getattr(response, "content", []) if getattr(block, "type", "") == "server_tool_use")


@dataclass
class CostLedger:
    cap: float
    input_per_million: float
    output_per_million: float
    search_usd: float
    spent: float = 0.0
    reserved: float = 0.0
    usage: Usage = field(default_factory=Usage)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def actual_cost(self, usage: Usage) -> float:
        return usage.input_tokens / 1_000_000 * self.input_per_million + usage.output_tokens / 1_000_000 * self.output_per_million + usage.searches * self.search_usd

    def reserve(self, amount: float) -> bool:
        with self.lock:
            if self.spent + self.reserved + amount > self.cap + 1e-9:
                return False
            self.reserved += amount
            return True

    def settle(self, reserved: float, usage: Usage) -> float:
        cost = self.actual_cost(usage)
        with self.lock:
            self.reserved -= reserved
            self.spent += cost
            self.usage.input_tokens += usage.input_tokens
            self.usage.output_tokens += usage.output_tokens
            self.usage.searches += usage.searches
        return cost


def topic_system_prompt(topic: Topic, known_lines: list[str] | None = None) -> str:
    # The existing submit schema and strict record validation remain the single
    # source of truth.  This narrower instruction is what avoids one category
    # consuming the entire research budget.
    seeds = ", ".join(topic.seeds)
    return f"""You are researching exactly one Edinburgh topic: {topic.name}.
Use web search only to inspect current, primary publisher pages. Start with these seed domains: {seeds}.
Do not research adjacent categories. Return only genuine, currently valid happenings for this topic.
Every date, price, eligibility rule and promo code must be stated word-for-word on its cited page. Do not guess.
For every populated factual field, set field_sources to the page that supports it. Prefer null to inference.
Never emit an expired one-off. Source URL must state the terms; booking URL may be different.
An offer or night valid only on certain weekdays is recurrence type "weekly" with those days; put its hours in time_note.
If the page limits an offer to a month, season or end date, set that last valid date as recurrence.until (weekly) or ends_at (any other type).
""" + known_items_block(known_lines)


def known_items_block(known_lines: list[str] | None) -> str:
    """Tell the topic agent what Fomo already lists, so the budget goes on
    finding new things instead of rediscovering these (plan §2c)."""
    if not known_lines:
        return ""
    listed = "\n".join(f"- {line}" for line in known_lines)
    return f"""
Fomo already lists these (title | date | venue). Do NOT return them again unless a fact has changed
(price, date, promo code, sold out); if so, return it with the same title and the new fact.
{listed}
"""


def research_topic(topic: Topic, batch_id: str, model: str, known_lines: list[str] | None = None) -> tuple[Topic, list[dict[str, Any]], Usage, str | None]:
    """Two-phase DeepSeek/Anthropic call for one narrow topic, with usage kept.

    The client calls are intentionally independent so they can run in parallel
    and a failure in e.g. student deals cannot stop ticket-release research.
    """
    usage = Usage()
    try:
        client, _provider = make_research_client("weekly-edinburgh")
        messages: list[dict[str, Any]] = [{"role": "user", "content": f"Research {topic.name} in Edinburgh now."}]
        with client.messages.stream(
            model=model,
            max_tokens=RESEARCH_MAX_TOKENS,
            system=topic_system_prompt(topic, known_lines),
            tools=[web_search_tool_for_model(model, 5)],
            messages=messages,
            **RESEARCH_CALL_KWARGS,
        ) as stream:
            response = stream.get_final_message()
        usage.add_response(response)
        messages.append({"role": "assistant", "content": response.content})
        messages = sanitize_history(messages)
        messages.append({"role": "user", "content": FINAL_SUBMIT_PROMPT})
        with client.messages.stream(
            model=model,
            max_tokens=SUBMIT_MAX_TOKENS,
            system=topic_system_prompt(topic, known_lines),
            tools=[{"name": "submit_happenings", "description": "Submit verified topic findings.", "input_schema": {"type": "object", "properties": {"happenings": {"type": "array", "items": HAPPENING_SCHEMA}}, "required": ["happenings"]}}],
            tool_choice={"type": "tool", "name": "submit_happenings"},
            messages=messages,
            **SUBMIT_CALL_KWARGS,
        ) as stream:
            response = stream.get_final_message()
        usage.add_response(response)
        tool = next((b for b in response.content if getattr(b, "type", "") == "tool_use"), None)
        items = tool.input.get("happenings", []) if tool and isinstance(tool.input, dict) else []
        now = datetime.now(timezone.utc).isoformat()
        records = [record for item in items if isinstance(item, dict)
                   if (record := build_full_record(item, batch_id, EDINBURGH, topic.mode, model, now))]
        return topic, records, usage, None
    except Exception as exc:  # an individual topic is a reportable failure, never a whole-run failure.
        return topic, [], usage, f"{exc.__class__.__name__}: {exc}"


def normalized_title(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def merge_records(records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Deduplicate exact matches, then build only safe editorial collections."""
    kept: dict[tuple[str, str], dict[str, Any]] = {}
    rejected: list[str] = []
    for record in records:
        key = (normalized_title(record.get("title", "")), str(record.get("starts_at") or ""))
        if key not in kept:
            kept[key] = record
            continue
        current = kept[key]
        urls = list(dict.fromkeys([*(current.get("source_urls") or []), *(record.get("source_urls") or [])]))
        current["source_urls"] = urls
        rejected.append(f"{record.get('title')}: duplicate of {current.get('title')}")
    # No editorial collection rows: the app groups same-activity instances at
    # display time (lib/happenings/series.ts), and a stored "Edinburgh parkruns"
    # row showed up as a duplicate card next to that series (made dormant 2026-09-14).
    return list(kept.values()), rejected


def group_same_activity_collections(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Turn multiple location instances of one activity into one city card.

    A shared category is not sufficient evidence that two rows are the same
    thing: museum lates and comedy listings, for example, remain separate.
    This starts with the unambiguous parkrun family and keeps every individual
    event page as a verification target.  Add another family here only when
    its instances have equally clear, stable identity.
    """
    instances = [
        record for record in records
        if "parkrun" in normalized_title(str(record.get("title") or ""))
        and normalized_title(str(record.get("title") or "")) != "edinburgh parkruns"
    ]
    if len(instances) < 2:
        return records

    member_titles = list(dict.fromkeys(str(record["title"]) for record in instances))
    source_urls = list(dict.fromkeys(
        url for record in instances for url in (record.get("source_urls") or [record.get("source_url")]) if url
    ))
    # Never infer that all parkruns use the same day/time.  The group has a
    # weekly recurrence only when all individual source-backed rows agree;
    # otherwise its timing explicitly points readers to the member pages.
    recurrences = [record.get("recurrence") for record in instances]
    recurrence = recurrences[0] if recurrences and all(item == recurrences[0] for item in recurrences) else {"type": "always"}
    collection = copy.deepcopy(instances[0])
    collection.update({
        "slug": "edinburgh-parkruns",
        "title": "Edinburgh parkruns",
        "summary": "Free weekly parkruns across Edinburgh: " + ", ".join(member_titles) + ".",
        "kind": "activity",
        "category": "wellness",
        "scope": "city",
        "saving_label": "Free",
        "is_free": True,
        "eligibility": "anyone",
        "starts_at": None,
        "ends_at": None,
        "recurrence": recurrence,
        "time_note": "Check the individual parkrun pages for each location's current start time and details.",
        "venue_name": None,
        "address": None,
        "district": None,
        "lat": None,
        "lng": None,
        "place_id": None,
        "booking_url": None,
        "cta_label": "Find a parkrun",
        "source_name": "parkrun",
        "source_url": source_urls[0],
        "source_urls": source_urls,
        "field_sources": {"title": source_urls[0], "saving_label": source_urls[0], "recurrence": source_urls[0]},
        # Pipeline-only metadata. upsert_happenings.py deliberately drops it;
        # verify_record uses it to check every constituent source page.
        "_collection_members": [
            {"title": record["title"], "source_url": record["source_url"]}
            for record in instances
        ],
    })
    member_ids = {id(record) for record in instances}
    non_members = [record for record in records if id(record) not in member_ids]
    return non_members + [collection]


def page_text(url: str) -> tuple[str | None, str | None]:
    source = Source("verification", url)
    html, _final, reason = fetch_publisher_page(source)
    if not html:
        return None, reason
    parser = TextParser()
    parser.feed(html)
    return parser.text, None


def gather_verification_urls(record: dict[str, Any]) -> list[str]:
    """Every URL worth trying before concluding a fact isn't verifiable.

    source_url is supposed to be the page that states the terms (rule 8), so
    it is tried first; every other source_urls entry and finally booking_url
    are fallbacks tried only once the primary page is blocked, challenged,
    or otherwise unreachable. This never bypasses a real block -- a source
    that is blocked/unreachable on every one of its URLs still ends up
    unverified, exactly as before -- it just stops mistaking "the one URL we
    happened to try first was blocked" for "this fact cannot be verified"
    when a perfectly good booking page or duplicate source link was sitting
    right there unused (Usher Hall, Edinburgh's Hogmanay, and Young Scot in
    the first run all had a working alternate URL on the same record).
    """
    urls: list[str] = []
    for candidate in (record.get("source_url"), *(record.get("source_urls") or []), record.get("booking_url")):
        if isinstance(candidate, str) and candidate.strip() and candidate not in urls:
            urls.append(candidate.strip())
    return urls


def load_verification_text(urls: list[str]) -> tuple[str | None, str | None]:
    """Try each candidate URL in turn; only fail once every one is blocked."""
    reasons: list[str] = []
    for url in urls:
        text, failure = page_text(url)
        if text:
            return text, None
        reasons.append(f"{url}: {failure}")
    return None, "; ".join(reasons) if reasons else "no source URL to check"


def _ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _date_text_variants(d) -> set[str]:
    """Every common way a UK publisher page states a date in prose."""
    month_full, month_abbr = d.strftime("%B"), d.strftime("%b")
    variants = {
        d.isoformat(),
        d.strftime("%d/%m/%Y"), d.strftime("%d-%m-%Y"), d.strftime("%d.%m.%Y"),
        d.strftime("%d/%m/%y"),
        d.strftime("%d %B %Y"), d.strftime("%d %b %Y"),
        d.strftime("%-d %B %Y"), d.strftime("%-d %b %Y"),
        d.strftime("%B %-d, %Y"), d.strftime("%b %-d, %Y"),
        f"{d.day} {month_full}", f"{d.day} {month_abbr}",
        f"{_ordinal(d.day)} {month_full}", f"{_ordinal(d.day)} {month_abbr}",
        f"{_ordinal(d.day)} of {month_full}",
        d.strftime("%A %-d %B"), d.strftime("%a %-d %b"),
        f"{month_full} {d.year}", f"{month_abbr} {d.year}",
    }
    return {v.strip() for v in variants if v and v.strip()}


def _time_text_variants(dt) -> set[str]:
    """Textual variants for a stated release/start TIME (not just the date).

    Empty when the timestamp carries no real time component (midnight is
    used as a "date only" placeholder throughout this pipeline -- see
    build_full_record/booking_opens_at -- so it has nothing to check).
    """
    if dt.hour == 0 and dt.minute == 0:
        return set()
    h12 = dt.strftime("%I:%M%p").lstrip("0")
    variants = {
        dt.strftime("%H:%M"),
        h12.lower(), h12.upper(),
        h12.lower().replace(":00", ""),
        dt.strftime("%I.%M%p").lstrip("0").lower(),
        dt.strftime("%I%p").lstrip("0").lower(),
    }
    return {v.strip() for v in variants if v and v.strip()}


def _parse_iso(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def stated_on_page(value: str, text: str, is_date: bool = False, is_time: bool = False) -> bool:
    """Hard-fact check. Verbatim/case-sensitive for non-dates (promo codes,
    saving labels); for dates, verbatim OR any common textual format,
    matched case-insensitively since a page writing "26 september" in
    lower-case is not a different fact from "26 September"."""
    if value in text:
        return True
    if not is_date:
        return False
    parsed = _parse_iso(value)
    if parsed is None:
        return False
    lowered = text.lower()
    if any(variant.lower() in lowered for variant in _date_text_variants(parsed.date())):
        return True
    if is_time:
        return any(variant in lowered for variant in _time_text_variants(parsed))
    return False


_WEEKDAY_NAMES = ("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")


def weekly_days_stated_on_page(days: list[Any], text: str) -> bool:
    """Hard fact for a weekly recurrence: at least one of its stated weekdays
    (schema: 0=Sunday) actually appears on the page, e.g. a ceilidh's page
    saying "every Tuesday"."""
    names = [_WEEKDAY_NAMES[d] for d in days if isinstance(d, int) and 0 <= d <= 6]
    if not names:
        return True  # nothing concrete stated in the record itself to check
    lowered = text.lower()
    return any(name.lower() in lowered for name in names)


_SIGNIFICANT_WORD_RE = re.compile(r"[a-z0-9]+")
_RELEVANCE_STOPWORDS = {
    "the", "and", "for", "with", "your", "this", "that", "from", "into",
    "edinburgh", "tickets", "ticket", "free", "offer", "offers", "event",
    "events", "club", "night", "day", "days", "week", "weekly", "annual",
    "new", "now", "get", "off", "our", "are", "you", "2026", "2027",
}


def _significant_tokens(value: str | None) -> set[str]:
    if not isinstance(value, str) or not value.strip():
        return set()
    words = _SIGNIFICANT_WORD_RE.findall(value.lower())
    return {w for w in words if len(w) >= 4 and w not in _RELEVANCE_STOPWORDS}


def relevance_signal_present(record: dict[str, Any], text: str) -> bool:
    """Soft check only -- title/venue are NOT hard requirements.

    Titles here are the model's own paraphrase (rule: "in your own words"),
    so they will legitimately never appear verbatim on the source page --
    treating that as a hard failure was, by a wide margin, the single
    biggest cause of good, source-backed rows sitting in review in the first
    run ("title is not found on source page" on ~90 of the 109 review
    items). This exists only to catch the page actually being about
    something else entirely (wrong URL, a redirect to an unrelated page):
    it passes as soon as ANY significant word from the title or venue name
    shows up anywhere on the page.
    """
    tokens = _significant_tokens(record.get("title")) | _significant_tokens(record.get("venue_name"))
    if not tokens:
        return True  # nothing distinctive enough to check; don't fail on this alone.
    lowered = text.lower()
    return any(token in lowered for token in tokens)


def verify_record(record: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    collection_members = record.get("_collection_members")
    if isinstance(collection_members, list):
        missing: list[str] = []
        for member in collection_members:
            if not isinstance(member, dict) or not member.get("source_url") or not member.get("title"):
                missing.append("collection member is missing its title or source")
                continue
            # Reachability is the hard fact for a collection member -- its
            # title is an editorial label, not something required to appear
            # verbatim on its own source page (same soft-vs-hard rule as
            # everywhere else in this function).
            text, failure = page_text(str(member["source_url"]))
            if not text:
                missing.append(f"{member['title']}: source could not be reloaded: {failure}")
        return record, missing

    urls = gather_verification_urls(record)
    text, failure = load_verification_text(urls)
    if not text:
        tried = f" across {len(urls)} URLs" if len(urls) > 1 else ""
        return record, [f"source could not be reloaded{tried}: {failure}"]

    missing: list[str] = []

    # Hard facts -- verbatim, case-sensitive.
    for field in ("promo_code", "saving_label"):
        value = record.get(field)
        if isinstance(value, str) and value and not stated_on_page(value, text):
            missing.append(f"{field} is not stated verbatim on source page")

    # Hard facts -- dates (and, for booking_opens_at, the stated time), each
    # matched against verbatim ISO plus every common textual date format.
    for field in ("starts_at", "ends_at", "booking_opens_at"):
        value = record.get(field)
        if isinstance(value, str) and value and not stated_on_page(value, text, is_date=True, is_time=(field == "booking_opens_at")):
            missing.append(f"{field} date is not stated on source page")

    # Hard fact -- a stated weekly recurrence's weekday name(s).
    recurrence = record.get("recurrence") or {}
    if recurrence.get("type") == "weekly" and isinstance(recurrence.get("days"), list):
        if not weekly_days_stated_on_page(recurrence["days"], text):
            missing.append("recurrence weekday is not stated on source page")

    # Soft signal only -- see relevance_signal_present's docstring. Failing
    # this is still recorded (it is real evidence the page may be wrong),
    # just never on the basis of an exact-title mismatch alone.
    if not relevance_signal_present(record, text):
        missing.append("page does not appear to be about this title/venue (soft relevance check)")

    return record, missing


def _coerce_date(value: Any):
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return datetime.strptime(value, "%Y-%m-%d").date()
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def record_is_fully_expired(record: dict[str, Any], today) -> bool:
    """True only when this record carries a concrete date that has already
    elapsed, with nothing upcoming behind it.

    Narrower than "a one-off in the past" (already dropped inside
    build_full_record at research time): a record can also carry a stale
    concrete date under an "annual" or "weekly" recurrence label -- e.g.
    this year's already-finished Fringe/Beltane dates tagged "annual", or a
    weekly chain offer whose stated "until" cutoff has passed -- and neither
    is caught by the once-only check. A record with NO concrete date at all
    is never touched here: that is the correct, intended shape for a
    genuine standing "annual"/"always" placeholder (rule 6 -- "next year's
    row, not this year's, with no starts_at"), and inventing next year's
    date ourselves to compare against would itself be a rule-1 violation.
    """
    if record.get("_collection_members"):
        return False
    # A season-bound offer (festival concessions etc.) is often stored as an
    # "always" row with no concrete dates, and its evergreen policy page keeps
    # re-verifying year-round -- season_valid_until is the one date that
    # retires it (supabase/add_season_valid_until.sql).
    season_end = _coerce_date(record.get("season_valid_until"))
    if season_end is not None and season_end < today:
        return True
    recurrence = record.get("recurrence") or {}
    rec_type = recurrence.get("type")
    if rec_type == "weekly":
        until = _coerce_date(recurrence.get("until"))
        return until is not None and until < today
    if rec_type == "dates":
        dates = [d for d in (_coerce_date(d) for d in recurrence.get("dates") or []) if d]
        return bool(dates) and all(d < today for d in dates)
    concrete = _coerce_date(record.get("ends_at")) or _coerce_date(record.get("starts_at"))
    return concrete is not None and concrete < today


def record_is_low_value(record: dict[str, Any]) -> bool:
    """Reject generic programme/meta narration that names no concrete thing
    to do or concrete offer -- e.g. "late ticket releases happen sometimes
    closer to the date" or "the programme has five reward categories" --
    rather than staging it as a review item a human then has to reject by
    hand.

    Deliberately an OR of independent concreteness signals rather than a
    keyword blocklist, and deliberately generous: a specific venue tied to
    its own dedicated page (e.g. a museum's self-guided trail, with no date
    or price attached) is a real, concrete thing to do and must not be
    caught by this just because it lacks a date or price of its own.
    """
    if record.get("_collection_members"):
        return False
    has_date = bool(record.get("starts_at") or record.get("ends_at") or record.get("booking_opens_at"))
    has_money = bool(
        record.get("promo_code") or record.get("saving_label") or record.get("saving_amount")
    ) or record.get("is_free") is True
    recurrence = record.get("recurrence") or {}
    rec_type = recurrence.get("type")
    has_recurrence_detail = rec_type in ("weekly", "dates") or (
        rec_type == "annual" and recurrence.get("month") and recurrence.get("day")
    )
    has_venue = bool(record.get("venue_name"))
    return not (has_date or has_money or has_recurrence_detail or has_venue)


def make_report(batch_id: str, report: dict[str, Any], report_path: Path) -> None:
    review = report["review"]
    lines = [
        f"# Edinburgh weekly pipeline — {batch_id}", "",
        f"- Research cost (actual reported usage): ${report['cost']['spent_usd']:.4f} of ${report['cost']['cap_usd']:.2f}",
        f"- Direct-source records: {report['direct_records']}",
        f"- Research records before merge: {report['research_records']}",
        f"- Dropped as past/expired before staging: {len(report.get('dropped_expired', []))}",
        f"- Dropped as low-value/generic before staging: {len(report.get('dropped_low_value', []))}",
        f"- Verified records: {len(report['verified'])}",
        f"- Review required: {len(review)}", "",
        "## Dropped — past/expired (not staged, not review items)", "",
    ]
    lines += [f"- {title}" for title in report.get("dropped_expired", [])] or ["- None"]
    lines += ["", "## Dropped — low-value/generic (not staged, not review items)", ""]
    lines += [f"- {title}" for title in report.get("dropped_low_value", [])] or ["- None"]
    lines += ["", "## Identity — already on Fomo", "", "Refreshing an existing row (slug reused):", ""]
    lines += [f"- {title}" for title in report.get("refreshed_known", [])] or ["- None"]
    lines += ["", "Dropped — already in a provider feed:", ""]
    lines += [f"- {note}" for note in report.get("dropped_known_provider_event", [])] or ["- None"]
    lines += ["", "## Review required", ""]
    for item in review:
        lines.append(f"- **{item['title']}** — {item['reason']}")
    lines += ["", "## Ready SQL", "", "```sql", "-- Approve only rows you have reviewed; keep all other rows in staging."]
    slugs = ", ".join("'" + str(slug).replace("'", "''") + "'" for slug in report.get("review_staging_slugs", []))
    slug_sql = slugs or "''"
    lines += [
        "update happenings_staging",
        "set approved = true, extraction_status = 'approved'",
        f"where batch_id = '{batch_id}' and slug in ({slug_sql});",
        "```", "", "## Publish reviewed rows", "",
        f"`node --env-file=.env.local scripts/promote-happenings.mjs --batch-id {batch_id}`", "",
        "## Sources skipped/failed", "",
    ]
    lines += [f"- {item['source']}: {item['reason']}" for item in report["source_failures"]] or ["- None"]
    report_path.write_text("\n".join(lines) + "\n")


def run_tidy() -> str | None:
    """Move expired, dated live rows to dormant before discovering new work.

    ``sweep-happenings`` is intentionally the owner of the live lifecycle
    write: it never deletes and it only changes expired one-off rows.  A
    failure is reported but does not prevent fresh research from being staged.
    """
    try:
        result = subprocess.run(
            ["node", "--env-file=.env.local", "scripts/sweep-happenings.mjs", "--apply"],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=True,
        )
        return result.stdout.strip() or None
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        return f"tidy failed: {detail.strip()}"


def link_batch_records(batch_id: str) -> str | None:
    """Use the existing cautious linker to set high-confidence place ids.

    The helper also backfills high-confidence live links.  It refuses fuzzy
    one-word matches and never creates a place, so this is safe to run before
    staging the current batch.
    """
    try:
        subprocess.run(
            ["python3", "scraper/link_happenings_places.py", "--apply", "--batch-id", batch_id],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=True,
        )
        return None
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        return f"place linking failed: {detail.strip()}"


def attach_publisher_images() -> str | None:
    """Attach source preview images after rows are live; never downloads or
    treats an image as hero quality (the existing helper keeps it 'thin')."""
    try:
        subprocess.run(
            ["python3", "scraper/photos_happenings_og.py"],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=True,
        )
        return None
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        return f"image fetch failed: {detail.strip()}"


def supabase_connection() -> tuple[str, str] | None:
    # happenings has no anon/authenticated write policy — only the
    # service-role key works here, so it's required with no anon fallback.
    url = (os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or "").rstrip("/")
    key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    return (url, key) if url and key else None


def _rest_all(url: str, key: str, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
    """Every row of a PostgREST query, paged past the 1000-row server cap."""
    rows: list[dict[str, Any]] = []
    page = 1000
    while True:
        response = requests.get(
            f"{url}/rest/v1/{table}",
            headers={"apikey": key, "Authorization": f"Bearer {key}", "Range": f"{len(rows)}-{len(rows) + page - 1}"},
            params=params,
            timeout=30,
        )
        response.raise_for_status()
        batch = response.json()
        rows.extend(batch)
        if len(batch) < page:
            return rows


def load_catalogue() -> tuple[Catalogue | None, str | None]:
    """Live + dormant happenings and upcoming provider events, for identity
    matching (scraper/identity.py). Failure is reported, never fatal: the run
    then behaves as before, with only within-run dedupe."""
    connection = supabase_connection()
    if not connection:
        return None, "identity matching skipped: Supabase credentials are unavailable"
    url, key = connection
    try:
        happenings = _rest_all(url, key, "happenings", {
            "status": "in.(live,dormant)",
            "select": "id,slug,title,kind,status,starts_at,recurrence,venue_name,place_id,saving_label,source_url",
        })
        events = _rest_all(url, key, "events", {
            "starts_at": f"gte.{datetime.now(timezone.utc).date().isoformat()}",
            "select": "id,name,starts_at,venue_name,ticket_url",
        })
        return Catalogue(happenings, events), None
    except requests.RequestException as exc:
        return None, f"identity matching skipped: {exc.__class__.__name__}"


def overdue_live_rows() -> tuple[list[dict[str, Any]], str | None]:
    """Fetch every live row not confirmed in the last three weeks.

    This intentionally uses one flat 21-day rule for the weekly job. The
    older per-kind advisory worklist remains available in sweep-happenings,
    but does not water down this pipeline's hard recheck promise.
    """
    connection = supabase_connection()
    if not connection:
        return [], "could not re-check live rows: Supabase credentials are unavailable"
    url, key = connection
    try:
        response = requests.get(
            f"{url}/rest/v1/happenings",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            params={
                "status": "eq.live",
                "select": "id,slug,title,source_url,promo_code,saving_label,starts_at,ends_at,booking_opens_at,verified_at",
            },
            timeout=30,
        )
        response.raise_for_status()
        cutoff = datetime.now(timezone.utc).timestamp() - VERIFY_AFTER_DAYS * 86400
        rows = []
        for row in response.json():
            checked = row.get("verified_at")
            try:
                stamp = datetime.fromisoformat(str(checked).replace("Z", "+00:00")).timestamp() if checked else 0
            except ValueError:
                stamp = 0
            if stamp < cutoff:
                rows.append(row)
        return rows, None
    except requests.RequestException as exc:
        return [], f"could not re-check live rows: {exc.__class__.__name__}"


def patch_live_rechecks(verified_ids: list[str], retired_ids: list[str], now: str) -> str | None:
    connection = supabase_connection()
    if not connection:
        return "could not apply live rechecks: Supabase credentials are unavailable"
    url, key = connection
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Prefer": "return=minimal"}
    try:
        for row_id in verified_ids:
            response = requests.patch(f"{url}/rest/v1/happenings", headers=headers, params={"id": f"eq.{row_id}"}, json={"verified_at": now}, timeout=30)
            response.raise_for_status()
        # Only a definitive 404/410 source result retires a row. A block,
        # timeout, challenge, or merely changed wording stays live and lands in
        # review, rather than being mistaken for a discontinued offer.
        for row_id in retired_ids:
            response = requests.patch(f"{url}/rest/v1/happenings", headers=headers, params={"id": f"eq.{row_id}"}, json={"status": "retired"}, timeout=30)
            response.raise_for_status()
        return None
    except requests.RequestException as exc:
        return f"could not apply live rechecks: {exc.__class__.__name__}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Weekly, cap-aware Edinburgh happenings refresh.")
    parser.add_argument("--batch-id", default=f"edi-weekly-{datetime.now().date().isoformat()}")
    parser.add_argument("--cap-usd", type=float, default=WEEKLY_CAP_USD)
    parser.add_argument("--topic-reserve-usd", type=float, default=0.09, help="Worst-case pre-authorisation per topic; prevents starting work that could exceed the cap.")
    parser.add_argument("--input-usd-per-million", type=float, default=0.28, help="Billed DeepSeek input-token rate used for actual-cost reporting.")
    parser.add_argument("--output-usd-per-million", type=float, default=0.42, help="Billed DeepSeek output-token rate used for actual-cost reporting.")
    parser.add_argument("--search-usd", type=float, default=0.0, help="Billed server-search rate per search, if applicable.")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--limit-topics", type=int, default=None)
    parser.add_argument(
        "--only",
        action="append",
        default=None,
        help="Case-insensitive substring filter on topic name; repeatable. "
        "Only matching topics run (e.g. --only fixtures --only hockey). "
        "Applied before --limit-topics and priority ordering.",
    )
    parser.add_argument("--no-direct", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="Do not call AI, fetch publishers, write staging, or publish.")
    parser.add_argument("--stage", action="store_true", help="Upsert verified rows into happenings_staging (off by default).")
    parser.add_argument("--publish", action="store_true", help="Approve and promote verified rows. Requires --stage; never the default.")
    args = parser.parse_args()
    if args.publish and not args.stage:
        parser.error("--publish requires --stage")
    if args.cap_usd <= 0 or args.topic_reserve_usd <= 0:
        parser.error("cost values must be positive")

    selected_topics = TOPICS
    if args.only:
        needles = [s.lower() for s in args.only]
        selected_topics = tuple(t for t in TOPICS if any(n in t.name.lower() for n in needles))
        if not selected_topics:
            parser.error(f"--only matched no topic names out of: {', '.join(t.name for t in TOPICS)}")

    if args.dry_run:
        print(
            f"[weekly-edinburgh] dry run: {len(DIRECT_SOURCES)} direct sources and "
            f"{len(selected_topics)} independent topics configured"
            + (f" (filtered from {len(TOPICS)} by --only)" if args.only else "") + "."
        )
        return

    out_dir = OUT_ROOT / args.batch_id
    out_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    source_failures: list[dict[str, str]] = []
    candidates: list[dict[str, Any]] = []

    lifecycle_notes: list[str] = []
    tidy_note = run_tidy()
    if tidy_note:
        lifecycle_notes.append(tidy_note)
    if not args.no_direct:
        for source in DIRECT_SOURCES:
            html, final_url, failure = fetch_publisher_page(source)
            if failure:
                source_failures.append({"source": source.name, "reason": failure})
                continue
            candidates.extend(direct_records(source, html or "", final_url or source.url, args.batch_id, now))

    catalogue, catalogue_note = load_catalogue()
    if catalogue_note:
        lifecycle_notes.append(catalogue_note)

    ledger = CostLedger(args.cap_usd, args.input_usd_per_million, args.output_usd_per_million, args.search_usd)
    research_records = 0
    topic_failures: list[dict[str, str]] = []
    planned_topics = sorted(selected_topics, key=lambda topic: -topic.priority)
    if args.limit_topics is not None:
        planned_topics = planned_topics[:args.limit_topics]

    # Fill at most ``workers`` slots only after reserving a worst-case topic
    # amount. This preserves the cap even though actual usage arrives only
    # after a remote call finishes.
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            pending: dict[concurrent.futures.Future[tuple[Topic, list[dict[str, Any]], Usage, str | None]], tuple[Topic, float]] = {}
            iterator = iter(planned_topics)
            exhausted = False
            while True:
                while not exhausted and len(pending) < max(1, args.workers):
                    try:
                        topic = next(iterator)
                    except StopIteration:
                        exhausted = True
                        break
                    if not ledger.reserve(args.topic_reserve_usd):
                        topic_failures.append({"topic": topic.name, "reason": "not started: remaining budget is below the reserved topic ceiling"})
                        exhausted = True
                        break
                    known_lines = catalogue.known_lines(topic.name, topic.seeds, deals=topic.mode == "offers") if catalogue else None
                    future = pool.submit(research_topic, topic, args.batch_id, default_research_model(), known_lines)
                    pending[future] = (topic, args.topic_reserve_usd)
                if not pending:
                    break
                done, _ = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
                for future in done:
                    topic, reserved = pending.pop(future)
                    result_topic, records, usage, failure = future.result()
                    cost = ledger.settle(reserved, usage)
                    if failure:
                        topic_failures.append({"topic": result_topic.name, "reason": failure})
                    else:
                        candidates.extend(records)
                        research_records += len(records)
                    print(f"[weekly-edinburgh] {result_topic.name}: {len(records)} record(s), ${cost:.4f}", flush=True)

    merged, duplicates = merge_records(candidates)

    today = datetime.now(timezone.utc).date()
    kept: list[dict[str, Any]] = []
    dropped_expired: list[str] = []
    for record in merged:
        if record_is_fully_expired(record, today):
            dropped_expired.append(str(record.get("title") or record.get("slug")))
        else:
            kept.append(record)
    merged = kept

    kept = []
    dropped_low_value: list[str] = []
    for record in merged:
        if record_is_low_value(record):
            dropped_low_value.append(str(record.get("title") or record.get("slug")))
        else:
            kept.append(record)
    merged = kept

    # Cross-run identity: known items reuse their slug (so promotion refreshes
    # the existing row), provider-feed duplicates are dropped, and dormant or
    # borderline matches are forced to review (scraper/identity.py).
    dropped_known: list[str] = []
    identity_review: list[str] = []
    if catalogue:
        merged, dropped_known, identity_review = reconcile(merged, catalogue)

    verified: list[dict[str, Any]] = []
    staging_records: list[dict[str, Any]] = []
    review_staging_slugs: list[str] = []
    review: list[dict[str, str]] = [{"slug": "(dedupe)", "title": "Duplicate candidates", "reason": reason} for reason in duplicates]
    rechecked_live: list[str] = []
    retired_live: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for record, reasons in pool.map(verify_record, merged):
            if record.get("_force_review"):
                reasons = [*reasons, str(record["_force_review"])]
            if reasons:
                review.append({"slug": record["slug"], "title": record["title"], "reason": "; ".join(reasons)})
                record["extraction_status"] = "pending"
                record["validation_errors"] = reasons
                staging_records.append(record)
                review_staging_slugs.append(record["slug"])
            else:
                record["extraction_status"] = "validated"
                verified.append(record)
                staging_records.append(record)

    overdue_rows, overdue_failure = overdue_live_rows()
    if overdue_failure:
        lifecycle_notes.append(overdue_failure)
    elif overdue_rows:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            for row, reasons in pool.map(verify_record, overdue_rows):
                if reasons:
                    review.append({"slug": row["slug"], "title": row["title"], "reason": "live recheck: " + "; ".join(reasons)})
                    if any("HTTP 404" in reason or "HTTP 410" in reason for reason in reasons):
                        retired_live.append(row["id"])
                else:
                    rechecked_live.append(row["id"])

    output_json = out_dir / "edinburgh-weekly-candidates.json"
    if args.stage and staging_records:
        # The batch linker edits this file, so write and reload before the
        # staging upsert.  Linking failure is deliberately non-fatal: a row
        # without a place is still a valid source-verified happening.
        output_json.write_text(json.dumps({"records": staging_records}, ensure_ascii=False, indent=2) + "\n")
        link_note = link_batch_records(args.batch_id)
        if link_note:
            lifecycle_notes.append(link_note)
        else:
            staging_records = json.loads(output_json.read_text()).get("records", staging_records)
            verified_slugs = {record["slug"] for record in verified}
            verified = [record for record in staging_records if record.get("slug") in verified_slugs]
    if args.publish:
        for record in verified:
            record["approved"] = True
    output_json.write_text(json.dumps({"records": staging_records}, ensure_ascii=False, indent=2) + "\n")
    (out_dir / "edinburgh-weekly-verified.json").write_text(json.dumps({"records": verified}, ensure_ascii=False, indent=2) + "\n")
    if args.stage and staging_records:
        upsert_happenings(staging_records)

    # Promotion remains an explicit second-run action.  The first invocation
    # cannot become live by accident, even if someone uses --stage.
    if args.publish and verified:
        env = os.environ.copy()
        subprocess.run(["node", "--env-file=.env.local", "scripts/promote-happenings.mjs", "--batch-id", args.batch_id], cwd=REPO_ROOT, env=env, check=True)
        image_note = attach_publisher_images()
        if image_note:
            lifecycle_notes.append(image_note)
    if args.publish and (rechecked_live or retired_live):
        recheck_note = patch_live_rechecks(rechecked_live, retired_live, now)
        if recheck_note:
            lifecycle_notes.append(recheck_note)

    report: dict[str, Any] = {
        "batch_id": args.batch_id,
        "generated_at": now,
        "direct_records": len(candidates) - research_records,
        "research_records": research_records,
        "verified": [{"slug": r["slug"], "title": r["title"]} for r in verified],
        "dropped_expired": dropped_expired,
        "dropped_low_value": dropped_low_value,
        "dropped_known_provider_event": dropped_known,
        "identity_review": identity_review,
        "refreshed_known": [str(r.get("title")) for r in merged if r.get("_known_happening_id")],
        "review": review,
        "review_staging_slugs": review_staging_slugs,
        "source_failures": source_failures + [{"source": f"DeepSeek: {row['topic']}", "reason": row["reason"]} for row in topic_failures] + [{"source": "pipeline", "reason": note} for note in lifecycle_notes],
        "cost": {"spent_usd": ledger.spent, "cap_usd": ledger.cap, "input_tokens": ledger.usage.input_tokens, "output_tokens": ledger.usage.output_tokens, "searches": ledger.usage.searches},
        "published": bool(args.publish and verified),
        "live_rechecks": {"confirmed": len(rechecked_live), "retired": len(retired_live)},
    }
    (out_dir / "weekly-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    make_report(args.batch_id, report, out_dir / "weekly-report.md")
    print(f"[weekly-edinburgh] verified={len(verified)} review={len(review)} report={out_dir / 'weekly-report.md'}")


if __name__ == "__main__":
    main()
