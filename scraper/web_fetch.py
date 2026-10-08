"""Shared polite-fetch helpers: the bot's identity, robots.txt handling, bot-challenge
detection and a tolerant HTML-to-text parser.

Moved out of weekly_edinburgh.py (unchanged) so scraper/deal_sources/ can reuse the
exact same rules without importing the weekly script. weekly_edinburgh re-imports
every name from here.
"""

from __future__ import annotations

import re
import urllib.robotparser
import urllib.parse
from html import unescape
from html.parser import HTMLParser

import requests

USER_AGENT = "FomoWeeklyEdinburgh/1.0 (+https://fomo.app; polite publisher-data refresh)"


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
