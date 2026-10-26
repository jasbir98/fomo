/**
 * Row-level normalization shared by every adapter: the Edinburgh geo/locality
 * filter, the keyword category fallback, the off-wedge filter and the
 * within-source dedupe.
 */

export const EDINBURGH_CENTER = { lat: 55.9533, lng: -3.1883 };
export const GEO_RADIUS_KM = 15;
export const LOCALITY_KEYWORDS = [
  "edinburgh",
  "leith",
  "musselburgh",
  "portobello",
  "corstorphine",
  "morningside",
  "stockbridge",
  "newington",
  "tollcross",
  "haymarket",
  "dalry",
  "canonmills",
  "marchmont",
  "bruntsfield",
  "granton",
  "gorgie",
];

export function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Whole words only: a bare substring let "leith" match "Innerleithen" and
// "Leithen Crescent" (Sparky @ Vale Club, 38km away, was imported that way).
const LOCALITY_RES = LOCALITY_KEYWORDS.map((k) => new RegExp(`\\b${k}\\b`, "i"));

/** True when `text` names an Edinburgh locality as a whole word. */
export function namesEdinburghLocality(text) {
  const t = String(text ?? "");
  return LOCALITY_RES.some((re) => re.test(t));
}

/**
 * Is this row's venue in Edinburgh? Coordinates decide whenever a row has
 * them: within GEO_RADIUS_KM of the centre or not, whatever its address or
 * city says. Without coordinates the venue address decides. `city` only
 * counts when there is no address either: sources often fill it from the
 * search they ran ("Edinburgh") rather than from the venue, so it never
 * outvotes a real location.
 */
export function isEdinburghRow(row) {
  if (row.lat != null && row.lng != null) {
    return haversineKm(EDINBURGH_CENTER, { lat: Number(row.lat), lng: Number(row.lng) }) <= GEO_RADIUS_KM;
  }
  if (row.address) return namesEdinburghLocality(`${row.address} ${row.venue_name ?? ""}`);
  return namesEdinburghLocality(`${row.city ?? ""} ${row.venue_name ?? ""}`);
}

// --- category enhancement -----------------------------------------------------
//
// JSON-LD `@type` (via TYPE_TO_CATEGORY in jsonld.mjs), Skiddle's `eventcode` and
// Ticketmaster's `classifications[].segment.name` are each a source's own
// specific category signal and always win when present (an actual
// ComedyEvent/MusicEvent/etc., or an actual Skiddle "COMEDY"/"CLUB" code, is
// more trustworthy than a keyword guess). But most listing-page JSON-LD uses
// the generic `Event`/`SocialEvent` type, which TYPE_TO_CATEGORY can't map,
// so those — and anything else that fell through to "other" — get a second
// pass here: a keyword classifier over name + venue + description, mapped
// only onto lib/events/categories.ts's real EventCategory slugs (music |
// nightlife | festival | arts | comedy | sports | food | family | other) —
// no new slugs invented. Checked in priority order; first match wins.
export const CATEGORY_KEYWORD_RULES = [
  {
    category: "comedy",
    keywords: ["comedy night", "comedy show", "stand-up", "standup", "open mic comedy", "improv comedy", "comedian"],
    venues: ["monkey barrel", "the stand", "gilded balloon"],
  },
  {
    category: "nightlife",
    keywords: [
      "club night", "clubnight", "dj set", "all night rave", "rave", "afterparty", "after party",
      "techno night", "house night", "warehouse party", "nightclub",
    ],
  },
  {
    category: "sports",
    keywords: [
      "5-a-side", "five-a-side", "football match", "rugby match", "parkrun", "running club",
      "fun run", "5k run", "10k run", "sports club", "match day",
    ],
  },
  {
    category: "food",
    keywords: [
      "oktoberfest", "tasting", "brunch", "supper club", "food festival", "beer festival",
      "wine tasting", "gin tasting", "whisky tasting", "pop-up restaurant", "food market", "street food",
    ],
  },
  {
    category: "family",
    keywords: ["kids", "children's", "family fun", "family friendly", "toddler"],
  },
  {
    category: "arts",
    keywords: [
      "ceilidh", "barn dance", "ceilidh dance",
      "theatre", "panto", "pantomime", "play", "musical",
      "film screening", "cinema", "movie night", "screening",
      "exhibition", "art show", "gallery", "private view",
    ],
  },
  {
    category: "music",
    keywords: ["gig", "live music", "live at", "acoustic set", "concert", "open mic", "jam session", "dj night"],
  },
];

/**
 * Keyword fallback for rows whose category is still "other" after the
 * source's own specific-type mapping. Never downgrades a category a source
 * already assigned with confidence.
 */
export function classifyCategory(row) {
  if (row.category && row.category !== "other") return row.category;
  const haystack = `${row.name ?? ""} ${row.venue_name ?? ""} ${row.description ?? ""}`.toLowerCase();
  for (const rule of CATEGORY_KEYWORD_RULES) {
    if (rule.venues?.some((v) => haystack.includes(v))) return rule.category;
    if (rule.keywords.some((k) => haystack.includes(k))) return rule.category;
  }
  return "other";
}

// --- family fit ---------------------------------------------------------------
//
// `family_fit` is separate from the single-valued `category`: a family gig
// keeps category "music" but gets family_fit "kids". This classifier only ever
// returns 'kids' | null — 'all_ages' (free museums, parks) is a place/happening
// concept, not something a dated event listing can claim from keywords.
//
// Order: structured signal -> adult guards -> name cues
// (strong) -> description cues (weaker, narrower phrases). Bare "kid" never
// matches (Junkie Kid, Kid Bookie), "children" only in child-audience phrases
// (not "How to Scare Children" / "Children and Families Impacted by Poverty"),
// and "family" only in audience phrases (not "The Big Family Event" or
// "Family Centre - Preparing for Baby", an antenatal class for adults).

// Adult-only guards. "over 18s" (plural) / "over 18 only", not plain "over 18"
// (kids' listings say "under 18s must be accompanied by an adult over 18").
const FAMILY_ADULT_RE =
  /\b(?:18|21)\s*\+|\bover[- ](?:18|21)s\b|\bover[- ](?:18|21) only\b|\b(?:18|21) and (?:over|above)\b|\badults?[- ]only\b|\bstrictly adults\b|\bunder[- ]?\d{1,2}s? (?:are |will )?(?:not|n['\u2019]t) (?:be )?(?:allowed|admitted|permitted|welcome)|\bno (?:children|kids|under[- ]?\d{1,2}s?)\b|\bclub ?night\b|\bburlesque\b|\bdrag (?:brunch|bingo|night|show)\b|\bnightclub\b/i;

// Real artist / title proper nouns that contain a family-sounding word.
const FAMILY_PROPER_NOUN_RE = /\bkids in glass houses\b|\bkids see ghosts\b|\bnew kids on the block\b|\bkids of 88\b|\bthe kids are alright\b|\bkids at the bar\b/i;

const NUM_WORDS = "two|three|four|five|six|seven|eight|ten|twelve";
const FAMILY_NAME_RES = [
  /\bkids\b|\bkid['’]s\b/i,
  /\bchildren['’]s\b|\bfor (?:young |small )?children\b|\bkids and children\b|\bchildren aged\b|\bchildren (?:and|&) (?:their )?(?:parents|carers|grown-?ups)\b/i,
  /\bfamily[- ](?:[a-z]+ )?(?:show|shows|fun|friendly|day|workshops?|ceilidh|films?|party|session|sessions|concert|gig|performance|matinee|trail|crafts?|disco|yoga|club|theatre|activities|activity|storytelling|storytime|screening|screenings)\b/i,
  /\b(?:for|with) (?:the )?(?:whole|all the) family\b|\ball the family\b/i,
  /\btoddlers?\b/i,
  new RegExp(`\\bunder[- ]?(?:[1-9]|1[0-2]|${NUM_WORDS})['\\u2019]?s\\b|\\bunder[- ]fives?\\b`, "i"),
  /\bbookbug\b/i,
  /\bbaby (?:rhymes?|sensory|massage|class(?:es)?|yoga|sing(?:ing|along)?|signing)\b/i,
  /\bhalf[- ]term\b/i,
];

// Description is noisier prose, so only specific audience phrases count.
const FAMILY_DESC_RES = [
  /\b(?:suitable|perfect|ideal|great) for (?:young )?(?:children|kids|toddlers|families with)\b/i,
  /\b(?:for )?(?:children|kids) aged\b/i,
  /\bchildren['’]s (?:show|workshop|theatre|event|party|storytelling|activities)\b/i,
  /\bkids['’] (?:show|workshop|party|club|activities)\b|\bkid['’]s (?:show|workshop|party|club)\b/i,
  /\bfamily[- ](?:friendly )?(?:show|workshop|fun|day|ceilidh|session|event for)\b|\bfamily[- ]friendly (?:event|show|workshop|fun|session|performance|activity|ceilidh)\b/i,
  /\btoddlers?\b/i,
  // Description only counts "for under 5s"; a bare "under 12s admitted with an adult" is an age policy, not an audience.
  new RegExp(`\\bfor (?:the )?under[- ]?(?:[1-9]|1[0-2]|${NUM_WORDS})['\\u2019]?s\\b|\\bunder[- ]fives?\\b`, "i"),
  /\bbookbug\b/i,
  /\bbaby (?:rhymes?|sensory|massage)\b/i,
  /\bhalf[- ]term (?:activities|workshops?|fun|holiday)\b/i,
];

// "ages 3-8", "ages 5+", "6-10 years": youth cues only when the age is a child's.
function hasChildAgeRange(text) {
  // "ages 5+", "aged 3-8", "ages 3 to 7": a child range tops out at 14 ("aged 8-18", "aged 11-25" are youth schemes).
  for (const m of text.matchAll(/\bages?(?:d)?\s*(\d{1,2})\s*(?:[-\u2013]\s*(\d{1,2})|to\s*(\d{1,2})|(\+))/gi)) {
    const lo = Number(m[1]);
    const hi = m[2] ?? m[3];
    if (hi != null ? Number(hi) <= 14 : lo <= 12) return true;
  }
  for (const m of text.matchAll(/\b(\d{1,2})\s*[-\u2013]\s*(\d{1,2})\s*(?:yrs|years|year olds|yr olds)\b/gi)) {
    if (Number(m[2]) <= 14) return true;
  }
  return false;
}

// Venues where a keyword in the description alone is not enough.
const ADULT_VENUE_RE = /\bliquid room\b|\bsneaky pete|\bcabaret voltaire\b|\bthe caves\b|\bnightclub\b|\bbehind the wall\b|\bvoodoo rooms\b/i;

/**
 * 'kids' when an event is aimed at children, else null.
 * `signal === 'kids'` is a structured source signal (Skiddle KIDS, JSON-LD
 * ChildrensEvent, ...) and wins over everything.
 */
export function classifyFamilyFit({ name, description, category, venueName, signal } = {}) {
  if (signal === "kids") return "kids";
  const title = String(name ?? "");
  const desc = String(description ?? "");
  if (category === "nightlife") return null;
  if (FAMILY_ADULT_RE.test(title) || FAMILY_ADULT_RE.test(desc)) return null;
  if (FAMILY_PROPER_NOUN_RE.test(title)) return null;
  // category "family" alone is not enough: every structured family source
  // (Skiddle KIDS, ChildrensEvent, Festivals, Forever Edinburgh) already passes
  // a signal, so a bare "family" here came from classifyCategory's keyword
  // fallback, which also fires on band names ("Hush Kids"). Name/description
  // cues below decide.
  if (FAMILY_NAME_RES.some((re) => re.test(title)) || hasChildAgeRange(title)) return "kids";
  if (ADULT_VENUE_RE.test(String(venueName ?? ""))) return null;
  if (FAMILY_DESC_RES.some((re) => re.test(desc)) || hasChildAgeRange(desc)) return "kids";
  return null;
}

/**
 * Central pass: stamp `family_fit` on every event row (all adapters). A row an
 * adapter already marked 'kids' from a structured source signal keeps it.
 * Idempotent. Mutates and returns the rows' copies.
 */
export function applyFamilyFit(rows) {
  return rows.map((r) => ({
    ...r,
    family_fit: classifyFamilyFit({
      name: r.name,
      description: r.description,
      category: r.category,
      venueName: r.venue_name,
      signal: r.family_fit === "kids" ? "kids" : null,
    }),
  }));
}

// --- off-wedge filter ----------------------------------------------------------
//
// The wedge is Edinburgh students/young professionals looking for something
// to do tonight/this weekend — not multi-day excursions that leave the city.
// Conservative on purpose: only drops rows with an explicit "this leaves
// Edinburgh" signal, or a genuinely long+pricey span (a >2-day event priced
// over £60 reads as a package/festival-pass/excursion, not a single outing).
export const OFF_WEDGE_KEYWORDS = [
  "weekend trip", "day trip to", "day trip:", "multi-day tour", "multi day tour",
  "highlands tour", "tour of the highlands", "highland tour", "isle of skye", "isle of mull",
  "isle of arran", "isle of harris", "outer hebrides", "loch ness tour", "excursion to",
  "orkney tour", "shetland tour", "glencoe tour", "nc500", "north coast 500",
];

export function isOffWedge(row) {
  const haystack = `${row.name ?? ""} ${row.description ?? ""}`.toLowerCase();
  if (OFF_WEDGE_KEYWORDS.some((k) => haystack.includes(k))) return true;
  if (row.ends_at) {
    const spanDays = (new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) / (1000 * 60 * 60 * 24);
    if (spanDays > 2 && (row.price_from ?? 0) > 60) return true;
  }
  return false;
}

/** Dedupe rows within one source's own run, keyed on provider_event_id (the same field the DB unique index uses). */
export function dedupeWithinSource(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.provider_event_id)) byId.set(row.provider_event_id, row);
  }
  return Array.from(byId.values());
}

// Category distribution before/after the keyword-classifier fallback, across
// every adapter (JSON-LD, Skiddle, Ticketmaster) — printed in the final
// summary so the effect of classifyCategory() is visible on every run.
export const CATEGORY_STATS = { before: {}, after: {} };
