"""Polite fetching for deal sources.

Reuses the weekly pipeline's rules (scraper/web_fetch.py): the real bot
User-Agent, robots.txt obeyed, and skip -- never work around -- 401/403/429/503
and bot-challenge pages. Adds a per-host robots cache and a minimum gap between
requests to one host.
"""

from __future__ import annotations

import json
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any

import requests

from web_fetch import USER_AGENT, TextParser, _looks_like_challenge_page, robot_allows

MIN_GAP_SECONDS = 1.0
TIMEOUT_SECONDS = 25
BLOCK_STATUSES = (401, 403, 429, 503)


@dataclass
class Response:
    ok: bool
    url: str
    final_url: str | None = None
    status: int | None = None
    text: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    reason: str | None = None  # why it was skipped when ok is False


class PoliteFetcher:
    def __init__(self, min_gap: float = MIN_GAP_SECONDS) -> None:
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})
        self.min_gap = min_gap
        self._last_hit: dict[str, float] = {}
        self._robots: dict[str, tuple[bool, str | None]] = {}
        self.requests_made = 0

    def _wait(self, host: str) -> None:
        last = self._last_hit.get(host)
        if last is not None:
            delay = self.min_gap - (time.monotonic() - last)
            if delay > 0:
                time.sleep(delay)
        self._last_hit[host] = time.monotonic()

    def _robots_ok(self, url: str) -> tuple[bool, str | None]:
        # robots.txt is per host and weekly_edinburgh.robot_allows re-fetches it on
        # every call, so cache the verdict per host + first path segment (a bare
        # host key would hide a `Disallow: /wp-json` behind an allowed /offers).
        parts = urllib.parse.urlsplit(url)
        segments = [s for s in parts.path.split("/") if s]
        key = f"{parts.netloc}/{segments[0] if segments else ''}"
        if key not in self._robots:
            self._wait(parts.netloc)
            self._robots[key] = robot_allows(url, self.session)
        return self._robots[key]

    def get(self, url: str, accept: str = "text/html,application/xhtml+xml", expect_json: bool = False) -> Response:
        allowed, why = self._robots_ok(url)
        if not allowed:
            return Response(False, url, reason=why or "robots.txt disallows this page")
        host = urllib.parse.urlsplit(url).netloc
        self._wait(host)
        self.requests_made += 1
        try:
            resp = self.session.get(url, headers={"Accept": accept}, timeout=TIMEOUT_SECONDS, allow_redirects=True)
        except requests.RequestException as exc:
            return Response(False, url, reason=f"request failed: {exc.__class__.__name__}")
        headers = {k.lower(): v for k, v in resp.headers.items()}
        if resp.status_code in BLOCK_STATUSES:
            return Response(False, url, resp.url, resp.status_code, headers=headers,
                            reason=f"blocked/challenged (HTTP {resp.status_code})")
        if resp.status_code != 200:
            return Response(False, url, resp.url, resp.status_code, headers=headers, reason=f"HTTP {resp.status_code}")
        if not expect_json:
            probe = TextParser()
            probe.feed(resp.text)
            if _looks_like_challenge_page(resp.text, probe.text):
                return Response(False, url, resp.url, resp.status_code, headers=headers,
                                reason=f"blocked/challenged (HTTP {resp.status_code})")
        return Response(True, url, resp.url, resp.status_code, resp.text, headers)

    def get_json(self, url: str) -> tuple[Any | None, Response]:
        resp = self.get(url, accept="application/json", expect_json=True)
        if not resp.ok:
            return None, resp
        try:
            return json.loads(resp.text or ""), resp
        except json.JSONDecodeError:
            resp.ok = False
            resp.reason = "response was not valid JSON"
            return None, resp
