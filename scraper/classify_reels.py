#!/usr/bin/env python3
"""
classify_reels.py — reads unclassified rows from `scraped_reels` and asks
Claude, using only the caption/platform/location text (no video access), to
decide whether each reel is genuinely about the tourist place it was
searched under. Approved reels are promoted into `social_posts` (the table
the app's Trending-on-Social feed reads from, via lib/db/social.ts
listReels()); rejected ones stay in `scraped_reels` for audit, never
deleted.

Mirrors the Claude-extraction pattern in japan_place_extract.py: Anthropic
SDK, ANTHROPIC_API_KEY from scraper/.env, forced tool-use JSON schema
instead of free-text parsing.

Usage:
    python scraper/classify_reels.py --limit 50 --batch-size 15
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

SCRAPER_DIR = Path(__file__).resolve().parent
load_dotenv(SCRAPER_DIR / ".env")
sys.path.insert(0, str(SCRAPER_DIR))

from upsert_supabase import _get_credentials, upsert_reels  # noqa: E402
import llm_client  # noqa: E402

DEFAULT_MODEL = llm_client.default_research_model()
MAX_CAPTION_CHARS = 600

# Edinburgh bbox from lib/city.ts — used to restrict place matching
# when destination contains "edinburgh"
EDINBURGH_BBOX = {"minLat": 55.85, "maxLat": 56.01, "minLng": -3.46, "maxLng": -3.05}

SYSTEM_PROMPT = """You review scraped TikTok/Instagram reels for Fomo, a local Edinburgh app.

Each reel was found by searching TikTok/Instagram for a specific named place
in Edinburgh. You do not have access to the video itself — only the caption,
author handle, platform, and the place name it was searched under.

Each item also gives the destination (city/region) the place was searched in,
and may include hashtags from the reel's caption. Use these to catch
same-named-but-different places -- e.g. many place names re-occur in
different cities, and a caption can make the true location explicit.

For Edinburgh reels (destination contains "edinburgh"), approve only reels
that are actually about that place IN Edinburgh and useful to someone in
the city: food, drink, events, deals, things to do, views, venues, local
tips, café menus, pub quizzes, student deals, happy hours, new openings,
and similar local content.

Decide is_tourist_reel=true only if the caption text plausibly indicates the
reel is genuinely about that place/topic IN that destination.

Say is_tourist_reel=false for:
- captions with no discernible relation to the named place
- generic meme/trend/audio reposts unrelated to the destination
- spam, ads, or unrelated business promotion
- a same-named but clearly different place (wrong city/country/context)
- captions too generic, untranslated-and-unclear, or empty to tell either way

Prefer false when genuinely uncertain — this filters a public feed, and a
missed reel is cheaper than a wrong one. Give a short one-sentence reason
for every item either way.
"""

CLASSIFY_TOOL = {
    "name": "submit_classifications",
    "description": "Submit tourist-reel classifications for this batch of scraped reels.",
    "input_schema": {
        "type": "object",
        "properties": {
            "classifications": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "video_url": {"type": "string"},
                        "is_tourist_reel": {"type": "boolean"},
                        "reason": {"type": "string"},
                    },
                    "required": ["video_url", "is_tourist_reel", "reason"],
                },
            }
        },
        "required": ["classifications"],
    },
}


def _rest_get(supabase_url: str, supabase_key: str, path: str, params: dict[str, Any]) -> list[dict]:
    headers = {"apikey": supabase_key, "Authorization": f"Bearer {supabase_key}"}
    resp = requests.get(f"{supabase_url}/rest/v1/{path}", headers=headers, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


def _rest_patch(supabase_url: str, supabase_key: str, path: str, params: dict[str, Any], body: dict[str, Any]) -> None:
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    resp = requests.patch(f"{supabase_url}/rest/v1/{path}", headers=headers, params=params, json=body, timeout=30)
    if resp.status_code >= 300:
        print(f"[classify] PATCH failed ({resp.status_code}): {resp.text}", file=sys.stderr)
        resp.raise_for_status()


def fetch_unclassified(supabase_url: str, supabase_key: str, limit: int) -> list[dict]:
    return _rest_get(
        supabase_url,
        supabase_key,
        "scraped_reels",
        {
            "classified": "eq.false",
            "select": "id,video_url,platform,caption,author_handle,location,destination,thumbnail_url,likes",
            "order": "scraped_at.asc",
            "limit": str(limit),
        },
    )


def fetch_approved(supabase_url: str, supabase_key: str) -> list[dict]:
    """All `scraped_reels` rows already approved (classified=true, is_tourist_reel=true).

    Paginated — PostgREST caps a single response — so this scales as the
    approved set grows. Fetching and re-upserting the *full* approved set on
    every run (not just rows classified this run) is what makes promotion
    self-healing: `upsert_reels()` is an idempotent upsert on `video_url`, so
    a row that's already in `social_posts` is just a cheap no-op re-write,
    and a row that got classified but never made it into `social_posts`
    (e.g. a prior run crashed after the PATCH but before the promotion
    upsert) gets picked up here automatically on the next run.
    """
    page_size = 1000
    offset = 0
    rows: list[dict] = []
    while True:
        page = _rest_get(
            supabase_url,
            supabase_key,
            "scraped_reels",
            {
                "classified": "eq.true",
                "is_tourist_reel": "eq.true",
                "select": "video_url,platform,thumbnail_url,caption,author_handle,likes,location,destination",
                "limit": str(page_size),
                "offset": str(offset),
            },
        )
        rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return rows


def _in_edinburgh_bbox(place: dict) -> bool:
    lat, lng = place.get("lat"), place.get("lng")
    return (
        lat is not None
        and lng is not None
        and EDINBURGH_BBOX["minLat"] <= lat <= EDINBURGH_BBOX["maxLat"]
        and EDINBURGH_BBOX["minLng"] <= lng <= EDINBURGH_BBOX["maxLng"]
    )


def fetch_places(supabase_url: str, supabase_key: str) -> list[dict]:
    """All `places` rows (id/name/source/rating/lat/lng), for resolving place_id on promotion.

    Paginated: ~3,400 rows and PostgREST caps a response at 1,000. Ordered by
    id so offset pages are stable. Callers narrow to Edinburgh with
    _in_edinburgh_bbox — filtering here would make a short page look like the
    last one.
    """
    page_size = 1000
    offset = 0
    rows: list[dict] = []
    try:
        while True:
            page = _rest_get(
                supabase_url,
                supabase_key,
                "places",
                {
                    "select": "id,name,source,rating,lat,lng",
                    "order": "id",
                    "limit": str(page_size),
                    "offset": str(offset),
                },
            )
            rows.extend(page)
            if len(page) < page_size:
                break
            offset += page_size
        return rows
    except requests.RequestException as exc:
        print(f"[classify] warning: couldn't fetch places for place_id lookup: {exc}", file=sys.stderr)
        return []


# ---------------------------------------------------------------------------
# Place matching
#
# Previously this promotion step did a single case-insensitive exact-match
# lookup of `scraped_reels.location` against `places.name`. That's broken in
# two ways:
#
#   1. `location` is just the search-seed string the scraper queried
#      TikTok/Instagram with (see scrape_places_batch.py) -- it has nothing
#      to do with what the reel's caption is actually about. If that seed
#      string happens to collide with an unrelated place's name (e.g. a
#      garbled batch entry "CENSU TOKYO" that happens to equal a real
#      Shibuya restaurant called "CENSU TOKYO"), the reel gets confidently
#      pinned to the wrong place even though its caption is about something
#      else entirely (Senso-ji Temple, in that example).
#   2. When `location` is a broad destination tag rather than a specific
#      place name (e.g. "Tokyo"), the exact-match lookup fails and place_id
#      is left null -- even when the caption's own hashtags
#      (#asakusa #sensoji) clearly identify the place.
#
# The fix: consider both the caption's own hashtags (an explicit, high-intent
# signal from the poster) and the location seed string, normalize names so
# punctuation/hyphenation/macron romanization differences don't matter
# ("Senso-ji" / "Sensō-ji" / "#sensoji" all compare equal), require a
# minimum-confidence match instead of always picking *some* candidate, and
# when both a hashtag and the location field resolve to *different* places,
# trust whichever match is more specific (matches more of the place's name)
# rather than always preferring one source outright -- a specific location
# seed like "Nonbei Yokocho" should win over an incidental "#shibuya"
# hashtag (which trivially/exactly names the whole *district*, a real but
# much less specific places-table row), while a bogus/garbled location seed
# that happens to collide with an unrelated place's name (CENSU TOKYO) loses
# to a more specific caption hashtag (#sensojitemple).
# ---------------------------------------------------------------------------

# Hashtags/location strings too generic to trust as a place signal on their
# own -- destination/marketing boilerplate, not a specific spot. Checked
# before matching so e.g. "#tokyo" never resolves to the generic "Tokyo"
# places row and swallows a reel that's actually about one specific spot.
GENERIC_TERMS = {
    "japan", "japantravel", "japantrip", "traveltojapan", "tokyo",
    "tokyojapan", "kyoto", "osaka", "yokohama", "asia", "travel",
    "traveltok", "traveltiktok", "trip", "tripideas", "explore",
    "explorejapan", "guide", "traveltips", "traveltip", "vlog",
    "travelvlog", "foodie", "food", "photography", "photo", "reels",
    "instagram", "tiktok", "fyp", "viral", "asian", "wanderlust",
    "vacation", "holiday", "asianfood", "japanfood", "japanesefood",
    "aesthetic", "views", "view", "shorts", "reel",
    # Scotland/UK boilerplate -- same collision risk as the Japan terms
    # above (a broad destination hashtag shouldn't pin a reel to some
    # unrelated specific place that happens to share a word with it).
    "scotland", "scotlandtravel", "scotlandtrip", "traveltoscotland",
    "visitscotland", "tourismscotland", "scotlandisnow", "instascotland",
    "escocia", "ecosse", "scottish", "scotch", "aberdeen", "aberdeenshire",
    "edinburgh", "glasgow", "dundee", "stirling", "perth", "highlands",
    "uk", "unitedkingdom", "britain", "greatbritain", "gb", "england",
    "europe", "europetravel",
    # Generic descriptor words that show up as one word inside many place
    # names (e.g. "... Garden", "... Shrine", a restaurant name with dietary
    # tags baked in) -- belt-and-suspenders alongside the >=2-word-run rule
    # in _match_score so a hashtag like "#garden" or "#halal" can't pin a
    # reel to an unrelated place just because that word appears somewhere in
    # its (possibly very verbose) name.
    "temple", "shrine", "museum", "garden", "gardens", "park", "tower",
    "bridge", "market", "street", "hall", "center", "centre", "gate",
    "crossing", "building", "monument", "castle", "palace", "zoo",
    "aquarium", "restaurant", "cafe", "hotel", "shop", "store", "mall",
}

# Below this normalized length, a term is too short/generic to trust as a
# unique place signal (e.g. avoids matching on stray 3-4 letter fragments).
MIN_TERM_LEN = 5

# Confidence floor for a *partial* (character-substring) match. Exact and
# word-run matches (see _name_word_runs) always score 1.0 regardless of this
# floor; this only gates the fuzzier fallback for names/terms that don't
# tokenize into clean shared words (typos, truncation). Set high because a
# short place name (e.g. "Tokyo") is otherwise a near-free substring hit
# inside almost any longer, unrelated hashtag ("#tokyoeats").
MIN_MATCH_SCORE = 0.7


def _squash(text: str | None) -> str:
    """Lowercase, strip macrons/diacritics and all non-alphanumerics, so
    'Senso-ji Temple', 'Sensō-ji', and '#SensoJi' all compare equal."""
    normalized = unicodedata.normalize("NFKD", (text or "").lower())
    without_marks = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]", "", without_marks)


def _name_words(name: str | None) -> list[str]:
    return [w for w in re.split(r"[^A-Za-z0-9]+", (name or "").lower()) if w]


def _name_word_runs(name: str | None) -> dict[str, int]:
    """Every contiguous run of the name's words, squashed together, mapped to
    how many words that run spans.

    'Senso-ji Temple' (words: senso, ji, temple) ->
    {'senso':1,'ji':1,'temple':1,'sensoji':2,'jitemple':2,'sensojitemple':3}.
    Matching a hashtag against this (rather than just the whole squashed
    name) is what lets '#sensoji' hit 'Senso-ji Temple' exactly, and
    '#goldengai' hit 'Shinjuku Golden Gai' exactly -- without a
    hand-maintained list of which leading/trailing descriptor words
    ("Temple", "Museum", ...) to strip.

    Only runs spanning >=2 words are trusted as a confident match (see
    _match_score) -- a run of exactly 1 word is just "some word that also
    appears in this place's name," which is true of any place whose name
    happens to include a common word ("Restaurant", "Garden", "Shrine",
    dietary tags like "Halal"/"Vegan" baked into a verbose name) and is not
    a reliable signal on its own.
    """
    words = _name_words(name)
    runs: dict[str, int] = {}
    for i in range(len(words)):
        running = ""
        for j in range(i, len(words)):
            running += words[j]
            span = j - i + 1
            runs[running] = max(runs.get(running, 0), span)
    return runs


def _extract_hashtags(caption: str | None) -> list[str]:
    return re.findall(r"#([A-Za-z0-9_]+)", caption or "")


def _match(term: str, name: str) -> tuple[float, int] | None:
    """Does `term` plausibly name the place called `name`? Returns
    (confidence 0..1, specificity) or None if it doesn't clear the bar.

    specificity is (approximately) how many of the place name's words the
    match accounts for -- used to pick between a hashtag match and a
    location-field match that disagree (see resolve_place_id): a term that
    pins down more of a name is a stronger, less coincidental signal.

    1.0 confidence = the term equals the whole (squashed) name, or equals a
    contiguous >=2-word run of it (e.g. "sensoji" against "Senso-ji
    Temple"'s "senso"+"ji" run -- the distinctive part, with one generic
    trailing word left out, and no hand-maintained strip-list needed).
    Below that, raw character-substring containment must cover most of
    whichever side is shorter (MIN_MATCH_SCORE) -- a single-word run isn't
    trusted at 1.0 on its own, since plenty of unrelated places share any
    one common word (a verbose name with "Restaurant"/"Garden"/dietary tags
    baked in, a shared district word, etc).
    """
    term_sq = _squash(term)
    name_sq = _squash(name)
    if len(term_sq) < MIN_TERM_LEN or term_sq in GENERIC_TERMS or len(name_sq) < MIN_TERM_LEN:
        return None

    words = _name_words(name)
    if term_sq == name_sq:
        return 1.0, len(words)

    span = _name_word_runs(name).get(term_sq, 0)
    if span >= 2:
        return 1.0, span

    if term_sq in name_sq:
        ratio = len(term_sq) / len(name_sq)
    elif name_sq in term_sq:
        ratio = len(name_sq) / len(term_sq)
    else:
        return None
    return (ratio, 0) if ratio >= MIN_MATCH_SCORE else None


def _better_tiebreak(candidate: dict, current: dict | None) -> bool:
    """True if `candidate` should replace `current` when both score/specificity
    equally.

    Prefers the curated seed record over machine-enriched duplicates (this
    places table has a few, e.g. two "Sensō-ji" rows pulled in by a Google
    enrichment pass alongside the original pilot seed "Senso-ji Temple" row
    for the same temple), then higher rating, as a proxy for "the real /
    more prominent entry" when several rows share a name.
    """
    if current is None:
        return True
    cand_seed = candidate.get("source") == "seed"
    cur_seed = current.get("source") == "seed"
    if cand_seed != cur_seed:
        return cand_seed
    cand_rating = candidate.get("rating") or 0
    cur_rating = current.get("rating") or 0
    return cand_rating > cur_rating


def _is_better(score: float, specificity: int, place: dict, best_score: float, best_specificity: int, best_place: dict | None) -> bool:
    if score != best_score:
        return score > best_score
    if specificity != best_specificity:
        return specificity > best_specificity
    return _better_tiebreak(place, best_place)


def _best_place_for_term(term: str, places_rows: list[dict]) -> tuple[dict | None, float, int]:
    """Highest-confidence (then most specific) place match for a single
    hashtag/location term, or (None, 0.0, 0) if nothing clears the bar."""
    best_place: dict | None = None
    best_score = 0.0
    best_specificity = 0
    for place in places_rows:
        m = _match(term, place.get("name") or "")
        if m is None:
            continue
        score, specificity = m
        if _is_better(score, specificity, place, best_score, best_specificity, best_place):
            best_place, best_score, best_specificity = place, score, specificity
    return best_place, best_score, best_specificity


def resolve_place_id(caption: str | None, location: str | None, places_rows: list[dict]) -> tuple[str | None, str]:
    """Best-effort place match for a scraped reel.

    Tries both signals available -- the caption's own hashtags (explicit,
    high-intent, but only as good as what the poster bothered to tag) and
    the `location` search-seed field (deliberately chosen per-place by the
    batch scraper, but decoupled from the reel's actual content, so it's
    only as good as that seed data) -- and:

    - if the location match is *also* named by one of the caption's own
      hashtags, that's the strongest possible signal (deliberate search
      seed + the poster's own explicit tag agree) and wins outright -- this
      matters when a caption hashtags several nearby/related spots (e.g.
      both #ShibuyaSky and #ShibuyaHikarie on a reel that's actually about
      Shibuya Hikarie, or #owakudani alongside a trailing #hakoneropeway
      tag) and a naive "best single hashtag in the caption" pick would grab
      whichever one happens to have a longer name, regardless of which one
      the reel (and its search seed) is actually about;
    - otherwise, if only one of {hashtags, location} resolves, uses it;
    - if both resolve but to *different* places, trusts whichever match is
      more *specific* (accounts for more of the matched place's name) --
      this is what lets a specific location seed ("Nonbei Yokocho") beat an
      incidental single-word district hashtag ("#shibuya", which
      exactly-but-trivially names the much less specific "Shibuya" row),
      while still letting a solid caption hashtag (#sensojitemple) beat a
      bogus/garbled location seed that happens to collide with an unrelated
      place's name (CENSU TOKYO);
    - if neither resolves confidently, leaves place_id null rather than
      guessing.
    """
    caption = caption or ""
    hashtags = _extract_hashtags(caption)

    location_place, _location_score, location_specificity = _best_place_for_term(location or "", places_rows)

    hashtag_place: dict | None = None
    hashtag_score = 0.0
    hashtag_specificity = 0
    location_confirmed_by_hashtag = False
    for tag in hashtags:
        place, score, specificity = _best_place_for_term(tag, places_rows)
        if place is None:
            continue
        if location_place is not None and place["id"] == location_place["id"]:
            location_confirmed_by_hashtag = True
        if _is_better(score, specificity, place, hashtag_score, hashtag_specificity, hashtag_place):
            hashtag_place, hashtag_score, hashtag_specificity = place, score, specificity

    if location_place is not None and location_confirmed_by_hashtag:
        return location_place["id"], location_place.get("name", "")

    if hashtag_place and location_place:
        if hashtag_place["id"] == location_place["id"]:
            return hashtag_place["id"], hashtag_place.get("name", "")
        if location_specificity > hashtag_specificity:
            return location_place["id"], location_place.get("name", "")
        # Equally specific, or the hashtag is more specific -- trust the
        # poster's own explicit tag.
        return hashtag_place["id"], hashtag_place.get("name", "")

    chosen = hashtag_place or location_place
    if chosen:
        return chosen["id"], chosen.get("name", "")
    return None, ""


def classify_batch(client: Any, model: str, batch: list[dict]) -> dict[str, dict]:
    items = []
    for reel in batch:
        caption = (reel.get("caption") or "")[:MAX_CAPTION_CHARS]
        items.append(
            {
                "video_url": reel["video_url"],
                "platform": reel.get("platform"),
                "searched_place": reel.get("location"),
                "searched_destination": reel.get("destination"),
                "author_handle": reel.get("author_handle"),
                "caption": caption,
            }
        )

    # Use llm_client's SUBMIT_CALL_KWARGS to disable thinking on DeepSeek
    response = client.messages.create(
        model=model,
        max_tokens=4000,
        system=SYSTEM_PROMPT,
        tools=[CLASSIFY_TOOL],
        tool_choice={"type": "tool", "name": "submit_classifications"},
        messages=[{"role": "user", "content": json.dumps(items, ensure_ascii=False)}],
        **llm_client.SUBMIT_CALL_KWARGS,
    )

    tool_use = next((b for b in response.content if b.type == "tool_use"), None)
    if tool_use is None:
        raise RuntimeError("empty response from classification model")
    result = tool_use.input
    if not isinstance(result, dict) or not isinstance(result.get("classifications"), list):
        raise RuntimeError("expected classification response to contain a classifications array")

    return {c["video_url"]: c for c in result["classifications"] if isinstance(c, dict) and c.get("video_url")}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Classify scraped_reels rows as local-content reels or not, "
        "promoting approved ones to social_posts."
    )
    parser.add_argument("--limit", type=int, default=50, help="Max unclassified rows to process this run.")
    parser.add_argument("--batch-size", type=int, default=15, help="Reels per Claude call.")
    parser.add_argument("--model", default=os.environ.get("REEL_CLASSIFY_MODEL", DEFAULT_MODEL))
    parser.add_argument("--dry-run", action="store_true", help="Classify and print verdicts without upserting to Supabase.")
    args = parser.parse_args()

    supabase_url, supabase_key = _get_credentials()

    reels = fetch_unclassified(supabase_url, supabase_key, args.limit)
    classified_count = 0

    if not reels:
        print("[classify] nothing unclassified this run.")
    else:
        client, provider = llm_client.make_research_client("classify")
        print(f"[classify] {len(reels)} unclassified reel(s), batch size {args.batch_size}")
        print(f"[classify] model {args.model} ({provider})")

        for start in range(0, len(reels), args.batch_size):
            batch = reels[start : start + args.batch_size]
            try:
                results = classify_batch(client, args.model, batch)
            except Exception as exc:
                print(f"[classify] error classifying batch starting at {start}: {exc}", file=sys.stderr)
                continue

            for reel in batch:
                result = results.get(reel["video_url"])
                if result is None:
                    print(f"  [warn] model returned no classification for {reel['video_url']}", file=sys.stderr)
                    continue

                is_tourist_reel = bool(result.get("is_tourist_reel"))
                reason = str(result.get("reason") or "")[:500]

                if not args.dry_run:
                    _rest_patch(
                        supabase_url,
                        supabase_key,
                        "scraped_reels",
                        {"video_url": f"eq.{reel['video_url']}"},
                        {
                            "classified": True,
                            "is_tourist_reel": is_tourist_reel,
                            "classification_reason": reason,
                            "classified_at": datetime.now(timezone.utc).isoformat(),
                        },
                    )
                classified_count += 1

                verdict = "approved" if is_tourist_reel else "rejected"
                place = reel.get("location") or "?"
                print(f"  [{verdict}] '{place}' -- {reason}")

    # Promotion runs over the *entire* approved set every time (unconditionally,
    # even when there was nothing new to classify above) — not just
    # rows classified in the loop above) and is never allowed to crash the
    # run — see fetch_approved()'s docstring for why this makes a stranded
    # promotion (classified in scraped_reels but never upserted to
    # social_posts, e.g. from a prior crash) self-healing on the next run.
    promoted_count = 0
    if not args.dry_run:
        approved = fetch_approved(supabase_url, supabase_key)
        if approved:
            # Fetch every place once, then narrow per reel: the approved set
            # mixes Edinburgh and older Scotland/Japan reels, so one shared
            # candidate list would re-resolve (and null out) the others'
            # place_id on every run.
            all_places = fetch_places(supabase_url, supabase_key)
            edinburgh_places = [p for p in all_places if _in_edinburgh_bbox(p)]
            promoted_rows = []
            for reel in approved:
                is_edinburgh = "edinburgh" in (reel.get("destination") or "").lower()
                places_rows = edinburgh_places if is_edinburgh else all_places
                place_id, _ = resolve_place_id(reel.get("caption"), reel.get("location"), places_rows)
                promoted_rows.append(
                    {
                        "platform": reel.get("platform"),
                        "video_url": reel["video_url"],
                        "thumbnail_url": reel.get("thumbnail_url"),
                        "caption": reel.get("caption"),
                        "author_handle": reel.get("author_handle"),
                        "likes": reel.get("likes"),
                        "location": reel.get("location"),
                        "destination": reel.get("destination"),
                        "place_id": place_id,
                    }
                )
            try:
                promoted_count = upsert_reels(promoted_rows, table="social_posts")
            except Exception as exc:
                print(
                    f"[classify] promotion to social_posts failed, but classifications are saved — "
                    f"will retry automatically on the next run: {exc}",
                    file=sys.stderr,
                )

    print(f"[classify] classified {classified_count} reel(s) this run; {promoted_count} approved reel(s) promoted to social_posts.")


if __name__ == "__main__":
    main()
