"""Cross-run identity for Edinburgh happenings (docs/plan-data-collection.md §2b-2c).

The weekly pipeline used to forget everything between runs: the LLM paraphrases
titles, so the same thing got a new slug every week and `on_conflict=slug`
inserted a duplicate. This module matches each new candidate against what the
catalogue already holds -- live and dormant `happenings`, plus provider
`events` (Skiddle, Ticketmaster, the daily JSON-LD sources) -- so a known item
reuses its existing slug (and so refreshes its row) instead of becoming a new one.

Matching is deliberately conservative. A confident match needs agreeing
evidence (same venue or same date, a high title similarity) and no
contradicting evidence (different date for one-offs, different venue,
different saving figure for deals). Anything borderline is reported as a
"possible duplicate" for review -- never auto-merged.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable
from zoneinfo import ZoneInfo

LONDON = ZoneInfo("Europe/London")

_WORD_RE = re.compile(r"[a-z0-9]+")
# Words that say nothing about WHICH thing a record is. Kept separate from
# weekly_edinburgh's relevance stopwords: that list answers "is this page
# about the record", this one answers "are these two records the same".
_STOPWORDS = {
    "the", "and", "for", "with", "your", "this", "that", "from", "into", "at", "in", "on", "of",
    "a", "an", "to", "by", "all", "our", "are", "you", "get", "new", "now",
    "edinburgh", "edinburghs", "leith", "scotland", "scottish", "uk",
    "ticket", "tickets", "free", "offer", "offers", "deal", "deals", "discount", "discounts",
    "event", "events", "show", "shows", "live", "night", "nights", "day", "days",
    "week", "weekly", "every", "annual", "off", "entry", "admission", "special",
    # Category words: two festivals or two packages share them without being
    # the same thing (Samhuinn vs Beltane Fire Festival).
    "festival", "programme", "package", "concession", "fixture", "home", "release",
    "sale", "full", "season", "pass", "tour", "walk", "market",
}
# Venue names keep place words ("National Museum of Scotland" vs "National
# War Museum" must stay distinct), so they get a much shorter list.
_VENUE_STOPWORDS = {"the", "and", "at", "of", "on", "in", "a", "an", "edinburgh"}
_YEAR_RE = re.compile(r"\b20\d\d\b")
_UNKNOWN = object()


def title_tokens(title: str | None) -> frozenset[str]:
    """Significant, lightly stemmed words of a title. Pure numbers (years,
    dates, prices) are dropped -- deals compare their figures separately."""
    if not title:
        return frozenset()
    out = set()
    for word in _WORD_RE.findall(title.lower().replace("'", "")):
        if word.isdigit() or word in _STOPWORDS or len(word) < 3:
            continue
        if len(word) > 4 and word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]
        out.add(word)
    return frozenset(out)


def venue_tokens(name: str | None) -> frozenset[str]:
    if not name:
        return frozenset()
    return frozenset(w for w in _WORD_RE.findall(name.lower().replace("'", "")) if w not in _VENUE_STOPWORDS)


def title_years(title: str | None) -> frozenset[str]:
    """Edition years in a title -- "Fringe 2026" and "Fringe 2027" are different rows."""
    return frozenset(_YEAR_RE.findall(title or ""))


def saving_figures(*texts: str | None) -> frozenset[str]:
    """Normalised saving figures stated in a deal's text: "pct20", "gbp5", "241"."""
    blob = " ".join(t for t in texts if t).lower()
    figures = {f"pct{m}" for m in re.findall(r"(\d{1,3})\s*%", blob)}
    figures |= {f"gbp{float(m):g}" for m in re.findall(r"£\s*(\d+(?:\.\d{1,2})?)", blob)}
    if re.search(r"\b(2|two)[\s-]*(for|4)[\s-]*(1|one)\b|\bbogof\b", blob):
        figures.add("241")
    return frozenset(figures)


def local_date(value: Any) -> str | None:
    """ISO timestamp -> Europe/London calendar date ("YYYY-MM-DD")."""
    if not value:
        return None
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        return stamp.date().isoformat()
    return stamp.astimezone(LONDON).date().isoformat()


def _is_one_off(record: dict[str, Any]) -> bool:
    recurrence = record.get("recurrence") or {}
    return (recurrence.get("type") if isinstance(recurrence, dict) else None) in (None, "once")


def _weekdays(record: dict[str, Any]) -> frozenset[int]:
    recurrence = record.get("recurrence") or {}
    if not isinstance(recurrence, dict) or recurrence.get("type") != "weekly":
        return frozenset()
    return frozenset(d for d in recurrence.get("days") or [] if isinstance(d, int))


def _jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def _containment(a: frozenset[str], b: frozenset[str]) -> float:
    """Share of the shorter title found in the longer one -- catches the LLM
    appending "at The Stand Comedy Club" to a title we already hold."""
    if len(a) < 2 or len(b) < 2:
        return 0.0
    return len(a & b) / min(len(a), len(b))


@dataclass(frozen=True)
class Entry:
    """One catalogue row, pre-tokenised."""
    table: str              # "happenings" | "events"
    id: str
    slug: str | None
    title: str
    status: str             # happenings: live | dormant; events: "provider"
    is_deal: bool
    one_off: bool
    date: str | None
    place_id: str | None
    venue: frozenset[str]
    tokens: frozenset[str]
    years: frozenset[str]
    weekdays: frozenset[int]
    figures: frozenset[str]
    source_url: str | None

    def line(self) -> str:
        """Compact `title | date | venue` line for the research prompt."""
        venue = " ".join(sorted(self.venue)) or "-"
        return f"{self.title} | {self.date or 'recurring/undated'} | {venue}"


def entry_from_happening(row: dict[str, Any]) -> Entry:
    return Entry(
        table="happenings",
        id=str(row.get("id")),
        slug=row.get("slug"),
        title=str(row.get("title") or ""),
        status=str(row.get("status") or "live"),
        is_deal=row.get("kind") == "deal",
        one_off=_is_one_off(row),
        date=local_date(row.get("starts_at")),
        place_id=row.get("place_id"),
        venue=venue_tokens(row.get("venue_name")),
        tokens=title_tokens(row.get("title")),
        years=title_years(row.get("title")),
        weekdays=_weekdays(row),
        figures=saving_figures(row.get("saving_label"), row.get("title")),
        source_url=row.get("source_url"),
    )


def entry_from_event(row: dict[str, Any]) -> Entry:
    return Entry(
        table="events",
        id=str(row.get("id")),
        slug=None,
        title=str(row.get("name") or row.get("title") or ""),
        status="provider",
        is_deal=False,
        one_off=True,
        date=local_date(row.get("starts_at")),
        place_id=None,
        venue=venue_tokens(row.get("venue_name")),
        tokens=title_tokens(row.get("name") or row.get("title")),
        years=title_years(row.get("name") or row.get("title")),
        weekdays=frozenset(),
        figures=frozenset(),
        source_url=row.get("ticket_url"),
    )


def _same_venue(a: Entry, b: Entry) -> object:
    """True / False, or _UNKNOWN when either side has no venue at all."""
    if a.place_id and b.place_id:
        return a.place_id == b.place_id
    if a.venue and b.venue:
        # Subset counts: "The Stand" vs "The Stand Comedy Club".
        return _jaccard(a.venue, b.venue) >= 0.67 or a.venue <= b.venue or b.venue <= a.venue
    return _UNKNOWN


@dataclass(frozen=True)
class Match:
    verdict: str            # "match" | "possible"
    entry: Entry
    similarity: float
    why: str


def compare(candidate: Entry, known: Entry) -> Match | None:
    """Is `candidate` the same real-world thing as `known`? None when clearly not."""
    if candidate.is_deal != known.is_deal:
        return None
    if candidate.years and known.years and not (candidate.years & known.years):
        return None
    if not candidate.tokens or not known.tokens:
        return None
    venue = _same_venue(candidate, known)
    if venue is False:
        return None
    # Once the venue is established separately, venue words inside titles
    # ("Camera Obscura ...", "... at The Stand") say nothing about WHICH offer
    # or show it is, so compare without them. When it isn't, those words are
    # the only venue evidence there is, so they stay.
    a, b = candidate.tokens, known.tokens
    if venue is True:
        venue_words = candidate.venue | known.venue
        if candidate.tokens - venue_words and known.tokens - venue_words:
            a, b = candidate.tokens - venue_words, known.tokens - venue_words
    # A different date only rules a pair out when both are one-offs; a weekly
    # show's stored starts_at is just one occurrence.
    date_equal = candidate.date is not None and candidate.date == known.date
    if candidate.one_off and known.one_off and candidate.date and known.date and not date_equal:
        return None
    if candidate.is_deal and candidate.figures and known.figures and not (candidate.figures & known.figures):
        return None
    if candidate.weekdays and known.weekdays and not (candidate.weekdays & known.weekdays):
        return None  # the Friday show is not the Saturday show

    # A confident match reuses the known row's slug, so promotion OVERWRITES
    # that row -- a false one silently replaces a different live item. So it
    # needs symmetric overlap (Jaccard); containment alone ("2-Match package"
    # inside "Fiji and Japan family 2-Match") only ever earns a review.
    jaccard = _jaccard(a, b)
    similarity = max(jaccard, 0.9 * _containment(a, b))
    corroborated = venue is True or date_equal
    evidence = ", ".join(e for e, ok in (("same venue", venue is True), ("same date", date_equal)) if ok) or "title only"
    confident = jaccard >= 0.6 if corroborated else (jaccard >= 0.8 and min(len(a), len(b)) >= 2)
    possible_at = 0.4 if corroborated else 0.5
    if confident:
        return Match("match", known, jaccard, f"{evidence}, title {jaccard:.2f}")
    if similarity >= possible_at:
        return Match("possible", known, similarity, f"{evidence}, title {similarity:.2f}")
    return None


class Catalogue:
    """Everything Fomo already knows, for matching and prompt injection."""

    def __init__(self, happenings: Iterable[dict[str, Any]], events: Iterable[dict[str, Any]]):
        self.entries = [entry_from_happening(r) for r in happenings] + [entry_from_event(r) for r in events]

    def best_match(self, record: dict[str, Any]) -> Match | None:
        candidate = entry_from_happening(record)
        best: Match | None = None
        for known in self.entries:
            found = compare(candidate, known)
            if not found:
                continue
            # Prefer confident over possible, then live over dormant over
            # provider rows, then similarity.
            rank = (found.verdict == "match", {"live": 2, "dormant": 1}.get(known.status, 0), found.similarity)
            if best is None or rank > (best.verdict == "match", {"live": 2, "dormant": 1}.get(best.entry.status, 0), best.similarity):
                best = found
        return best

    def known_lines(self, topic_name: str, seeds: Iterable[str], deals: bool, limit: int = 40) -> list[str]:
        """Live happenings most relevant to one research topic: same seed
        domain first, then title overlap with the topic name."""
        topic = title_tokens(topic_name)
        seed_hosts = [s.split("/")[0].lower() for s in seeds]
        scored = []
        for entry in self.entries:
            if entry.table != "happenings" or entry.status != "live" or entry.is_deal != deals:
                continue
            from_seed = bool(entry.source_url) and any(h in entry.source_url.lower() for h in seed_hosts)
            overlap = len(entry.tokens & topic)
            if from_seed or overlap:
                scored.append((from_seed, overlap, entry.title, entry))
        scored.sort(key=lambda s: (-s[0], -s[1], s[2]))
        return [s[3].line() for s in scored[:limit]]


def reconcile(records: list[dict[str, Any]], catalogue: Catalogue) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    """Apply catalogue identity to this run's candidates.

    Returns (kept, dropped_notes, review_notes). For each kept record:
      - confident match to a LIVE happening -> reuse its slug, so staging and
        promotion refresh that row instead of inserting a duplicate;
      - confident match to a DORMANT happening -> reuse its slug but force
        review (it was retired on purpose -- a human decides if it's back);
      - confident match to a provider EVENT (non-deal) -> dropped; the daily
        feeds already supply it, with a booking link;
      - possible match to anything -> kept but forced to review.
    `_force_review` is read by the verify step; underscore keys never reach
    staging (upsert_happenings only sends ALLOWED_COLUMNS).
    """
    kept: list[dict[str, Any]] = []
    dropped: list[str] = []
    review: list[str] = []
    for record in records:
        found = catalogue.best_match(record)
        title = str(record.get("title") or record.get("slug"))
        if found is None:
            kept.append(record)
            continue
        known = found.entry
        if found.verdict == "match" and known.table == "events":
            dropped.append(f"{title}: already in provider feed as '{known.title}' ({found.why})")
            continue
        if found.verdict == "match" and known.slug:
            record["slug"] = known.slug
            record["_known_happening_id"] = known.id
            if known.status != "live":
                record["_force_review"] = f"matches {known.status} row '{known.title}' ({found.why}) -- revive?"
                review.append(f"{title}: {record['_force_review']}")
        else:
            record["_force_review"] = f"possible duplicate of {known.table} '{known.title}' ({found.why})"
            review.append(f"{title}: {record['_force_review']}")
        kept.append(record)
    return kept, dropped, review
