import { supabase } from "@/lib/supabase";
import type { SocialPost } from "@/lib/types";
import { diversifyReelsByPlace } from "@/lib/social/order";

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

/** List all social posts (shared seed data, no device scoping). */
export async function listSocialPosts(): Promise<SocialPost[]> {
  const { data, error } = await supabase.from("social_posts").select("*");
  if (error) throw error;
  return data ?? [];
}

/** Fetch a single social post by id. Returns null if not found. */
export async function getSocialPost(id: string): Promise<SocialPost | null> {
  const { data, error } = await supabase
    .from("social_posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * A reel plus its linked place's coordinates (if any) -- lets callers sort
 * reels by distance from the device's live location without a second query.
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
export async function listReels(destination?: string | null): Promise<SocialPostWithPlace[]> {
  if (!destination) {
    const { data, error } = await supabase
      .from("social_posts")
      .select("*, places(lat, lng)")
      .not("video_url", "is", null)
      .order("likes", { ascending: false, nullsFirst: false });
    if (error) throw error;
    return diversifyReelsByPlace((data ?? []).map(withPlace));
  }

  const { data: directMatches, error: directError } = await supabase
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

  const { data: countryMatches, error: countryError } = await supabase
    .from("social_posts")
    .select("*, places!inner(lat, lng, country)")
    .not("video_url", "is", null)
    .eq("places.country", countryCode)
    .order("likes", { ascending: false, nullsFirst: false });
  if (countryError) throw countryError;
  return diversifyReelsByPlace((countryMatches ?? []).map(withPlace));
}
