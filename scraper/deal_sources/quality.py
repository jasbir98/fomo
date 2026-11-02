"""Value-based quality score and routing for deals (pure apart from loading the benchmarks JSON).

is_genuine_deal (gate.py) asks whether a deal is worded like a discount. This asks whether it is
worth showing: a score from 0 to 100, then a route:

  publish  strong, clean, from a web page: could go live without a person looking
  digest   worth a person's glance (the weekly review / digest)
  drop     not worth anyone's time

AUTO-PUBLISH IS OFF. Nothing in the pipeline acts on a route yet; the weekly run only reports
them, so the thresholds below can be tuned against the backtest first.

Ports kept in step with the app by hand:
  * dealDepth, dayRarity, NATIONAL_CHAINS and isNationalChain: lib/happenings/deal-score.ts
  * normalizeRecurrence (the weekly branch): lib/happenings/occurrence.ts
  * the cheap-price rule and lib/happenings/price-benchmarks.json: gate.py (is_cheap_price)

Nothing here touches the network. rate_relevance makes one DeepSeek call per batch through an
injected callable and is not called from the pipeline yet.
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
FREE_VALUE = 30  # non-deal kinds: free
LOW_PRICE_VALUE = 20  # non-deal kinds: a stated price at or under LOW_PRICE_GBP
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
_OUTSIDE_TOWN_RE = re.compile(r"\b(" + "|".join(OUTSIDE_TOWNS) + r")\b", re.I)
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


def venue_key(record: dict[str, Any]) -> str:
    """Normalised venue_name, else title: lower case, no punctuation, without 'the' and 'edinburgh'."""
    name = str(record.get("venue_name") or "").strip() or str(record.get("title") or "")
    words = re.sub(r"[^a-z0-9]+", " ", name.lower().replace("&", " and ")).split()
    return " ".join(w for w in words if w not in _VENUE_NOISE)


def apply_daily_limit(routed: list[RoutedDeal], limit: int = DAILY_PUBLISH_LIMIT, *,
                      per_venue: int = VENUE_PUBLISH_LIMIT, per_source: int = SOURCE_PUBLISH_LIMIT) -> list[RoutedDeal]:
    """Keep at most `limit` publishes in one run, `per_venue` for one venue and `per_source` for one
    source_name. Best score first (ties keep the earlier item); the rest move to digest with a reason.
    Returns a new list in the same order. A record with no source_name has no source limit."""
    publishing = sorted((i for i, r in enumerate(routed) if r.route == "publish"), key=lambda i: (-routed[i].result.score, i))
    venues: Counter[str] = Counter()
    sources: Counter[str] = Counter()
    kept = 0
    why: dict[int, str] = {}
    for i in publishing:
        record = routed[i].record
        venue, source = venue_key(record), str(record.get("source_name") or "")
        if venue and venues[venue] >= per_venue:
            why[i] = f"same venue as a higher-scoring publish ({per_venue} per venue): moved to digest"
        elif source and sources[source] >= per_source:
            why[i] = f"source limit of {per_source} reached: moved to digest"
        elif kept >= limit:
            why[i] = f"over the daily limit of {limit}: moved to digest"
        else:
            kept += 1
            venues[venue] += 1
            sources[source] += 1
    out: list[RoutedDeal] = []
    for i, item in enumerate(routed):
        if i in why:
            item = replace(item, result=QualityResult(item.result.score, [*item.result.reasons, why[i]]), route="digest")
        out.append(item)
    return out


# --- AI relevance rating (not called from the pipeline yet) -------------------------------

RATING_BATCH = 25
RATING_TOOL_NAME = "submit_ratings"
RATING_MAX_TOKENS = 2_000
RATING_SYSTEM_PROMPT = (
    "You rate deals for Fomo, an Edinburgh app for cheap and free things to do and local or student deals. "
    "For each deal answer one question: would a student or young professional in Edinburgh actually care about this? "
    "Rate 1 to 5: 1 = no (a clinic, a hire service, a corporate package, something far from their life), "
    "3 = maybe, 5 = clearly yes (cheap food and drink, nights out, student offers, free things to do). "
    "Rate every deal once, using its slug exactly as given."
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


def build_rating_prompt(batch: list[dict[str, Any]]) -> str:
    lines = []
    for r in batch:
        parts = [f"slug: {r.get('slug')}", f"title: {r.get('title')}"]
        for key in ("venue_name", "saving_label", "price_text", "eligibility"):
            if r.get(key):
                parts.append(f"{key}: {r[key]}")
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
