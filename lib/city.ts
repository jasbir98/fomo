/**
 * Fomo City — the single place the app's city is named.
 *
 * Fomo is a one-city app: "what can I do in Edinburgh right now that's free,
 * cheap, or discounted?". Before this module, every content lookup hung off
 * `trips.destination` (free text) plus geo fields resolved at trip creation via
 * Mapbox. With the trip layer removed there is no destination to resolve, so
 * every one of those reads collapses to the constant below.
 *
 * Deliberately a config object rather than inlined string literals: adding a
 * second city later should be a new entry here plus a research run, not an
 * archaeology exercise across forty files. That is also why nothing outside
 * this file should contain the literal "Edinburgh".
 *
 * NOT `server-only` — the feed, map and card components all need `CITY` for
 * timezone-correct day bucketing and for the "EH · Edinburgh" header pill, and
 * they are client components. Same deliberate exclusion as lib/events/format.ts.
 */

import type { Coordinates } from "@/lib/geo";

export interface CityConfig {
  /** Stable key. Also the slug prefix for `scope: "city"` happenings. */
  slug: string;
  /** Display name, e.g. the header pill and rail titles. */
  name: string;
  /** Wider administrative area — matches `happenings.region` for `scope: "region"` rows. */
  region: string;
  /** ISO-3166-1 alpha-2. Matches `happenings.country_code`. */
  countryCode: string;
  /**
   * IANA zone. Replaces the old `trips.timezone`, and is the zone every
   * occurrence's calendar day is computed in (lib/happenings/occurrence.ts).
   */
  timezone: string;
  /** Map default centre, and the fallback origin when location is denied. */
  center: Coordinates;
  /**
   * City-proper bounding box — same padded City of Edinburgh council area
   * box the places geocoding pipeline uses (scraper/geocode_osm.py's
   * `CITY_VIEWBOXES`): Corstorphine/Ratho to Portobello, Leith to
   * Fairmilehead. Drives the Reels "Edinburgh" location filter
   * (lib/social/location-filter.ts) so it agrees with what the pipeline
   * already considers "in Edinburgh".
   */
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  /**
   * Radius (km, from `center`) for the Reels "Near Edinburgh" location
   * filter — the commuter/day-trip belt (Leith, Musselburgh, North
   * Berwick, Queensferry, Linlithgow, …). A superset of `bbox`, not a ring:
   * "Near Edinburgh" means "within this radius", Edinburgh proper included.
   */
  nearRadiusKm: number;
  /** ISO-4217, for `happenings.currency` defaults and price formatting. */
  currency: string;
  currencySymbol: string;
  /**
   * Postcode prefix that marks a local resident. Drives the "EH · Edinburgh"
   * header pill and the copy on `eligibility: "local_resident"` badges.
   * Fomo shows resident-only offers to everyone, clearly labelled, rather than
   * filtering them out — so this is presentational, never a filter.
   */
  postcodePrefix: string;
  /**
   * Districts used for the card/pin locality line ("Old Town · 0.2 mi").
   * Ordered roughly centre-outward; first match wins when deriving a district
   * from an address, so keep more specific names ahead of broader ones.
   */
  districts: readonly string[];
}

export const CITY: CityConfig = {
  slug: "edinburgh",
  name: "Edinburgh",
  region: "Scotland",
  countryCode: "GB",
  timezone: "Europe/London",
  // Approximately the Royal Mile / city centre.
  center: { lat: 55.9533, lng: -3.1883 },
  bbox: { minLat: 55.85, maxLat: 56.01, minLng: -3.46, maxLng: -3.05 },
  nearRadiusKm: 50,
  currency: "GBP",
  currencySymbol: "£",
  postcodePrefix: "EH",
  districts: [
    "Old Town",
    "New Town",
    "West End",
    "Southside",
    "Bruntsfield",
    "Marchmont",
    "Stockbridge",
    "Canonmills",
    "Leith Shore",
    "Leith",
    "Newington",
    "Tollcross",
    "Haymarket",
    "Grassmarket",
    "Dalry",
    "Portobello",
    "Morningside",
    "Corstorphine",
  ],
} as const;

/** The header pill: "EH · Edinburgh". */
export function cityBadge(city: CityConfig = CITY): string {
  return `${city.postcodePrefix} · ${city.name}`;
}

/**
 * Cities the app can actually show. Just `CITY` today: the Home feed
 * (`/api/feed`, `/api/now`, `/api/happenings/[id]`, `/api/saved`) and the
 * Reels location filter (lib/db/social.ts) all query the curated Edinburgh
 * dataset directly with no destination/city parameter, so picking a
 * different city would silently keep showing Edinburgh on Home regardless —
 * worse than not offering the choice. (`/api/events`, `/api/experiences`,
 * `/api/places`, and `/api/weather` do geocode an arbitrary `destination`
 * string already, but that's not enough to make this a genuinely
 * multi-city app while its flagship feed isn't.)
 *
 * Exported as a list, not just the single `CITY` constant, so the client
 * city picker (lib/useSelectedCity.ts) has one real source of truth to
 * render from -- adding a second city later is extending this array, not
 * hand-writing a second hardcoded list to keep in sync.
 */
export const SUPPORTED_CITIES: readonly CityConfig[] = [CITY];

/** Looks up a `SUPPORTED_CITIES` entry by `slug` -- null for an unknown/stale persisted value. */
export function findCityBySlug(slug: string): CityConfig | null {
  return SUPPORTED_CITIES.find((city) => city.slug === slug) ?? null;
}

/**
 * Best-effort district for a free-text address. Returns null rather than
 * guessing — the locality line simply omits the district when unknown, which
 * reads fine ("0.2 mi" alone), whereas a wrong district is actively misleading.
 *
 * `happenings.district` is a real column populated by the research pipeline;
 * this exists for `places`, which has no district column and ~3,369 rows whose
 * only locality signal is the address string.
 */
export function districtFromAddress(
  address: string | null | undefined,
  city: CityConfig = CITY
): string | null {
  if (!address) return null;
  const haystack = address.toLowerCase();
  return city.districts.find((d) => haystack.includes(d.toLowerCase())) ?? null;
}
