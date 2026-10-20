/**
 * geocode-venue.mjs — map coordinates for a happening that has neither its
 * own lat/lng nor a linked place, via Mapbox. Without them a deal can't be a
 * map pin or one of Ask Fomo's numbered "Fomo's picks" (lib/explore/picks.ts
 * skips results with no coordinates), so a reply showing four cards put one
 * pin on the map.
 *
 * Shared by scripts/geocode-happenings.mjs (backfill) and
 * scripts/promote-happenings.mjs (new rows). No `@/` alias, so it runs under
 * plain `node --test` — same constraint as scripts/lib/place-match.mjs.
 *
 * Conservative, best source first:
 *   1. address — only when it carries a full UK postcode; Mapbox's address
 *      match at exact/high confidence, else the postcode's own centroid
 *      (within ~100m in a city).
 *   2. venue   — Mapbox POI search on venue_name, accepted only when the
 *      result's name and the venue's share every token of the shorter one
 *      (nameTokens, so "The"/"Edinburgh"/"and" don't count) with at most
 *      MAX_EXTRA_TOKENS extra. Several such results far apart (a chain) are
 *      ambiguous and left alone.
 * A wrong pin sends someone to the wrong door, so anything else is "none".
 */

import { nameTokens } from "./place-match.mjs";

// Edinburgh and the Lothians ([minLng, minLat, maxLng, maxLat]): wide enough
// for the Museum of Flight or Cramond, too small for a same-named pub in Glasgow.
export const LOTHIANS_BBOX = [-3.75, 55.75, -2.5, 56.1];
const EDINBURGH_CENTER = [-3.1883, 55.9533];
const MAX_EXTRA_TOKENS = 2;
// Two accepted POI results further apart than this are different branches.
const SAME_VENUE_KM = 0.3;

const POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

/** "EH2 1JE" from an address, normalised to one space, or null. */
export function fullPostcode(address) {
  if (typeof address !== "string") return null;
  const m = address.match(POSTCODE_RE);
  return m ? `${m[1]} ${m[2]}`.toUpperCase() : null;
}

// Words a listing tacks onto a venue's name without making it another venue:
// "Rabble" is "Rabble Taphouse and Grill", "Tamil Teru" is "Tamil Teru -
// Indian Restaurant". "shop", "tours", "session" are deliberately absent:
// "Student Union Shop" and "Court of Session" are not the bar's quiz night.
const DESCRIPTOR_TOKENS = new Set([
  "the", "of", "bar", "bars", "pub", "inn", "tavern", "saloon", "lounge", "grill", "taphouse", "brewpub",
  "restaurant", "eatery", "kitchen", "cafe", "bistro", "indian", "italian", "nightclub", "club", "studio",
  "distillery", "gin", "cocktail", "edinburgh", "leith", "scotland", "ltd",
]);

/** True when a POI's name is the venue's (see this file's header). */
export function poiNameMatches(venueName, poiName) {
  const a = nameTokens(venueName);
  const b = nameTokens(poiName);
  if (a.length === 0 || b.length === 0) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  // A lone short word ("Pho", "Bar") names too many places.
  if (shorter.length === 1 && shorter[0].length < 4) return false;
  if (longer.length - shorter.length > MAX_EXTRA_TOKENS) return false;
  const short = new Set(shorter);
  if (!shorter.every((t) => longer.includes(t))) return false;
  // A long, specific name can carry one real extra word ("WHIPS: Women Hidden
  // in Plain Sight"); a short one only descriptors.
  const realExtras = longer.filter((t) => !short.has(t) && !DESCRIPTOR_TOKENS.has(t));
  return realExtras.length <= (shorter.length >= 3 ? 1 : 0);
}

export function haversineKm(aLat, aLng, bLat, bLng) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export function inBbox(lat, lng, bbox = LOTHIANS_BBOX) {
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

/**
 * Pick the venue from POI results ({ name, lat, lng }[]): the name-matching
 * ones inside the bbox, nearest-first as Mapbox ranked them. Returns
 * { status: "found", lat, lng, name } | { status: "ambiguous", names } | { status: "none" }.
 */
export function choosePoi(venueName, results) {
  const ok = (results ?? []).filter(
    (r) => typeof r.lat === "number" && typeof r.lng === "number" && inBbox(r.lat, r.lng) && poiNameMatches(venueName, r.name)
  );
  if (ok.length === 0) return { status: "none" };
  const [first, ...rest] = ok;
  if (rest.some((r) => haversineKm(first.lat, first.lng, r.lat, r.lng) > SAME_VENUE_KM)) {
    return { status: "ambiguous", names: ok.map((r) => r.name) };
  }
  return { status: "found", lat: first.lat, lng: first.lng, name: first.name };
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mapbox ${res.status} ${res.statusText}`);
  return res.json();
}

function commonParams(token) {
  return (
    `&country=gb&proximity=${EDINBURGH_CENTER.join(",")}&bbox=${LOTHIANS_BBOX.join(",")}` +
    `&access_token=${encodeURIComponent(token)}`
  );
}

async function geocodeAddress(address, postcode, token) {
  const base = "https://api.mapbox.com/search/geocode/v6/forward?limit=1";
  const addr = await getJson(`${base}&types=address&q=${encodeURIComponent(address)}${commonParams(token)}`);
  const a = addr.features?.[0];
  const conf = a?.properties?.match_code?.confidence;
  if (a && (conf === "exact" || conf === "high")) {
    const [lng, lat] = a.geometry.coordinates;
    if (inBbox(lat, lng)) return { lat, lng, via: "address" };
  }
  const pc = await getJson(`${base}&types=postcode&q=${encodeURIComponent(postcode)}${commonParams(token)}`);
  const p = pc.features?.[0];
  if (p && p.properties?.name?.replace(/\s+/g, " ").toUpperCase() === postcode) {
    const [lng, lat] = p.geometry.coordinates;
    if (inBbox(lat, lng)) return { lat, lng, via: "postcode" };
  }
  return null;
}

async function searchPoi(venueName, token) {
  const url =
    `https://api.mapbox.com/search/searchbox/v1/forward?limit=5&types=poi` +
    `&q=${encodeURIComponent(venueName)}${commonParams(token)}`;
  const data = await getJson(url);
  return (data.features ?? []).map((f) => ({
    name: f.properties?.name ?? "",
    lng: f.geometry?.coordinates?.[0],
    lat: f.geometry?.coordinates?.[1],
  }));
}

/**
 * Geocode one happening ({ venue_name, address, scope }). Returns
 *   { status: "found", lat, lng, via: "address" | "postcode" | "venue", name? }
 *   { status: "ambiguous", names } | { status: "none" } | { status: "skipped", reason }
 * Throws only on a Mapbox/network error.
 */
export async function geocodeHappening(h, token) {
  if (!token) return { status: "skipped", reason: "no NEXT_PUBLIC_MAPBOX_TOKEN" };
  // National/region deals ("Participating Wetherspoon pubs") have no one door.
  if (h.scope === "national" || h.scope === "region") return { status: "skipped", reason: `scope ${h.scope}` };

  const postcode = fullPostcode(h.address);
  if (postcode) {
    const hit = await geocodeAddress(h.address, postcode, token);
    if (hit) return { status: "found", ...hit };
  }
  if (typeof h.venue_name === "string" && nameTokens(h.venue_name).length > 0) {
    const poi = choosePoi(h.venue_name, await searchPoi(h.venue_name, token));
    if (poi.status === "found") return { status: "found", lat: poi.lat, lng: poi.lng, via: "venue", name: poi.name };
    if (poi.status === "ambiguous") return poi;
  }
  return { status: "none" };
}
