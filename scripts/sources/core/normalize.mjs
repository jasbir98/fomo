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

export function isEdinburghRow(row) {
  if (row.lat != null && row.lng != null) {
    if (haversineKm(EDINBURGH_CENTER, { lat: row.lat, lng: row.lng }) <= GEO_RADIUS_KM) return true;
  }
  const haystack = `${row.city ?? ""} ${row.address ?? ""}`.toLowerCase();
  return LOCALITY_KEYWORDS.some((k) => haystack.includes(k));
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
