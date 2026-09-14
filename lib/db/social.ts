import type { Db } from "@/lib/supabase/types";
import type { SocialPost } from "@/lib/types";
import { diversifyReelsByPlace } from "@/lib/social/order";
import { CITY } from "@/lib/city";
import { distanceKm } from "@/lib/geo";

/**
 * Lowercase destination-string fragment -> the ISO-2 country code stored in
 * `places.country`. Reels only carry a city/region-level `destination`
 * ("Aberdeenshire", "Tokyo") with no country of their own, so a country-wide
 * trip destination ("Scotland, United Kingdom") can't be matched against it
 * by substring alone -- this resolves the trip's country instead, so it can
 * be matched via each reel's linked `places.country` (see listReels below).
 */
const DESTINATION_COUNTRY_CODES: Record<string, string> = {
  japan: "JP",
  "united kingdom": "GB",
  scotland: "GB",
  england: "GB",
  wales: "GB",
  "northern ireland": "GB",
  "great britain": "GB",
};

function countryCodeForDestination(destination: string): string | null {
  const lower = destination.toLowerCase();
  for (const [fragment, code] of Object.entries(DESTINATION_COUNTRY_CODES)) {
    if (lower.includes(fragment)) return code;
  }
  return null;
}

/** List all social posts (shared catalog data, no user scoping). */
export async function listSocialPosts(db: Db): Promise<SocialPost[]> {
  const { data, error } = await db.from("social_posts").select("*");
  if (error) throw error;
  return data ?? [];
}

/** Fetch a single social post by id. Returns null if not found. */
export async function getSocialPost(db: Db, id: string): Promise<SocialPost | null> {
  const { data, error } = await db.from("social_posts").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * A reel plus its linked place's coordinates (if any) -- lets callers sort
 * reels by distance from the caller's live location without a second query.
 * Structurally a superset of `SocialPost`, so it's a drop-in wherever a
 * `SocialPost[]` is expected (ReelViewer, oneReelPerPlace, etc).
 */
export interface SocialPostWithPlace extends SocialPost {
  place: { lat: number | null; lng: number | null } | null;
}

type RawReelRow = SocialPost & {
  places: { lat: number | null; lng: number | null } | { lat: number | null; lng: number | null }[] | null;
};

/** Normalizes Supabase's embedded-resource shape (object or array) to one place-or-null. */
function withPlace(row: RawReelRow): SocialPostWithPlace {
  const { places, ...post } = row;
  const place = Array.isArray(places) ? (places[0] ?? null) : places;
  return { ...post, place };
}

/**
 * List reels (social posts with a video_url) fed by the offline scraper.
 * When `destination` is given, filters to reels for that destination:
 *
 * 1. A direct substring match against the reel's own `destination` column
 *    (city/region-level, e.g. "Aberdeenshire", "Tokyo") -- covers a
 *    city/region-level trip, or being passed a reel's own destination back.
 * 2. If that finds nothing, resolves the trip destination's *country* (see
 *    countryCodeForDestination) and matches reels via their linked place's
 *    `places.country` instead -- this is what makes a country-wide trip
 *    ("Scotland, United Kingdom") find reels tagged with Scottish
 *    city/region names, without ever matching a reel from an unrelated
 *    country that just happens to have an empty step 1 (e.g. showing Japan
 *    reels for a Scotland trip).
 *
 * Returns an empty list rather than every reel when neither step matches --
 * callers should fall back to non-reel content, not cross-country reels.
 *
 * Ordered most-liked-first, then round-robined across places
 * (diversifyReelsByPlace) so the several reels the scraper collects for one
 * popular spot don't arrive back-to-back in the feed. Each reel's linked
 * place's lat/lng is embedded (`place`) so callers can re-sort by distance
 * from a live location -- see lib/geo.ts's sortByDistance.
 */
export async function listReels(db: Db, destination?: string | null): Promise<SocialPostWithPlace[]> {
  if (!destination) {
    const { data, error } = await db
      .from("social_posts")
      .select("*, places(lat, lng)")
      .not("video_url", "is", null)
      .order("likes", { ascending: false, nullsFirst: false });
    if (error) throw error;
    return diversifyReelsByPlace((data ?? []).map(withPlace));
  }

  const { data: directMatches, error: directError } = await db
    .from("social_posts")
    .select("*, places(lat, lng)")
    .not("video_url", "is", null)
    .ilike("destination", `%${destination}%`)
    .order("likes", { ascending: false, nullsFirst: false });
  if (directError) throw directError;
  if (directMatches && directMatches.length > 0) {
    return diversifyReelsByPlace(directMatches.map(withPlace));
  }

  const countryCode = countryCodeForDestination(destination);
  if (!countryCode) return [];

  const { data: countryMatches, error: countryError } = await db
    .from("social_posts")
    .select("*, places!inner(lat, lng, country)")
    .not("video_url", "is", null)
    .eq("places.country", countryCode)
    .order("likes", { ascending: false, nullsFirst: false });
  if (countryError) throw countryError;
  return diversifyReelsByPlace((countryMatches ?? []).map(withPlace));
}

/**
 * The Reels tab's location filter (task: "Reels only from Edinburgh /
 * nearby, with a filter"). Three tiers, each a superset of the last:
 *  - "edinburgh": inside `CITY.bbox` -- the same padded City of Edinburgh
 *    council area box the places geocoding pipeline uses.
 *  - "near_edinburgh": within `CITY.nearRadiusKm` (50km) of `CITY.center` --
 *    the day-trip belt (Leith, Musselburgh, North Berwick, Queensferry,
 *    Linlithgow, …). Includes everything "edinburgh" does.
 *  - "all_scotland": every reel linked to a GB place, plus place-less reels
 *    whose own `destination` text doesn't look like a non-Scotland tag (see
 *    isLikelyScotlandDestination) -- the existing corpus is Scotland +
 *    Japan (Tokyo/Kanto pilot), so this is what keeps Japan reels out of an
 *    "All Scotland" filter.
 */
export type ReelLocationScope = "edinburgh" | "near_edinburgh" | "all_scotland";

/**
 * Destination tags belonging to the Japan Kanto pilot corpus (see
 * scraper/JAPAN_PLACES_PIPELINE.md) -- the only non-Scotland content
 * `social_posts` currently has. A place-less reel (no `place_id`, so no
 * `places.country` to check) is matched against this list; anything that
 * doesn't look Japanese is treated as plausibly Scottish rather than
 * silently dropped, since a reel with a destination tag genuinely does have
 * usable location text (unlike a reel with neither a place nor a
 * destination, which also falls through to "plausibly Scottish" here --
 * see the doc on listReelsByLocation's all_scotland bucket).
 */
const NON_SCOTLAND_DESTINATION_KEYWORDS = ["tokyo", "japan", "kanagawa", "chiba", "kanto", "saitama"];

function isLikelyScotlandDestination(destination: string | null): boolean {
  if (!destination) return true;
  const lower = destination.toLowerCase();
  return !NON_SCOTLAND_DESTINATION_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Place-less reels (no `place_id`) matching a location filter by their own `destination`/`location` text. */
async function listOrphanReelsForScope(
  db: Db,
  scope: ReelLocationScope
): Promise<SocialPostWithPlace[]> {
  const { data, error } = await db
    .from("social_posts")
    .select("*, places(lat, lng)")
    .not("video_url", "is", null)
    .is("place_id", null)
    .order("likes", { ascending: false, nullsFirst: false });
  if (error) throw error;
  const rows = data ?? [];

  if (scope === "all_scotland") {
    return rows.filter((r) => isLikelyScotlandDestination(r.destination)).map(withPlace);
  }
  // "edinburgh" / "near_edinburgh": no coordinates to test, so this is a
  // pure text match against the classified destination/location -- the
  // *narrowest* filter and the only textual signal we have for a place-less
  // reel is "does it literally say Edinburgh".
  const needle = CITY.name.toLowerCase();
  return rows
    .filter((r) => r.destination?.toLowerCase().includes(needle) || r.location?.toLowerCase().includes(needle))
    .map(withPlace);
}

export async function listReelsByLocation(
  db: Db,
  scope: ReelLocationScope
): Promise<SocialPostWithPlace[]> {
  if (scope === "all_scotland") {
    const { data: linked, error } = await db
      .from("social_posts")
      .select("*, places!inner(lat, lng, country)")
      .not("video_url", "is", null)
      .eq("places.country", CITY.countryCode)
      .order("likes", { ascending: false, nullsFirst: false });
    if (error) throw error;

    const orphans = await listOrphanReelsForScope(db, scope);
    return diversifyReelsByPlace([...(linked ?? []).map(withPlace), ...orphans]);
  }

  // "edinburgh" / "near_edinburgh": a rectangular bounding-box prefilter run
  // server-side against the joined place's lat/lng (same `places!inner` +
  // dot-notation filter pattern as the country match above) -- only rows
  // inside the box are ever fetched. "near_edinburgh" uses a box big enough
  // to contain the `nearRadiusKm` circle, then trims to the exact circle in
  // JS (cheap: the box is already a small slice of the corpus, never the
  // full 500+ row table).
  const box =
    scope === "edinburgh"
      ? CITY.bbox
      : boundingBoxForRadius(CITY.center, CITY.nearRadiusKm);

  const { data: linked, error } = await db
    .from("social_posts")
    .select("*, places!inner(lat, lng, country)")
    .not("video_url", "is", null)
    .gte("places.lat", box.minLat)
    .lte("places.lat", box.maxLat)
    .gte("places.lng", box.minLng)
    .lte("places.lng", box.maxLng)
    .order("likes", { ascending: false, nullsFirst: false });
  if (error) throw error;

  let placed = (linked ?? []).map(withPlace);
  if (scope === "near_edinburgh") {
    placed = placed.filter(
      (r) => r.place?.lat != null && r.place?.lng != null && distanceKm(CITY.center, { lat: r.place.lat, lng: r.place.lng }) <= CITY.nearRadiusKm
    );
  }

  const orphans = await listOrphanReelsForScope(db, scope);
  return diversifyReelsByPlace([...placed, ...orphans]);
}

/**
 * A rectangular box guaranteed to contain every point within `radiusKm` of
 * `center` -- a cheap server-side prefilter ahead of the exact haversine
 * trim in listReelsByLocation. Longitude degrees shrink toward the poles
 * (scale by cos(latitude)), so the box is padded generously (a straight
 * cos(lat) scale with no slack under-covers at the box's own edges, since
 * cos changes across the box's latitude span too).
 */
function boundingBoxForRadius(
  center: { lat: number; lng: number },
  radiusKm: number
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const KM_PER_DEG_LAT = 111.32;
  const latPad = radiusKm / KM_PER_DEG_LAT;
  const lngScale = Math.max(Math.cos(((Math.abs(center.lat) + latPad) * Math.PI) / 180), 0.01);
  const lngPad = radiusKm / (KM_PER_DEG_LAT * lngScale);
  return {
    minLat: center.lat - latPad,
    maxLat: center.lat + latPad,
    minLng: center.lng - lngPad,
    maxLng: center.lng + lngPad,
  };
}
