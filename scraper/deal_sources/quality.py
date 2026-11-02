"""Value-based quality score and routing for deals (pure apart from loading the benchmarks JSON).

is_genuine_deal (gate.py) asks whether a deal is worded like a discount. This asks whether it is
worth showing: a score from 0 to 100, then a route:

  publish  strong, clean, from a web page: could go live without a person looking
  digest   worth a person's glance (the weekly review / digest)
  drop     not worth anyone's time

The pipeline (scraper/deal_routing.py, called from weekly_edinburgh.py) scores and routes every
final record of a run and stores the result on the staged row. Acting on a "publish" route is
off unless the run is started with --auto-publish (shadow mode: it only reports "would publish").

Ports kept in step with the app by hand:
  * dealDepth, dayRarity, NATIONAL_CHAINS and isNationalChain: lib/happenings/deal-score.ts
  * normalizeRecurrence (the weekly branch): lib/happenings/occurrence.ts
  * the cheap-price rule and lib/happenings/price-benchmarks.json: gate.py (is_cheap_price)

Nothing here touches the network. rate_relevance makes one DeepSeek call per batch through an
injected callable (scraper/deal_routing.py supplies one built on llm_client.make_research_client).
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

from deal_sources.gate import cheap_price_match, stated_prices
from record_checks import record_is_fully_expired

LONDON = ZoneInfo("Europe/London")

# --- thresholds and weights (tune after the backtest) ------------------------------------

DROP_BELOW = 40  # score under this routes to drop
PUBLISH_AT = 70  # score at or over this (plus the clean checks) routes to publish
DAILY_PUBLISH_LIMIT = 10
VENUE_PUBLISH_LIMIT = 1  # in one run, per normalised venue (title when there is no venue)
SOURCE_PUBLISH_LIMIT = 4  # in one run, per source_name

BASE_SCORE = 20
DEPTH_WEIGHT = 0.6  # saving depth (0-90 %) x this
DEPTH_MAX = 30
CHEAP_PRICE_VALUE = 25
CHEAP_PRICE_VALUE_DEEP = 35  # price at or under DEEP_PRICE_RATIO of its line
DEEP_PRICE_RATIO = 0.7
FREE_VALUE = 20  # non-deal kinds: free (was 30: a free night is nice, but it has to be worth going out for)
LOW_PRICE_VALUE = 15  # non-deal kinds: a stated price at or under LOW_PRICE_GBP (was 20)
LOW_PRICE_GBP = 10
CHAIN_PENALTY = 25
LOCAL_BONUS = 15
EVIDENCE_BONUS = 10
LIVE_VERIFIED_DAYS = 14  # a live row (no extraction_status) earns the evidence bonus if verified this recently
HIGH_PRICE_GBP = 60
HIGH_PRICE_PENALTY = 25  # price over HIGH_PRICE_GBP, or hospitality / package in the title
SPEND_PERSON_GBP = 25  # a current price per person over this is not a cheap thing
SPEND_PENALTY = 15
HIRE_PENALTY = 20
SERVICE_PENALTY = 15  # beauty, hair, clinical and therapy services
RATING_CAPS = {1: 25, 2: 45, 3: 69}  # an AI rating of 4 or 5 caps nothing
NON_DEAL_CAP = PUBLISH_AT - 1  # an event, activity, free_access, festival or tour scores at most this ...
NON_DEAL_UNCAPPED_RATING = (5,)  # ... unless it has a stated free or low price AND an AI rating of 5 ("worth going out of your way for")
NON_DEAL_DAILY_LIMIT = 3  # of the day's DAILY_PUBLISH_LIMIT auto-publishes, at most this many may be non-deals
ANNUAL_LEAD_DAYS = 45  # an annual row is in season from this many days before its date (lib/happenings/season.ts)

AUDIENCE_POINTS = {
    "student": 10, "under_26": 10,
    "anyone": 5, "local_resident": 5, "family": 5,
    "member": -10, "over_60": -10, "cardholder": -10,
}

DEAL_KINDS = ("deal",)
OTHER_KINDS = ("event", "activity", "free_access", "festival", "tour")

# The only validation_errors entry that does not stop a publish: a commercial source's deal
# always carries it (weekly_edinburgh.py). Any other entry, including identity's
# "possible duplicate of ..." and "matches dormant row ... -- revive?", blocks it.
ALLOWED_VALIDATION_ERRORS = ("commercial_source_review",)
PUBLISH_SOURCE_CLASSES = ("web",)  # social and newsletter deals are never auto-published


@dataclass
class QualityResult:
    score: int
    reasons: list[str] = field(default_factory=list)


# --- ports from lib/happenings/deal-score.ts ---------------------------------------------

# Keep in step with NATIONAL_CHAINS in lib/happenings/deal-score.ts (same names, same whole-word match).
NATIONAL_CHAINS = (
    "all bar one", "ask italian", "bella italia", "boom battle bar", "brewdog", "browns", "burger king",
    "byron", "caffe nero", "caffè nero", "cineworld", "cosmo", "costa", "côte", "dishoom", "domino's",
    "escape hunt", "everyman", "five guys", "frankie & benny's", "gourmet burger kitchen", "greggs",
    "harvester", "hotel du vin", "hotel indigo", "ibis", "itsu", "kfc", "las iguanas", "leon",
    "mcdonald's", "miller & carter", "nando's", "nuffield health", "o'neill's", "odeon", "pho",
    "pizza express", "pizza hut", "pizzaexpress", "premier inn", "pret", "prezzo", "puregym",
    "revolution", "slug & lettuce", "slug and lettuce", "starbucks", "subway", "superdrug",
    "tgi fridays", "the body shop", "the gym group", "tiger tiger", "toby carvery", "travelodge",
    "turtle bay", "vue", "wagamama", "wahaca", "wetherspoon", "yo! sushi", "zizzi",
    # UK-wide travel cards: useful, not a find.
    "railcard", "ridacard",
)
# Whole-word match. `[^\W_]` is a letter or digit, so the edges are spelled out as in the TS
# version (`\b` fails next to "!" or "'").
_CHAIN_RE = re.compile(
    r"(?<![^\W_])(?:" + "|".join(re.escape(c) for c in sorted(NATIONAL_CHAINS, key=len, reverse=True)) + r")(?![^\W_])",
    re.I,
)


def is_national_chain(record: dict[str, Any]) -> bool:
    name = (record.get("venue_name") or "").strip() or str(record.get("title") or "")
    return bool(_CHAIN_RE.search(re.sub("[‘’]", "'", name)))


def deal_depth(title: str, saving_label: str | None) -> int:
    """Rough discount depth as a percentage, 0-90 (dealDepth in deal-score.ts)."""
    text = f"{saving_label or ''} {title or ''}"
    percents = [int(m) for m in re.findall(r"(\d{1,2})\s*%", text)]
    if percents:
        return min(max(percents), 90)
    if re.search(r"\b1/3\s*off\b", text, re.I):
        return 33
    if re.search(r"\b2[\s-]?for[\s-]?1\b|\bhalf[\s-]?price\b|\bbogof\b", text, re.I):
        return 50
    if re.search(r"\b(free|complimentary)\b", text, re.I):
        return 40
    if re.search(r"£\s*\d+(?:\.\d+)?\s*off\b", text, re.I):
        return 20
    price = re.search(r"£\s*(\d+(?:\.\d+)?)", text)
    if price:
        pounds = float(price.group(1))
        if pounds <= 6:
            return 40
        if pounds <= 15:
            return 20
    return 10


def day_rarity(days: int) -> int:
    """Points for a weekly offer on only a few days a week (dayRarity in deal-score.ts)."""
    if days <= 2:
        return 20
    if days <= 4:
        return 8
    return 0


def weekly_day_count(recurrence: Any) -> int | None:
    """Days per week of a weekly recurrence, or None for anything else
    (the weekly branch of normalizeRecurrence in occurrence.ts: valid days are integers 0-6,
    none valid means the fallback 'once')."""
    if not isinstance(recurrence, dict) or recurrence.get("type") != "weekly":
        return None
    days = [d for d in recurrence.get("days") or [] if isinstance(d, int) and not isinstance(d, bool) and 0 <= d <= 6]
    return len(days) or None


def _round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))  # JS Math.round, not Python's banker's rounding


# --- prices as the person would pay them ---------------------------------------------------

_POUNDS_RE = re.compile(r"£\s?(\d[\d,]*(?:\.\d+)?)")
_OFF_AFTER_RE = re.compile(r"\s*off\b", re.I)
_SAVE_BEFORE_RE = re.compile(r"\bsav(?:e|es|ed|ing|ings)\s*(?:up to\s*)?(?:of\s*)?$", re.I)
# A former or comparison price ("Was £98", "(usually £100)", "worth £120", "RRP £50"), not what you pay.
_WAS_BEFORE_RE = re.compile(r"\b(?:was|usually|normally|worth|rrp|originally)\s*:?\s*(?:from\s*|only\s*)?$", re.I)
_FOR_FOUR_RE = re.compile(r"\bfor\s+(?:four|4)\b", re.I)
_FOR_TWO_RE = re.compile(r"\bfor\s+(?:two|2)\b", re.I)


def current_prices(text: str) -> list[float]:
    """£ figures that are a current price per person: not "£5 off", "save £5" or a was/usually/
    worth/RRP/originally price. Divided by 4 for "for four" and by 2 for "for two".
    (gate.stated_prices, which the TypeScript mirrors copy, is deliberately left as it is.)"""
    prices: list[float] = []
    for m in _POUNDS_RE.finditer(text or ""):
        before = text[:m.start()]
        if _OFF_AFTER_RE.match(text, m.end()) or _SAVE_BEFORE_RE.search(before) or _WAS_BEFORE_RE.search(before):
            continue
        try:
            prices.append(float(m.group(1).replace(",", "")))
        except ValueError:
            pass
    divisor = 4 if _FOR_FOUR_RE.search(text or "") else (2 if _FOR_TWO_RE.search(text or "") else 1)
    return [p / divisor for p in prices]


# --- where it is ---------------------------------------------------------------------------
# Keep in step with locate() and its constants in lib/happenings/deal-review.ts (postcode, then a
# town name in the venue or title, then the pin; no data means keep). A national-scope row is exempt there too.

POSTCODE_OUTWARD_RE = re.compile(r"\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*\d[A-Z]{2}\b", re.I)
# EH1-EH17, EH28-EH30, and the non-geographic EH91/95/99. (gate.py's list omits 91/95/99.)
EDINBURGH_EH_DISTRICTS = frozenset({*range(1, 18), 28, 29, 30, 91, 95, 99})
OUTSIDE_TOWNS = (
    "Musselburgh", "Dalkeith", "Bonnyrigg", "Loanhead", "Lasswade", "Penicuik", "Livingston", "Linlithgow",
    "Bathgate", "Broxburn", "Haddington", "North Berwick", "Dunbar", "Prestonpans", "Tranent", "Gorebridge",
    "Glasgow", "Stirling", "Dunfermline", "Kirkcaldy", "Peebles", "Innerleithen", "Inverness", "Fort William",
)
# A town name directly followed by a street word is a street, not the town: "Dalkeith Road" is a
# real Edinburgh street (keep in step with STREET_WORDS in lib/happenings/deal-review.ts).
STREET_WORDS = ("Road", "Rd", "Street", "St", "Place", "Pl", "Avenue", "Ave", "Terrace", "Lane")
_OUTSIDE_TOWN_RE = re.compile(
    r"\b(" + "|".join(OUTSIDE_TOWNS) + r")\b(?!\s+(?:" + "|".join(STREET_WORDS) + r")\b)", re.I)
EDINBURGH_BBOX = {"minLat": 55.85, "maxLat": 56.0, "minLng": -3.45, "maxLng": -3.05}


def locate(record: dict[str, Any]) -> tuple[bool, str] | None:
    """(inside Edinburgh, why) from the first signal that answers, or None when none does."""
    pc = POSTCODE_OUTWARD_RE.search(record.get("address") or "")
    if pc:
        outward = pc.group(1).upper()
        m = re.fullmatch(r"EH(\d{1,2})[A-Z]?", outward)
        return (m is not None and int(m.group(1)) in EDINBURGH_EH_DISTRICTS), f"{outward} postcode"
    for text in (record.get("venue_name"), record.get("title")):
        town = _OUTSIDE_TOWN_RE.search(text or "")
        if town:
            return False, next((t for t in OUTSIDE_TOWNS if t.lower() == town.group(1).lower()), town.group(1))
    lat, lng = record.get("lat"), record.get("lng")
    if isinstance(lat, (int, float)) and isinstance(lng, (int, float)) and not isinstance(lat, bool) and not isinstance(lng, bool):
        box = EDINBURGH_BBOX
        inside = box["minLat"] <= lat <= box["maxLat"] and box["minLng"] <= lng <= box["maxLng"]
        return inside, f"pin {lat}, {lng}"
    return None


# --- what the row says about when ------------------------------------------------------------

# A pattern that is not "every week": "second and last Monday", "first Friday of the month", "every other
# week", "fortnightly", "monthly". A record that says weekly while its own text says one of these is wrong.
_ORDINAL = r"(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)"
_WEEKDAY = r"(?:mon|tues|wednes|thurs|fri|satur|sun)day"
DIFFERENT_PATTERN_RE = re.compile(
    rf"\b{_ORDINAL}(?:\s*(?:,|and|&|or)\s*{_ORDINAL})*\s+{_WEEKDAY}s?\b"
    r"|\bevery\s+other\b|\bevery\s+(?:two|2|second|third|fourth)\s+(?:weeks?|months?)\b|\balternate\s+(?:weeks?|weekends?)\b"
    r"|\bfortnightly\b|\bbi-?weekly\b|\bmonthly\b|\b(?:each|every)\s+month\b|\bonce\s+a\s+month\b",
    re.I,
)
PATTERN_TEXT_FIELDS = ("title", "summary", "time_note", "redemption_note", "eligibility_note", "saving_label", "price_text", "evidence_quote", "page_excerpt")


def _evidence_quote_text(record: dict[str, Any]) -> str:
    evidence = record.get("_evidence")
    if not isinstance(evidence, dict):
        return ""
    quotes = [evidence.get("deal_quote")]
    fields = evidence.get("fields")
    if isinstance(fields, dict):
        quotes += [v.get("quote") for v in fields.values() if isinstance(v, dict)]
    return " ".join(q for q in quotes if isinstance(q, str))


def different_pattern(record: dict[str, Any]) -> str | None:
    """The wording that says this is not a plain weekly thing ("second and last Monday", "monthly"), found in the
    row's own text, its quote or the page excerpt; None when there is none. Only meaningful for a weekly record."""
    text = " ".join(str(record.get(k) or "") for k in PATTERN_TEXT_FIELDS) + " " + _evidence_quote_text(record)
    m = DIFFERENT_PATTERN_RE.search(text)
    return " ".join(m.group(0).split()).lower() if m else None


def weekly_pattern_conflict(record: dict[str, Any]) -> str | None:
    """Set when the record says weekly but its text says a different pattern. Such a row earns no limited-days bonus and cannot publish."""
    if weekly_day_count(record.get("recurrence")) is None:
        return None
    return different_pattern(record)


def annual_out_of_season(record: dict[str, Any], today: date) -> str | None:
    """Why an annual row is out of season today, or None. The app's rule (lib/happenings/season.ts): an annual row shows
    from ANNUAL_LEAD_DAYS before its date. So one whose date this year has passed (next one is next year), or whose next
    one is more than ANNUAL_LEAD_DAYS away, is out of season. Applied to every kind here, not only deals and free access.
    A row without a month and day is never judged."""
    rec = record.get("recurrence")
    if not isinstance(rec, dict) or rec.get("type") != "annual":
        return None
    month, day = rec.get("month"), rec.get("day")
    if not (isinstance(month, int) and isinstance(day, int)) or isinstance(month, bool) or isinstance(day, bool):
        return None
    nxt = None
    for year in (today.year, today.year + 1):
        try:
            candidate = date(year, month, day)
        except ValueError:
            continue
        if candidate >= today:
            nxt = candidate
            break
    if nxt is None:
        return None
    lead = (nxt - today).days
    if lead > ANNUAL_LEAD_DAYS:
        return f"out of season: annual, next on {nxt.isoformat()} ({lead} days away, shown from {ANNUAL_LEAD_DAYS})"
    return None


# --- score -------------------------------------------------------------------------------

_HIRE_RE = re.compile(r"\bhire\b", re.I)
_HIGH_PRICE_WORDS_RE = re.compile(r"\b(?:hospitality|package)\b", re.I)
# "screening" alone would catch "film screening"; the clinical sense is meant.
_SERVICE_RE = re.compile(
    r"\b(?:treatments?|massages?|hair(?:cuts?|dressing)?|(?<!film )(?<!movie )screening|chiropractic|styling|beauty|therap(?:y|ies|ist))\b",
    re.I,
)


def _has_quote_evidence(record: dict[str, Any]) -> bool:
    evidence = record.get("_evidence")
    if not isinstance(evidence, dict):
        return False
    fields = evidence.get("fields")
    return bool(evidence.get("deal_quote")) or (isinstance(fields, dict) and any(v.get("quote") for v in fields.values() if isinstance(v, dict)))


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = re.sub(r"(\.\d{1,6})\d*", r"\1", value.strip().replace("Z", "+00:00"))
    text = re.sub(r"\.(\d+)", lambda m: "." + m.group(1).ljust(6, "0"), text)  # 3.10 wants 3 or 6 digits
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def has_evidence(record: dict[str, Any], now: datetime | None = None) -> bool:
    """Quote evidence from the gate, a validated extraction, or (a live `happenings` row, which has
    no extraction_status) a verified_at within LIVE_VERIFIED_DAYS. The verified_at that
    build_full_record stamps on a freshly extracted staged row earns nothing."""
    if _has_quote_evidence(record):
        return True
    status = record.get("extraction_status")
    if status == "validated":
        return True
    if status is None:
        verified = _parse_timestamp(record.get("verified_at"))
        if verified is not None:
            return (now or datetime.now(timezone.utc)) - verified <= timedelta(days=LIVE_VERIFIED_DAYS)
    return False


def _value_points(record: dict[str, Any], title: str, label: str) -> tuple[int, str] | None:
    kind = record.get("kind") or "deal"
    if kind in DEAL_KINDS:
        best: tuple[int, str] | None = None
        depth = deal_depth(title, label)
        depth_points = min(_round_half_up(depth * DEPTH_WEIGHT), DEPTH_MAX)
        best = (depth_points, f"saving depth about {depth}%")
        match = cheap_price_match(title, label)
        if match:
            deep = match["price"] <= DEEP_PRICE_RATIO * match["max_gbp"]
            cheap_points = CHEAP_PRICE_VALUE_DEEP if deep else CHEAP_PRICE_VALUE
            if cheap_points > best[0]:
                best = (cheap_points, f"cheap {match['id'].replace('_', ' ')} at £{match['price']:g} (line £{match['max_gbp']:g})")
        return best
    if record.get("is_free") is True:
        return FREE_VALUE, "free"
    prices = stated_prices(f"{title} {label} {record.get('price_text') or ''}")
    if prices and min(prices) <= LOW_PRICE_GBP:
        return LOW_PRICE_VALUE, f"low price £{min(prices):g}"
    return None


def score_deal(record: dict[str, Any], *, ai_rating: int | None = None, now: datetime | None = None) -> QualityResult:
    """Score one record (a happenings row or a build_full_record dict) from 0 to 100.
    `now` only matters for the live-row evidence rule (default: the current time)."""
    title = str(record.get("title") or "")
    label = str(record.get("saving_label") or "")
    reasons: list[str] = []
    score = BASE_SCORE
    reasons.append(f"base +{BASE_SCORE}")

    value = _value_points(record, title, label)
    if value:
        score += value[0]
        reasons.append(f"value: {value[1]} +{value[0]}")

    days = weekly_day_count(record.get("recurrence"))
    if days is not None:
        conflict = different_pattern(record)
        if (record.get("kind") or "deal") not in DEAL_KINDS:
            pass  # a weekly quiz or open mic is not rare: no limited-days bonus for anything that is not a deal
        elif conflict:
            reasons.append(f"limited days not counted: the text says '{conflict}', not every week")
        else:
            points = day_rarity(days)
            if points:
                score += points
                reasons.append(f"limited days: {days} a week +{points}")

    if is_national_chain(record):
        score -= CHAIN_PENALTY
        reasons.append(f"national chain -{CHAIN_PENALTY}")
    else:
        score += LOCAL_BONUS
        reasons.append(f"local +{LOCAL_BONUS}")

    audience = AUDIENCE_POINTS.get(str(record.get("eligibility") or "anyone"), 0)
    if audience:
        score += audience
        reasons.append(f"audience {record.get('eligibility') or 'anyone'} {audience:+d}")

    if has_evidence(record, now):
        score += EVIDENCE_BONUS
        reasons.append(f"evidence +{EVIDENCE_BONUS}")

    text = f"{title} {label}"
    current = current_prices(f"{text} {record.get('price_text') or ''}")
    if current and max(current) > HIGH_PRICE_GBP:
        score -= HIGH_PRICE_PENALTY
        reasons.append(f"poor fit: price over £{HIGH_PRICE_GBP} -{HIGH_PRICE_PENALTY}")
    elif _HIGH_PRICE_WORDS_RE.search(title):
        score -= HIGH_PRICE_PENALTY
        reasons.append(f"poor fit: hospitality or package -{HIGH_PRICE_PENALTY}")
    elif current and min(current) > SPEND_PERSON_GBP:
        score -= SPEND_PENALTY
        reasons.append(f"poor fit: £{min(current):g} a head -{SPEND_PENALTY}")
    if _HIRE_RE.search(text):
        score -= HIRE_PENALTY
        reasons.append(f"poor fit: hire -{HIRE_PENALTY}")
    if _SERVICE_RE.search(text):
        score -= SERVICE_PENALTY
        reasons.append(f"poor fit: beauty, hair or clinical service -{SERVICE_PENALTY}")

    score = max(0, min(100, score))
    cap = RATING_CAPS.get(ai_rating) if isinstance(ai_rating, int) and not isinstance(ai_rating, bool) else None
    if cap is not None and score > cap:
        score = cap
        reasons.append(f"AI relevance {ai_rating}/5 caps the score at {cap}")
    # Only a deal can reach publish on its score alone. Anything else (a quiz night, a gig, a tour) needs a
    # stated free or low price AND a good AI rating, so with no rating it can never route publish.
    if (record.get("kind") or "deal") not in DEAL_KINDS and score > NON_DEAL_CAP:
        rated_well = isinstance(ai_rating, int) and not isinstance(ai_rating, bool) and ai_rating in NON_DEAL_UNCAPPED_RATING
        if not (value and rated_well):
            score = NON_DEAL_CAP
            why = "no stated free or low price" if not value else "no AI rating of 5"
            reasons.append(f"not a deal: capped at {NON_DEAL_CAP} ({why})")
    return QualityResult(score, reasons)


# --- route -------------------------------------------------------------------------------


def _validation_errors(record: dict[str, Any]) -> list[str]:
    """validation_errors plus identity's `_force_review` (set before classify() copies it in)."""
    errors = [str(e) for e in record.get("validation_errors") or []]
    if record.get("_force_review"):
        errors.append(str(record["_force_review"]))
    return errors


def route_deal(record: dict[str, Any], result: QualityResult, *, source_class: str, today: date | None = None) -> str:
    """'publish', 'digest' or 'drop'. source_class is 'web', 'social' or 'newsletter'.
    A record whose dates have all passed, or that is outside Edinburgh (national scope is exempt), is
    dropped whatever its score, and the reason is added to `result.reasons`. `today` defaults to today in London."""
    if record_is_fully_expired(record, today or datetime.now(LONDON).date()):
        reason = "expired: every stated date has passed"
        if reason not in result.reasons:
            result.reasons.append(reason)
        return "drop"
    if record.get("scope") != "national":
        place = locate(record)
        if place and not place[0]:
            reason = f"outside Edinburgh: {place[1]}"
            if reason not in result.reasons:
                result.reasons.append(reason)
            return "drop"
    if result.score < DROP_BELOW:
        return "drop"
    # Never publish, and the digest does not show it: an annual row out of season (see lib/review/digest.ts).
    season = annual_out_of_season(record, today or datetime.now(LONDON).date())
    if season:
        if season not in result.reasons:
            result.reasons.append(season)
        return "digest"
    conflict = weekly_pattern_conflict(record)
    if conflict:
        reason = f"not every week: the text says '{conflict}', so it cannot publish as a weekly row"
        if reason not in result.reasons:
            result.reasons.append(reason)
        return "digest"
    blocking = [e for e in _validation_errors(record) if e not in ALLOWED_VALIDATION_ERRORS]
    passed_gate = bool(record.get("_evidence"))  # deal-source records carry the gate's evidence
    if (result.score >= PUBLISH_AT and not blocking and source_class in PUBLISH_SOURCE_CLASSES
            and (record.get("extraction_status") == "validated" or passed_gate)):
        return "publish"
    return "digest"


@dataclass
class RoutedDeal:
    record: dict[str, Any]
    result: QualityResult
    route: str


_VENUE_NOISE = {"the", "edinburgh"}

# Area words that may follow a venue's name for one of its branches ("Civerinos Portobello").
# Deliberately a list, not general containment: "The Stand" must not merge with "The Standing Order".
EDINBURGH_AREAS = (
    "portobello", "leith", "morningside", "stockbridge", "bruntsfield", "newington", "marchmont", "tollcross",
    "grassmarket", "cramond", "corstorphine", "newhaven", "fountainbridge", "haymarket", "gorgie", "dalry",
    "canonmills", "broughton", "comely bank", "quartermile", "holyrood", "abbeyhill", "bonnington",
    "murrayfield", "craigleith", "duddingston", "joppa", "sciennes", "polwarth", "shandon", "slateford",
    "southside", "old town", "new town", "west end", "city centre", "south queensferry", "kirkliston",
    "ratho", "currie", "juniper green", "colinton", "balerno", "gyle", "ocean terminal", "fort kinnaird",
)


def venue_key(record: dict[str, Any]) -> str:
    """Normalised venue_name, else title: lower case, no punctuation, without 'the' and 'edinburgh'."""
    name = str(record.get("venue_name") or "").strip() or str(record.get("title") or "")
    words = re.sub(r"[^a-z0-9]+", " ", name.lower().replace("&", " and ")).split()
    return " ".join(w for w in words if w not in _VENUE_NOISE)


def same_venue(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Whether two records are at one venue, for the per-venue publish limit.
    Both with a place_id: that decides (equal ids are the same venue, different ids are not).
    Otherwise the normalised names (venue_key) are equal, or one is the other's full name plus
    a known Edinburgh area word ("Civerinos" and "Civerinos Portobello"). Never general containment."""
    pa, pb = str(a.get("place_id") or "").strip(), str(b.get("place_id") or "").strip()
    if pa and pb:
        return pa == pb
    ka, kb = venue_key(a), venue_key(b)
    if not ka or not kb:
        return False
    if ka == kb:
        return True
    short, long_ = sorted((ka, kb), key=len)
    return any(long_ == f"{short} {area}" for area in EDINBURGH_AREAS)


def is_non_deal(record: dict[str, Any]) -> bool:
    return (record.get("kind") or "deal") not in DEAL_KINDS


def apply_daily_limit(routed: list[RoutedDeal], limit: int = DAILY_PUBLISH_LIMIT, *,
                      per_venue: int = VENUE_PUBLISH_LIMIT, per_source: int = SOURCE_PUBLISH_LIMIT,
                      already_today: int = 0, already_non_deal: int = 0, non_deal_limit: int = NON_DEAL_DAILY_LIMIT,
                      already_sources: Counter[str] | None = None) -> list[RoutedDeal]:
    """Keep at most `limit` publishes in one run, `per_venue` for one venue (see same_venue), `per_source` for one
    source_name, and at most `non_deal_limit` non-deals (less `already_non_deal` published earlier today). Order: this
    run's new rows before a waiting backlog row (record["_backlog"]), then best score first, a deal before a non-deal on a
    tie, then the earlier item; the rest move to digest with a reason. Returns a new list in the same order. A record
    with no source_name has no source limit. With auto-publish the caller passes the day's remainder as `limit`, the
    number already published today as `already_today` (reason text only) and `already_non_deal`."""
    publishing = sorted((i for i, r in enumerate(routed) if r.route == "publish"),
                        key=lambda i: (bool(routed[i].record.get("_backlog")), -routed[i].result.score, is_non_deal(routed[i].record), i))
    kept_records: list[dict[str, Any]] = []
    sources: Counter[str] = Counter(already_sources or {})
    non_deals = already_non_deal
    why: dict[int, str] = {}
    for i in publishing:
        record = routed[i].record
        source = str(record.get("source_name") or "")
        if sum(1 for k in kept_records if same_venue(record, k)) >= per_venue:
            why[i] = f"same venue as a higher-scoring publish ({per_venue} per venue): moved to digest"
        elif source and sources[source] >= per_source:
            why[i] = f"source limit of {per_source} reached: moved to digest"
        elif is_non_deal(record) and non_deals >= non_deal_limit:
            why[i] = f"non-deal limit of {non_deal_limit} a day reached (events, activities and the like): moved to digest"
        elif len(kept_records) >= limit:
            why[i] = (f"over the daily limit of {limit + already_today} ({already_today} already published today): moved to digest"
                      if already_today else f"over the daily limit of {limit}: moved to digest")
        else:
            kept_records.append(record)
            sources[source] += 1
            if is_non_deal(record):
                non_deals += 1
    out: list[RoutedDeal] = []
    for i, item in enumerate(routed):
        if i in why:
            item = replace(item, result=QualityResult(item.result.score, [*item.result.reasons, why[i]]), route="digest")
        out.append(item)
    return out


# --- where a record came from ----------------------------------------------------------------

SOCIAL_HOSTS = ("instagram.com", "facebook.com", "fb.com", "tiktok.com", "twitter.com", "x.com")


def _host(url: Any) -> str:
    from urllib.parse import urlparse
    return (urlparse(str(url or "")).hostname or "").lower()


def source_class(record: dict[str, Any]) -> str:
    """'social', 'newsletter' or 'web'. Social when the source URL (or any of source_urls) is on a
    social host; newsletter when the source name says so. Anything unclear that mentions either is
    not 'web', so it can never auto-publish."""
    urls = [record.get("source_url"), *(record.get("source_urls") or [])]
    if any(_host(u) == h or _host(u).endswith("." + h) for u in urls for h in SOCIAL_HOSTS):
        return "social"
    name = str(record.get("source_name") or "").lower()
    if "newsletter" in name:
        return "newsletter"
    if any(word in name for word in ("instagram", "facebook", "tiktok")):
        return "social"
    return "web"


# --- AI relevance rating (not called from the pipeline yet) -------------------------------

RATING_BATCH = 25
RATING_TOOL_NAME = "submit_ratings"
RATING_MAX_TOKENS = 2_000
RATING_SYSTEM_PROMPT = (
    "You rate listings for Fomo, an Edinburgh app for cheap and free things to do and local or student deals. "
    "For each one answer: would a student or young professional in Edinburgh actually care about this? Rate 1 to 5, "
    "using the scale for the row's `kind`. Rate by what a person actually pays, so use the per-person price where one is given "
    "(price_text, saving_label, the summary), not the headline discount percentage.\n"
    "DEALS (kind: deal). 5 = clearly cheap and useful to this audience: an everyday meal, drink, coffee, cinema trip or night out "
    "at a low price you actually pay. "
    "4 = a good saving on something they would use, with a modest price per person. 4 also covers a voucher you pay for in advance "
    "when the price per person is £15 or less, and 20% or more off food, drink or a night out at a local independent place where you "
    "do not need to spend a lot. "
    "3 = a real discount on something pricey: a voucher over £15 a head, a spa or hotel treat, or any pricier thing at a real discount. "
    "2 or less = a narrow group, or conditions the title does not state.\n"
    "EVERYTHING ELSE (events, activities, free access, festivals, tours). 1 = no (a clinic, a hire service, a corporate package, "
    "something far from their life). 3 = maybe, and also the rating for anything that happens every week or month without something more to it. "
    "5 = worth going out of your way for: a one-off, something unusual, or something with a real draw (a big prize, a notable guest, "
    "a genuinely cheap meal or drink). Being free is not enough for a 5. A routine regular night is a 3 unless the page shows something more.\n"
    "For every kind: read the summary, the notes and the page excerpt when they are given, not only the title. "
    "A row meant for a narrow group (children or teenagers, over-60s, members, a named neighbourhood or community, "
    "fans who have a match ticket) rates at most 2, and so does a row with a condition its title or label does not "
    "state (a ticket you must already hold, a donation or booking fee, a minimum spend, a membership). "
    "Rate every row once, using its slug exactly as given."
)
RATING_TOOL: dict[str, Any] = {
    "name": RATING_TOOL_NAME,
    "description": "Submit one 1-5 relevance rating per deal.",
    "input_schema": {
        "type": "object",
        "properties": {"ratings": {"type": "array", "items": {
            "type": "object",
            "properties": {"slug": {"type": "string"}, "rating": {"type": "integer", "minimum": 1, "maximum": 5}},
            "required": ["slug", "rating"],
        }}},
        "required": ["ratings"],
    },
}


@dataclass
class RatingResult:
    ratings: list[dict[str, Any]]
    input_tokens: int = 0
    output_tokens: int = 0
    error: str | None = None


RATING_NOTE_KEYS = ("summary", "eligibility_note", "redemption_note", "time_note")
RATING_NOTE_CHARS = 280
RATING_EXCERPT_CHARS = 700


def build_rating_prompt(batch: list[dict[str, Any]]) -> str:
    """One line per deal: the label fields, the row's own summary and notes (who it is for, what it
    costs, when), and, for a row whose source page was read, a short excerpt of the page around the deal
    (`page_excerpt`, never the whole page)."""
    lines = []
    for r in batch:
        parts = [f"slug: {r.get('slug')}", f"title: {r.get('title')}"]
        for key in ("kind", "venue_name", "saving_label", "price_text", "eligibility"):
            if r.get(key):
                parts.append(f"{key}: {r[key]}")
        for key in RATING_NOTE_KEYS:
            if isinstance(r.get(key), str) and r[key].strip():
                parts.append(f"{key}: {' '.join(r[key].split())[:RATING_NOTE_CHARS]}")
        if isinstance(r.get("page_excerpt"), str) and r["page_excerpt"].strip():
            parts.append(f"page excerpt: {' '.join(r['page_excerpt'].split())[:RATING_EXCERPT_CHARS]}")
        lines.append(" | ".join(parts))
    return "Rate these deals.\n\n" + "\n".join(lines)


def call_rating_tool(client: Any, model: str, prompt: str) -> RatingResult:
    """One forced submit_ratings call, shaped like extract.extract_deals (thinking off, because
    DeepSeek rejects a forced tool_choice with thinking on). Never raises: a failure is returned
    as `error`. `client` must come from llm_client.make_research_client, which refuses DeepSeek in
    its peak hours (deepseek_hours.py)."""
    from llm_client import SUBMIT_CALL_KWARGS  # lazy: importing llm_client loads the .env files

    try:
        with client.messages.stream(
            model=model,
            max_tokens=RATING_MAX_TOKENS,
            system=RATING_SYSTEM_PROMPT,
            tools=[RATING_TOOL],
            tool_choice={"type": "tool", "name": RATING_TOOL_NAME},
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            **SUBMIT_CALL_KWARGS,
        ) as stream:
            response = stream.get_final_message()
    except Exception as exc:
        return RatingResult([], error=f"{exc.__class__.__name__}: {exc}")
    usage = getattr(response, "usage", None)
    out = RatingResult([], input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
                       output_tokens=int(getattr(usage, "output_tokens", 0) or 0))
    tool = next((b for b in getattr(response, "content", []) if getattr(b, "type", "") == "tool_use"), None)
    data = getattr(tool, "input", None) if tool else None
    if isinstance(data, str):
        import json
        try:
            data = json.loads(data)
        except ValueError:
            data = None
    ratings = data.get("ratings") if isinstance(data, dict) else None
    if not isinstance(ratings, list):
        out.error = "no usable submit_ratings call"
        return out
    out.ratings = [r for r in ratings if isinstance(r, dict)]
    return out


def make_rating_call(client: Any, model: str) -> Callable[[str], RatingResult]:
    return lambda prompt: call_rating_tool(client, model, prompt)


def rate_relevance(records: list[dict[str, Any]], client_call: Callable[[str], RatingResult]) -> dict[str, int]:
    """slug -> 1-5, one call per RATING_BATCH records. A failed batch, an unknown slug or a rating
    outside 1-5 gives no entry, and no entry means no cap in score_deal."""
    ratings: dict[str, int] = {}
    for start in range(0, len(records), RATING_BATCH):
        batch = [r for r in records[start:start + RATING_BATCH] if r.get("slug")]
        if not batch:
            continue
        result = client_call(build_rating_prompt(batch))
        if result.error:
            continue
        wanted = {r["slug"] for r in batch}
        for item in result.ratings:
            slug, rating = item.get("slug"), item.get("rating")
            if slug in wanted and isinstance(rating, int) and not isinstance(rating, bool) and 1 <= rating <= 5:
                ratings[slug] = rating
    return ratings
