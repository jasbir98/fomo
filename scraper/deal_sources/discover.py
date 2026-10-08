"""Turn a source's `discover` config into page refs (see registry.py)."""

from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from html import unescape
from typing import Any

from deal_sources.fetch import PoliteFetcher
from deal_sources.registry import DealSource
from deal_sources.textutil import html_links

MAX_WP_PAGES = 5
MAX_SITEMAP_CHILDREN = 10


@dataclass
class PageRef:
    url: str
    title: str | None = None
    html: str | None = None  # already in hand (WordPress content); None = fetch it
    image_url: str | None = None
    modified: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


def _wp_modified(item: dict[str, Any]) -> datetime | None:
    raw = item.get("modified_gmt") or item.get("modified")
    if not isinstance(raw, str):
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _wp_image(item: dict[str, Any]) -> str | None:
    media = (item.get("_embedded") or {}).get("wp:featuredmedia")
    if isinstance(media, list) and media and isinstance(media[0], dict):
        url = media[0].get("source_url")
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            return url
    return None


def parse_wp_items(data: Any, now: datetime, modified_within_days: int | None = None) -> tuple[list[PageRef], int]:
    """WordPress REST JSON (a list of pages, or one page object) -> page refs.

    Returns (refs, skipped_old). Items that are not published, have no link or no
    rendered content are dropped; with `modified_within_days`, so are items last
    modified earlier than that.
    """
    items = data if isinstance(data, list) else [data]
    cutoff = now - timedelta(days=modified_within_days) if modified_within_days else None
    refs: list[PageRef] = []
    old = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get("status", "publish") != "publish":
            continue
        link = item.get("link")
        content = (item.get("content") or {}).get("rendered")
        if not (isinstance(link, str) and link and isinstance(content, str) and content.strip()):
            continue
        modified = _wp_modified(item)
        if cutoff is not None and modified is not None and modified < cutoff:
            old += 1
            continue
        title = (item.get("title") or {}).get("rendered")
        refs.append(PageRef(
            url=link,
            title=unescape(title).strip() if isinstance(title, str) else None,
            html=content,
            image_url=_wp_image(item),
            modified=modified.isoformat() if modified else None,
            meta={"wp_id": item.get("id"), "slug": item.get("slug")},
        ))
    return refs, old


_URL_BLOCK_RE = re.compile(r"<url>(.*?)</url>", re.S | re.I)


def parse_sitemap_entries(xml: str) -> list[tuple[str, str | None]]:
    """(page URL, raw <lastmod> or None) for every <url> block of a urlset sitemap."""
    out: list[tuple[str, str | None]] = []
    for block in _URL_BLOCK_RE.findall(xml or ""):
        loc = re.search(r"<loc>\s*([^<\s]+)\s*</loc>", block, re.I)
        if not loc:
            continue
        lastmod = re.search(r"<lastmod>\s*([^<\s]+)\s*</lastmod>", block, re.I)
        out.append((unescape(loc.group(1)), lastmod.group(1) if lastmod else None))
    return out


def _sitemap_date(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_sitemap_locs(xml: str) -> tuple[list[str], list[str]]:
    """(page URLs, child sitemap URLs) from a sitemap or sitemap index."""
    children = re.findall(r"<sitemap>.*?<loc>\s*([^<\s]+)\s*</loc>.*?</sitemap>", xml, re.S | re.I)
    child_set = set(children)
    locs = [unescape(u) for u in re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", xml, re.I)]
    return [u for u in locs if u not in child_set], [unescape(u) for u in children]


def filter_urls(urls: list[str], pattern: str | None, limit: int | None) -> list[str]:
    rx = re.compile(pattern, re.I) if pattern else None
    out: list[str] = []
    for url in urls:
        if rx and not rx.search(url):
            continue
        if url not in out:
            out.append(url)
    return out[:limit] if limit else out


def discover(source: DealSource, fetcher: PoliteFetcher, now: datetime) -> tuple[list[PageRef], list[str]]:
    """Returns (page refs, failure notes). A failed endpoint is a note, never an exception."""
    cfg = source.discover
    kind = cfg["kind"]
    notes: list[str] = []
    refs: list[PageRef] = []

    if kind == "wp_rest":
        for url in cfg["urls"]:
            page = 1
            while page <= MAX_WP_PAGES:
                page_url = url if page == 1 else url + ("&" if "?" in url else "?") + f"page={page}"
                data, resp = fetcher.get_json(page_url)
                if data is None:
                    notes.append(f"{page_url}: {resp.reason}")
                    break
                got, _old = parse_wp_items(data, now, cfg.get("modified_within_days"))
                refs.extend(got)
                total_pages = int(resp.headers.get("x-wp-totalpages", "1") or 1)
                if page >= total_pages or not isinstance(data, list):
                    break
                page += 1
    elif kind == "urls":
        refs = [PageRef(url=u) for u in cfg["urls"]]
    elif kind == "sitemap":
        # One sitemap (`url`) or several (`urls`); each may be a sitemap index.
        entries: list[tuple[str, str | None]] = []
        for sitemap_url in cfg.get("urls") or [cfg["url"]]:
            resp = fetcher.get(sitemap_url, accept="application/xml,text/xml", expect_json=True)
            if not resp.ok:
                notes.append(f"{sitemap_url}: {resp.reason}")
                continue
            _locs, children = parse_sitemap_locs(resp.text or "")
            entries.extend(parse_sitemap_entries(resp.text or ""))
            for child in children[:MAX_SITEMAP_CHILDREN]:
                sub = fetcher.get(child, accept="application/xml,text/xml", expect_json=True)
                if sub.ok:
                    entries.extend(parse_sitemap_entries(sub.text or ""))
                else:
                    notes.append(f"{child}: {sub.reason}")
        window = cfg.get("modified_within_days")
        if window:
            # A URL with no <lastmod> cannot be shown to be recent, so it is dropped.
            aware_now = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
            cutoff = aware_now - timedelta(days=window)
            entries = [(u, lm) for u, lm in entries if (_sitemap_date(lm) or datetime.min.replace(tzinfo=timezone.utc)) >= cutoff]
        refs = [PageRef(url=u) for u in filter_urls([u for u, _lm in entries], cfg.get("pattern"), cfg.get("limit"))]
    elif kind == "link_list":
        resp = fetcher.get(cfg["url"])
        if not resp.ok:
            notes.append(f"{cfg['url']}: {resp.reason}")
        else:
            base = resp.final_url or cfg["url"]
            hrefs = [urllib.parse.urldefrag(h)[0] for _text, h in html_links(resp.text or "", base)]
            refs = [PageRef(url=u) for u in filter_urls(hrefs, cfg.get("href_pattern"), cfg.get("limit"))]

    seen: set[str] = set()
    unique = []
    for ref in refs:
        if ref.url not in seen:
            seen.add(ref.url)
            unique.append(ref)
    return unique, notes
