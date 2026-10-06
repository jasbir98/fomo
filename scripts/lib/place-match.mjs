/**
 * place-match.mjs — pure name matching between a happening (a deal's
 * `venue_name`, else its title) and the curated `places` catalogue, so a deal
 * with no photo of its own can borrow its venue's photo through `place_id`
 * (the app already does that: see withPlaceImageFallback in
 * app/api/feed/route.ts).
 *
 * Shared by scripts/link-happening-places.mjs (backfill) and
 * scripts/promote-happenings.mjs (new rows). No I/O and no `@/` alias, so it
 * runs under plain `node --test` — same constraint as scripts/lib/describe.mjs.
 *
 * Conservative by design: a link is made ONLY when exactly one place matches
 * at the best tier. Anything else is reported as ambiguous / no match and
 * left for a human, because a wrong link puts the wrong venue's photo and
 * "Offers here" list on a deal — worse than the category stock image.
 *
 * Tiers, best first:
 *   1. exact   — same name once normalised ("Filmhouse" = "Filmhouse Edinburgh")
 *   2. partial — the shorter name (>= 2 tokens) is a whole-token prefix of the
 *                longer ("Camera Obscura" / "Camera Obscura & World of
 *                Illusions"), with at most MAX_EXTRA_TOKENS extra tokens
 * Single-token names only ever match at tier 1: "Festival" must never
 * partial-match "Festival Theatre".
 */

// PostgREST path for the places a deal can borrow a photo from — same filter
// as lib/db/places.ts's listPlacesByCity (live Google-cache rows excluded),
// with place_photos embedded so a place whose only photo lives there still
// counts as having an image (lib/db/places.ts's withThumbnail does the same).
export const EDINBURGH_PLACES_QUERY =
  "places?source=neq.google" +
  "&or=(city.ilike.*Edinburgh*,destination.ilike.*Edinburgh*,address.ilike.*Edinburgh*)" +
  "&select=id,name,image_url,lat,lng,place_photos(url,display_order)";

const MAX_EXTRA_TOKENS = 3;
// A place this far from a happening's own coordinates is a different venue
// with a similar name, whatever the names say.
const MAX_DISTANCE_KM = 2;

/** Lower-case, diacritics stripped, "&" -> "and", apostrophes dropped, other punctuation -> space. */
export function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Comparison key: normalised tokens minus a leading "the" and a leading or
 * trailing "edinburgh" (city suffixes the sources add inconsistently), minus
 * "and" everywhere. "theatre" is deliberately NOT generic — "Festival
 * Theatre" and "King's Theatre" must stay distinct.
 */
export function nameTokens(value) {
  let tokens = normalizeName(value).split(" ").filter(Boolean);
  if (tokens[0] === "the") tokens = tokens.slice(1);
  if (tokens.length > 1 && tokens[tokens.length - 1] === "edinburgh") tokens = tokens.slice(0, -1);
  if (tokens.length > 1 && tokens[0] === "edinburgh") tokens = tokens.slice(1);
  return tokens.filter((t) => t !== "and");
}

export function nameKey(value) {
  return nameTokens(value).join(" ");
}

function hasPrefix(longer, shorter) {
  if (shorter.length > longer.length) return false;
  return shorter.every((t, i) => longer[i] === t);
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function placeImage(row) {
  if (row.image_url) return row.image_url;
  const photos = Array.isArray(row.place_photos) ? [...row.place_photos] : [];
  photos.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  return photos[0]?.url ?? null;
}

/** Index `places` rows ({id, name, image_url, lat, lng, place_photos?}) for matching. */
export function buildPlaceIndex(rows) {
  const places = [];
  for (const row of rows ?? []) {
    const tokens = nameTokens(row.name);
    if (!row.id || tokens.length === 0) continue;
    places.push({
      id: row.id,
      name: row.name,
      tokens,
      key: tokens.join(" "),
      image: placeImage(row),
      lat: typeof row.lat === "number" ? row.lat : null,
      lng: typeof row.lng === "number" ? row.lng : null,
    });
  }
  return { places };
}

function near(place, lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number" || place.lat == null || place.lng == null) return true;
  return haversineKm(lat, lng, place.lat, place.lng) <= MAX_DISTANCE_KM;
}

// Several candidates at one tier: genuine duplicates of ONE venue share a key,
// so prefer the one that has a photo (that is the point of linking). Candidates
// with different keys, or several photo-bearing ones, stay ambiguous.
function resolveTie(candidates) {
  if (candidates.length === 1) return { place: candidates[0], tieBroken: false };
  if (new Set(candidates.map((c) => c.key)).size !== 1) return null;
  const withImage = candidates.filter((c) => c.image);
  if (withImage.length === 1) return { place: withImage[0], tieBroken: true };
  return null;
}

/**
 * Match one venue name. Returns
 *   { status: "linked", place, tier, tieBroken }
 *   { status: "ambiguous", candidates, tier }
 *   { status: "none" }
 * `where` optionally carries { lat, lng } to veto a same-named place far away.
 */
export function matchVenueName(index, venueName, where = {}) {
  const tokens = nameTokens(venueName);
  if (tokens.length === 0) return { status: "none" };
  const key = tokens.join(" ");

  const exact = index.places.filter((p) => p.key === key && near(p, where.lat, where.lng));
  if (exact.length > 0) {
    const tie = resolveTie(exact);
    return tie ? { status: "linked", tier: "exact", ...tie } : { status: "ambiguous", tier: "exact", candidates: exact };
  }

  const partial = index.places.filter((p) => {
    if (!near(p, where.lat, where.lng)) return false;
    const [shorter, longer] = tokens.length <= p.tokens.length ? [tokens, p.tokens] : [p.tokens, tokens];
    return shorter.length >= 2 && longer.length - shorter.length <= MAX_EXTRA_TOKENS && hasPrefix(longer, shorter);
  });
  if (partial.length > 0) {
    const tie = resolveTie(partial);
    return tie ? { status: "linked", tier: "partial", ...tie } : { status: "ambiguous", tier: "partial", candidates: partial };
  }

  return { status: "none" };
}

/**
 * Match a happening: `venue_name` first. Only when it has no venue_name is a
 * venue read off the title, and only an EXACT match on a leading run of title
 * words counts ("Traverse Theatre £1 Tickets" -> "Traverse Theatre"), longest
 * run first; a title never partial-matches. National/region rows have no
 * single venue and never link.
 *
 * Returns the matchVenueName result plus `via` ("venue_name" | "title") and
 * `venue` (the string that matched), or { status: "none" }.
 */
export function matchHappening(index, happening) {
  if (!happening || happening.scope === "national" || happening.scope === "region") return { status: "none" };
  const where = { lat: happening.lat, lng: happening.lng };

  if (typeof happening.venue_name === "string" && nameKey(happening.venue_name)) {
    const result = matchVenueName(index, happening.venue_name, where);
    return { ...result, via: "venue_name", venue: happening.venue_name };
  }

  const words = normalizeName(happening.title).split(" ").filter(Boolean);
  for (let n = Math.min(words.length, 5); n >= 1; n -= 1) {
    const run = words.slice(0, n).join(" ");
    const tokens = nameTokens(run);
    // A lone short word ("free", "new") is never a venue name.
    if (tokens.length === 0 || (tokens.length === 1 && tokens[0].length < 5)) continue;
    const exact = index.places.filter((p) => p.key === tokens.join(" ") && near(p, where.lat, where.lng));
    if (exact.length === 0) continue;
    const tie = resolveTie(exact);
    return tie
      ? { status: "linked", tier: "exact", ...tie, via: "title", venue: run }
      : { status: "ambiguous", tier: "exact", candidates: exact, via: "title", venue: run };
  }
  return { status: "none" };
}
