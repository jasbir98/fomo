"""HTML -> text helpers for deal pages (pure, no network)."""

from __future__ import annotations

import hashlib
import re
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urljoin

_BLOCK_TAGS = {
    "p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "br", "tr", "td", "th",
    "section", "article", "header", "footer", "table", "blockquote", "hr", "figure", "figcaption",
    "dt", "dd", "dl", "main", "nav", "aside", "form", "button", "address",
}
_SKIP_TAGS = {"script", "style", "noscript", "template", "svg", "head"}

# Marker the extraction view puts after an anchor so the model can return a
# real booking_url. The gate strips these from quotes (a quote is page text).
LINK_MARKER_RE = re.compile(r"\s*\[link:\s*[^\]\s]+\]")


class _TextExtractor(HTMLParser):
    def __init__(self, with_links: bool, base_url: str | None) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.with_links = with_links
        self.base_url = base_url
        self._skip = 0
        self._href_stack: list[str | None] = []
        self.links: list[tuple[str, str]] = []
        self._link_text: list[list[str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip += 1
            return
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")
        if tag == "a":
            href = dict(attrs).get("href")
            href = href.strip() if isinstance(href, str) else None
            if href and not href.startswith(("#", "mailto:", "tel:", "javascript:")):
                href = urljoin(self.base_url, href) if self.base_url else href
            else:
                href = None
            self._href_stack.append(href)
            self._link_text.append([])

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip = max(0, self._skip - 1)
            return
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")
        if tag == "a" and self._href_stack:
            href = self._href_stack.pop()
            text = re.sub(r"\s+", " ", "".join(self._link_text.pop())).strip()
            if href and href.startswith(("http://", "https://")):
                self.links.append((text, href))
                if self.with_links:
                    self.parts.append(f" [link: {href}]")

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        self.parts.append(data)
        if self._link_text:
            self._link_text[-1].append(data)


def _collapse(text: str) -> str:
    text = text.replace("\xa0", " ")
    lines = [re.sub(r"[ \t\r\f\v]+", " ", line).strip() for line in text.split("\n")]
    out: list[str] = []
    for line in lines:
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip()


def html_to_text(html: str, *, with_links: bool = False, base_url: str | None = None) -> str:
    """Readable text, one block per line. Entities decoded; script/style dropped."""
    parser = _TextExtractor(with_links, base_url)
    parser.feed(html or "")
    parser.close()
    return _collapse("".join(parser.parts))


def html_links(html: str, base_url: str | None = None) -> list[tuple[str, str]]:
    """[(anchor text, absolute href)] for every http(s) link, in page order."""
    parser = _TextExtractor(False, base_url)
    parser.feed(html or "")
    parser.close()
    return parser.links


def normalise_for_hash(text: str) -> str:
    """Whitespace/case-insensitive form used for change detection."""
    return re.sub(r"\s+", " ", unescape(text or "")).strip()


def content_hash(text: str) -> str:
    return hashlib.sha256(normalise_for_hash(text).encode("utf-8")).hexdigest()


class _MetaParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "meta":
            return
        d = {k.lower(): (v or "") for k, v in attrs}
        key = d.get("property") or d.get("name")
        if key and d.get("content") and key.lower() not in self.meta:
            self.meta[key.lower()] = d["content"].strip()


def og_image(html: str, base_url: str | None = None) -> str | None:
    """The page's og:image (or twitter:image), absolute, http(s) only."""
    parser = _MetaParser()
    parser.feed(html or "")
    value = parser.meta.get("og:image") or parser.meta.get("twitter:image")
    if not value:
        return None
    value = urljoin(base_url, value) if base_url else value
    return value if value.startswith(("http://", "https://")) else None


def page_title(html: str) -> str | None:
    m = re.search(r"<title[^>]*>(.*?)</title>", html or "", re.I | re.S)
    return re.sub(r"\s+", " ", unescape(m.group(1))).strip() if m else None


def split_chunks(text: str, max_chars: int, overlap_chars: int = 1500) -> list[str]:
    """Split on line boundaries into chunks of at most ~max_chars. Each chunk
    after the first starts with the last ~overlap_chars of the previous one, so
    an item straddling a boundary is whole in at least one chunk (callers dedupe
    the repeats). A single over-long line is kept whole rather than cut."""
    if len(text) <= max_chars:
        return [text]
    lines = text.split("\n")
    chunks: list[str] = []
    start = 0
    while start < len(lines):
        size, end = 0, start
        while end < len(lines) and (end == start or size + len(lines[end]) + 1 <= max_chars):
            size += len(lines[end]) + 1
            end += 1
        chunks.append("\n".join(lines[start:end]))
        if end >= len(lines):
            break
        # step back for the overlap, but always make forward progress
        back, kept = 0, end
        while kept > start + 1 and back + len(lines[kept - 1]) + 1 <= overlap_chars:
            kept -= 1
            back += len(lines[kept]) + 1
        start = max(kept, start + 1)
    return chunks


def split_blocks(html: str, marker: str, end_marker: str = r"<h[12][\s>]") -> list[str]:
    """Split page HTML into offer blocks at each match of `marker` (a regex for the
    opening tag of one offer card). Each block runs to the next marker and is cut at
    the first section heading (`end_marker`) so the last card of a grid does not swallow
    the rest of the page. Returns [] when the marker does not occur."""
    starts = [m.start() for m in re.finditer(marker, html or "")]
    if not starts:
        return []
    blocks = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(html)
        block = html[start:end]
        cut = re.search(end_marker, block)
        blocks.append(block[: cut.start()] if cut else block)
    return blocks
