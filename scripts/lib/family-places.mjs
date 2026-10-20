/**
 * family-places.mjs — pure helpers for scripts/family-places.mjs, which adds
 * kid-friendly Edinburgh places to the catalogue from Google Places Text
 * Search (New). No I/O, no network, no `@/` alias, so it runs under plain
 * `node --test` (same constraint as google-place-map.mjs / place-match.mjs,
 * which it reuses for matching and hours).
 *
 * The script never invents venues: every row here is a real Google result.
 * This module decides (1) whether a result is worth keeping, (2) what
 * category + family_fit it gets, (3) whether we already have it, and (4) what
 * a `places_staging` row looks like.
 *
 * family_fit: 'kids' (aimed at children) | 'all_ages' (good with kids, for
 * anyone) — same meaning as supabase/add_family_fit.sql.
 */

import { acceptMatch, compactHours, haversineMeters, priceLevelToInt, priceRangeText } from "./google-place-map.mjs";
import { nameTokens } from "./place-match.mjs";

/** Edinburgh search rectangle (Text Search `locationRestriction`) and the keep-inside check. */
export const BBOX = { south: 55.87, north: 55.99, west: -3.35, east: -3.05 };

export const MAX_REQUESTS = 20;
export const PAGE_SIZE = 20;

/**
 * Text Search (New) with Atmosphere fields (goodForChildren) is billed at the
 * "Enterprise + Atmosphere" rate, USD 40 per 1000 requests (Enterprise alone is
 * 35, Pro 32). One page of up to 20 results = one request. Estimate only.
 */
export const COST_PER_REQUEST_USD = 0.04;

export const QUERIES = [
  "children's playground",
  "playpark",
  "soft play",
  "city farm",
  "children's farm",
  "children's library",
  "swimming pool",
  "leisure centre swimming",
  "museum for kids",
  "trampoline park",
  "climbing centre kids",
  "family friendly cafe with play area",
  "adventure playground",
  "splash park",
];

/** Enterprise + Atmosphere field mask: everything this script reads, nothing more. */
export const SEARCH_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.types",
  "places.primaryType",
  "places.businessStatus",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.priceRange",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.nationalPhoneNumber",
  "places.regularOpeningHours",
  "places.goodForChildren",
].join(",");

export function estimateCost(requests) {
  return Math.round(requests * COST_PER_REQUEST_USD * 100) / 100;
}

/** Request body for one Text Search. */
export function buildSearchBody(textQuery) {
  return {
    textQuery,
    pageSize: PAGE_SIZE,
    locationRestriction: {
      rectangle: {
        low: { latitude: BBOX.south, longitude: BBOX.west },
        high: { latitude: BBOX.north, longitude: BBOX.east },
      },
    },
    regionCode: "GB",
    languageCode: "en",
  };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export const MIN_RATING_COUNT = 15;

/** A result with any of these types is kept even with few reviews (parks are rarely reviewed). */
export const KEEP_TYPES = new Set(["playground", "park", "library", "amusement_park", "aquarium", "zoo", "swimming_pool", "museum"]);

/** Never kept, whatever else the place is: schools, childcare, lodging, licensed premises, worship, clinical. */
export const DROP_TYPES = new Set([
  "school", "primary_school", "secondary_school", "preschool", "child_care_agency", "university", "college",
  "lodging", "hotel", "bed_and_breakfast", "hostel", "guest_house", "motel", "resort_hotel", "inn", "campground",
  "bar", "pub", "night_club", "bar_and_grill", "wine_bar", "cocktail_bar", "irish_pub", "gastropub", "brewery", "brewpub",
  "church", "place_of_worship", "hindu_temple", "mosque", "synagogue",
  "hospital", "doctor", "dentist", "physiotherapist", "veterinary_care", "funeral_home", "cemetery", "real_estate_agency",
]);

/** Shops: dropped unless the place also carries a KEEP type (a museum with a gift shop is still a museum). */
export const SHOP_TYPES = new Set(["store", "shopping_mall", "supermarket", "grocery_store", "department_store", "market", "garden_center"]);

// Childcare / schooling by name, for results Google files under a generic type.
const DROP_NAME_RE =
  /\b(?:nurser(?:y|ies)|child ?minders?|day ?care|daycare|kindergartens?|pre-?schools?|playgroups?|(?:primary|secondary|high|nursery|infant|junior|private) schools?|school of)\b/i;

// Towns that sit inside the search rectangle but outside the City of Edinburgh.
// "Dalkeith Rd" / "Lasswade Road" are streets inside Edinburgh, so a trailing road word cancels the match.
const OUTSIDE_LOCALITY_RE = /\b(?:dalkeith|musselburgh|bonnyrigg|loanhead|penicuik|lasswade|danderhall|eskbank|newtongrange|gorebridge|wallyford|whitecraig|tranent|prestonpans|cockenzie)\b(?!\s+(?:rd|road|st|street|ave|avenue|dr|drive|place|pl|terrace|gardens)\b)/i;

// Google names some playgrounds just "Play Area"; a row called that is useless in the app.
const GENERIC_NAME_RE = /^(?:play ?area|play ?park|playpark|playground|park|children['’]?s play area|kids play area)$/i;

const CAFE_PLAY_NAME_RE = /play|kids?|children|family|toddler|baby|soft/i;
const CAFE_TYPE_LIST = ["cafe", "coffee_shop", "bakery", "tea_house"];
const isShopType = (t) => SHOP_TYPES.has(t) || t.endsWith("_store");

const typesOf = (place) => {
  const list = Array.isArray(place?.types) ? [...place.types] : [];
  if (place?.primaryType && !list.includes(place.primaryType)) list.push(place.primaryType);
  return list;
};

const nameOf = (place) => place?.displayName?.text ?? place?.name ?? "";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function insideBbox(lat, lng) {
  return isNum(lat) && isNum(lng) && lat >= BBOX.south && lat <= BBOX.north && lng >= BBOX.west && lng <= BBOX.east;
}

/**
 * Is this Google result a candidate at all? { ok, reason }. `reason` is set on
 * every drop so the dry-run file can say why.
 */
export function passesFilter(place) {
  const name = nameOf(place);
  if (!place?.id || !name) return { ok: false, reason: "no id or name" };
  const status = place.businessStatus;
  if (status && status !== "OPERATIONAL") return { ok: false, reason: `business status ${status}` };
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  if (!insideBbox(lat, lng)) return { ok: false, reason: "outside Edinburgh bbox" };

  if (GENERIC_NAME_RE.test(name.trim())) return { ok: false, reason: "generic name" };
  if (OUTSIDE_LOCALITY_RE.test(String(place.formattedAddress ?? ""))) return { ok: false, reason: "outside the City of Edinburgh" };

  const types = typesOf(place);
  const bad = types.find((t) => DROP_TYPES.has(t));
  if (bad) return { ok: false, reason: `type ${bad}` };
  if (DROP_NAME_RE.test(name)) return { ok: false, reason: "school/nursery/childcare name" };

  const keepType = types.find((t) => KEEP_TYPES.has(t));
  // A café Google marks good for children is kept even when it also carries a shop type (food_store, store).
  const kidCafe = types.some((t) => CAFE_TYPE_LIST.includes(t)) && (place.goodForChildren === true || CAFE_PLAY_NAME_RE.test(name));
  if (!keepType && !kidCafe) {
    const shop = types.find(isShopType);
    if (shop) return { ok: false, reason: `shop (${shop})` };
  }
  const count = isNum(place.userRatingCount) ? place.userRatingCount : 0;
  if (count < MIN_RATING_COUNT && !keepType) return { ok: false, reason: `only ${count} ratings and no park/library/museum-type` };
  return { ok: true, reason: keepType ? `type ${keepType}` : `${count} ratings` };
}

// ---------------------------------------------------------------------------
// Category + family_fit
// ---------------------------------------------------------------------------

const SOFT_PLAY_NAME_RE = /soft ?play|ball ?pit|play ?(?:centre|center|zone|barn|town|cafe|café|factory|land)\b|kidz|\bkids?\b.*(?:club|world|zone|party)|funtopia|adventure ?land|inflatable|fun ?parx/i;
const TRAMPOLINE_NAME_RE = /trampoline|\bjump\b|bounce|ninja|\bairhop|flip out|gravity/i;
const PLAYGROUND_NAME_RE = /playground|play ?park|playpark|play area|adventure play|play ?trail|play ?garden/i;
const SPLASH_NAME_RE = /splash ?(?:park|pad)|water ?play|paddling pool/i;
const FARM_NAME_RE = /\bfarm\b/i;
const CHILDREN_NAME_RE = /children['’]?s|\bkids?\b|\bjunior\b/i;
const LIBRARY_NAME_RE = /librar/i;
const POOL_NAME_RE = /\bswim|\bpool\b|aquatic|\bbaths?\b|leisure|lagoon/i;
// A sports centre / complex counts only when Google also lists a pool there (university gyms are not family venues).
const SPORTS_CENTRE_NAME_RE = /sports? (?:centre|center|complex)/i;
const LEISURE_NAME_RE = /leisure|sports? (?:centre|center|complex)|community centre|fitness|health club|david lloyd|nuffield/i;
const MUSEUM_NAME_RE = /museum|science centre|science center|discovery|camera obscura|dynamic earth|observatory/i;
// Weak climbing words (rock, wall) only count when the climbing query found the place ("Eden Rock", "alien rock").
const CLIMBING_STRONG_RE = /climb|boulder|\bbloc\b|adventure centre|adventure center|high ropes|ropes course/i;
const CLIMBING_WEAK_RE = /\brock\b|\bwall\b/i;
const CAFE_TYPES = new Set(CAFE_TYPE_LIST);
const FARM_EXCLUDE_NAME_RE = /brasserie|restaurant|stables?|riding|\bshop\b|garden centre|carvery|ice cream|farmhouse|dining|\binn\b|\bhotel\b/i;
const LITTLE_FREE_LIBRARY_RE = /little free library/i;

const has = (types, ...wanted) => wanted.some((t) => types.includes(t));

/**
 * { category, family_fit, reason } or null when nothing about the place says
 * "kids" or "all ages". `foundBy` (the queries that returned it) is only used
 * to accept weak climbing words ("rock", "wall") in a name.
 *
 * Rules mirror the owner's brief: playground / playpark / soft play /
 * trampoline / splash park / children's-named farm or library => 'kids'; city
 * farm, pools and leisure centres, museums, zoos, climbing centres and cafés
 * Google marks good for children => 'all_ages'. Decided from the place's own
 * name and Google types, not from the query alone (a pool is a pool even when
 * "soft play" found it).
 */
export function classifyPlace(place, foundBy = []) {
  const name = nameOf(place);
  const types = typesOf(place);
  const queries = foundBy.map((q) => q.toLowerCase());
  const foundFor = (re) => queries.some((q) => re.test(q));

  if (SOFT_PLAY_NAME_RE.test(name)) {
    if (TRAMPOLINE_NAME_RE.test(name) && !/soft ?play/i.test(name)) return { category: "trampoline park", family_fit: "kids", reason: `name: ${name}` };
    return { category: "soft play", family_fit: "kids", reason: "name: soft play" };
  }
  if (TRAMPOLINE_NAME_RE.test(name) && has(types, "amusement_center", "amusement_park", "gym", "sports_activity_location", "indoor_playground")) {
    return { category: "trampoline park", family_fit: "kids", reason: "name: trampoline/jump" };
  }
  if (has(types, "indoor_playground", "childrens_play_area")) return { category: "soft play", family_fit: "kids", reason: "type indoor playground" };
  if (SPLASH_NAME_RE.test(name)) return { category: "splash park", family_fit: "kids", reason: "name: splash park" };
  if (has(types, "playground") || PLAYGROUND_NAME_RE.test(name)) {
    return { category: "playground", family_fit: "kids", reason: has(types, "playground") ? "type playground" : "name: playground" };
  }
  if ((FARM_NAME_RE.test(name) || has(types, "farm")) && !FARM_EXCLUDE_NAME_RE.test(name) && !has(types, "restaurant", "cafe", "food", "food_store", "store")) {
    return CHILDREN_NAME_RE.test(name)
      ? { category: "farm", family_fit: "kids", reason: "name: children's farm" }
      : { category: "farm", family_fit: "all_ages", reason: "name: farm" };
  }
  if (LITTLE_FREE_LIBRARY_RE.test(name)) return null; // a book-swap box, not a library
  if (has(types, "library") || LIBRARY_NAME_RE.test(name)) {
    return CHILDREN_NAME_RE.test(name)
      ? { category: "library", family_fit: "kids", reason: "name: children's library" }
      : { category: "library", family_fit: "all_ages", reason: "type library" };
  }
  // A pool needs a pool-ish name (a gym that happens to have a pool is not a family pool), and swimming schools are not public pools.
  if ((POOL_NAME_RE.test(name) || (SPORTS_CENTRE_NAME_RE.test(name) && has(types, "swimming_pool"))) && !(has(types, "sports_school") && !has(types, "sports_complex"))) {
    return { category: LEISURE_NAME_RE.test(name) ? "leisure centre" : "swimming pool", family_fit: "all_ages", reason: "pool / leisure centre" };
  }
  if (has(types, "museum") || MUSEUM_NAME_RE.test(name)) return { category: "museum", family_fit: "all_ages", reason: "type museum" };
  if (has(types, "zoo", "aquarium", "wildlife_park")) return { category: has(types, "aquarium") ? "aquarium" : "zoo", family_fit: "all_ages", reason: "type zoo/aquarium" };
  if (
    (CLIMBING_STRONG_RE.test(name) || (CLIMBING_WEAK_RE.test(name) && foundFor(/climb/))) &&
    has(types, "gym", "sports_complex", "sports_activity_location", "amusement_center", "tourist_attraction", "fitness_center", "sports_club")
  ) {
    return { category: "climbing centre", family_fit: "all_ages", reason: "name: climbing" };
  }
  if (types.some((t) => CAFE_TYPES.has(t))) {
    if (place.goodForChildren === true || CAFE_PLAY_NAME_RE.test(name)) {
      return { category: "cafe", family_fit: "all_ages", reason: place.goodForChildren === true ? "cafe, Google goodForChildren" : "cafe, kid-friendly name" };
    }
    return null;
  }
  return null;
}

/**
 * Filter + classify one Google result. Returns
 *   { keep: true, category, family_fit, reason }
 *   { keep: false, reason }
 * A park/other result that carries no playground evidence is dropped with a
 * specific reason so the dry-run file shows it.
 */
export function evaluateCandidate(place, foundBy = []) {
  const f = passesFilter(place);
  if (!f.ok) return { keep: false, reason: f.reason };
  const c = classifyPlace(place, foundBy);
  if (!c) {
    const types = typesOf(place);
    return { keep: false, reason: types.includes("park") ? "park with no playground evidence" : "no kid/family rule matched" };
  }
  return { keep: true, ...c };
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

/**
 * Find the existing `places` row for a Google result: google_place_id first,
 * then name + proximity (acceptMatch: names match AND <= 250 m from the stored
 * coordinates, or within 2 km of the centre when the row has none). Provider-
 * cache rows (source = 'google') are not part of the curated catalogue and are
 * skipped. Returns { row, by: 'google_place_id' | 'name+proximity' } or null.
 */
export function findExisting(place, existingRows) {
  const rows = (existingRows ?? []).filter((r) => r?.source !== "google");
  const byId = rows.find((r) => r.google_place_id && r.google_place_id === place.id);
  if (byId) return { row: byId, by: "google_place_id" };
  for (const r of rows) {
    if (strongNameMatch(r.name, nameOf(place)) && acceptMatch(r, place).ok) return { row: r, by: "name+proximity" };
  }
  // Large venues (zoo, castle, museum) are pinned at different points by different sources: an identical
  // name within 1.5 km, or an identical name in the same postcode, is the same place.
  const key = nameTokens(nameOf(place)).join(" ");
  const pc = postcodeOf(place.formattedAddress);
  for (const r of rows) {
    if (!key || nameTokens(r.name).join(" ") !== key) continue;
    const here = isNum(r.lat) && isNum(r.lng) ? haversineMeters({ lat: r.lat, lng: r.lng }, { lat: place.location?.latitude, lng: place.location?.longitude }) : null;
    if ((here != null && here <= 1500) || (pc && postcodeOf(r.address) === pc)) return { row: r, by: "name+area" };
  }
  return null;
}

/**
 * Stricter than acceptMatch's name test: same name tokens, same words in
 * another order, or one name a prefix of the other with >= 2 shared tokens.
 * A one-word prefix never matches, so "The Fountain" (a bar) is not "Fountain
 * Park" (a leisure complex) however close they are.
 */
export function strongNameMatch(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  if (ta.join(" ") === tb.join(" ")) return true;
  if (ta.length >= 2 && ta.length === tb.length && [...ta].sort().join(" ") === [...tb].sort().join(" ")) return true;
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return shorter.length >= 2 && longer.length - shorter.length <= 4 && shorter.every((t, i) => longer[i] === t);
}

/** Same-run duplicate: same Google id, or same name within 150 m of an already accepted result. */
export function findRunDuplicate(place, accepted) {
  const name = nameOf(place).toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const a of accepted) {
    if (a.id === place.id) return a;
    const an = nameOf(a).toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (an === name && a.location && place.location) {
      const d = haversineMeters(
        { lat: a.location.latitude, lng: a.location.longitude },
        { lat: place.location.latitude, lng: place.location.longitude }
      );
      if (d <= 150) return a;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Result entries + staging rows
// ---------------------------------------------------------------------------

export function postcodeOf(address) {
  const m = String(address ?? "").toUpperCase().match(/\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/);
  return m ? m[0] : null;
}

/** One reviewable result entry (what the dry-run JSON stores, and --stage reads). */
export function buildEntry(place, verdict, foundBy, existing) {
  const hours = compactHours(place.regularOpeningHours?.weekdayDescriptions);
  return {
    status: existing ? "existing" : "new",
    name: nameOf(place),
    google_place_id: place.id,
    category: verdict.category,
    family_fit: verdict.family_fit,
    reason: verdict.reason,
    rating: isNum(place.rating) ? place.rating : null,
    rating_count: isNum(place.userRatingCount) ? place.userRatingCount : null,
    price_level: priceLevelToInt(place.priceLevel),
    price_range: priceRangeText(place.priceRange),
    address: place.formattedAddress ?? null,
    postcode: postcodeOf(place.formattedAddress),
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    hours,
    website: place.websiteUri ?? null,
    phone: place.nationalPhoneNumber ?? null,
    google_maps_uri: place.googleMapsUri ?? null,
    business_status: place.businessStatus ?? null,
    good_for_children: typeof place.goodForChildren === "boolean" ? place.goodForChildren : null,
    google_types: typesOf(place),
    found_by: foundBy,
    existing: existing
      ? {
          id: existing.row.id,
          name: existing.row.name,
          category: existing.row.category ?? null,
          family_fit: existing.row.family_fit ?? null,
          matched_by: existing.by,
        }
      : null,
  };
}

export const slugify = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** dedupe_key in the convention of the existing Edinburgh batches; `taken` (a Set) avoids same-batch slug clashes. */
export function dedupeKey(name, googlePlaceId, taken = new Set()) {
  const base = `name:city-of-edinburgh:${slugify(name)}`;
  let key = base;
  if (taken.has(key)) key = `${base}-${String(googlePlaceId ?? "").slice(-6).toLowerCase()}`;
  taken.add(key);
  return key;
}

/**
 * A `places_staging` row, every column scraper/upsert_places.py allows present
 * (PostgREST bulk insert needs identical keys), plus family_fit. Shape follows
 * the Edinburgh batches already promoted: region "Edinburgh & Lothians",
 * prefecture "City of Edinburgh", country GB; promote-places.mjs turns that
 * into destination "Edinburgh, Scotland" (use --destination-city Edinburgh).
 *
 * Staged with approved = false: the owner reviews, then approves (SQL printed
 * by the script) and runs promote-places.mjs. Google-owned facts (rating,
 * website, phone, summary) are deliberately NOT staged — they carry the
 * 30-day storage limit; scripts/enrich-places-google.mjs fills them, with a
 * google_fetched_at, after promotion. lat/lng/address/price_level/hours are
 * the "fill, keep forever" fields.
 */
export function buildStagingRow(entry, { batchId, now = new Date(), taken = new Set() } = {}) {
  const iso = new Date(now).toISOString();
  return {
    batch_id: batchId,
    dedupe_key: dedupeKey(entry.name, entry.google_place_id, taken),
    region: "Edinburgh & Lothians",
    prefecture: "City of Edinburgh",
    city: "Edinburgh",
    country: "GB",
    name: entry.name,
    category: entry.category,
    description: null,
    tips: [],
    hours: entry.hours ?? null,
    hours_status: entry.hours ? "known" : "unknown",
    station: null,
    google_place_id: entry.google_place_id,
    lat: entry.lat,
    lng: entry.lng,
    address: entry.address,
    rating: null,
    price_level: entry.price_level,
    image_url: null,
    badges: [],
    source_urls: [],
    field_sources: {},
    photo: null,
    extraction_model: "google-places-text-search",
    extraction_status: "validated",
    validation_errors: [],
    approved: false,
    rejected_reason: null,
    fetched_at: iso,
    last_verified_at: iso,
    family_fit: entry.family_fit,
  };
}

/** True when a PostgREST error means the family_fit column is not there yet (42703 / PGRST204). */
export function isMissingColumnError(status, bodyText) {
  const t = String(bodyText ?? "");
  return /42703|PGRST204/.test(t) || (status === 400 && /family_fit/.test(t) && /column/i.test(t));
}

/** Counts for the report: new/existing, by family_fit and by category. */
export function summarise(entries) {
  const out = { total: entries.length, new: 0, existing: 0, new_by_family_fit: {}, new_by_category: {}, existing_by_family_fit: {} };
  const bump = (o, k) => {
    o[k] = (o[k] ?? 0) + 1;
  };
  for (const e of entries) {
    if (e.status === "new") {
      out.new += 1;
      bump(out.new_by_family_fit, e.family_fit);
      bump(out.new_by_category, e.category);
    } else {
      out.existing += 1;
      bump(out.existing_by_family_fit, e.family_fit);
    }
  }
  return out;
}
