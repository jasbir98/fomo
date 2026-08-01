// Server-side Viator Partner API (Basic Access) product search for the
// experiences feature. Fetches bookable tours/activities for a destination +
// optional free-text/category filter, and maps them into the shape used to
// upsert into the `experiences` table.
//
// NOTE: verify field/endpoint names against
// https://docs.viator.com/partner-api/technical/ before going live — built
// from documented conventions, not a live-tested response.
import "server-only";

/** Thrown when Viator returns a non-2xx or the request otherwise fails. */
export class ViatorError extends Error {}

// A live-fetched product mapped to the `experiences` upsert shape. Mirrors
// google.ts's MappedPlace: everything from the Experience row except id /
// created_at, which are DB-generated.
export type MappedExperience = {
  provider: string;
  provider_product_id: string;
  title: string;
  category: string | null;
  rating: number | null;
  review_count: number | null;
  price_from: number | null;
  currency: string | null;
  duration_label: string | null;
  image_url: string | null;
  description: string | null;
  destination: string | null;
  city: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  booking_url: string | null;
  source: string;
  fetched_at: string;
};

// Raw shape of a single product from Viator's product search response (fields
// we read). Field names are our best guess from documented conventions —
// see the NOTE above.
interface ViatorProduct {
  productCode?: string;
  title?: string;
  description?: string;
  reviews?: { combinedAverageRating?: number; totalReviews?: number };
  pricing?: { summary?: { fromPrice?: number }; currency?: string };
  duration?: { fixedDurationInMinutes?: number; label?: string };
  images?: { variants?: { url?: string; width?: number }[] }[];
  productUrl?: string;
  webURL?: string;
  destinations?: { ref?: string; name?: string }[];
  primaryDestinationName?: string;
  location?: { latitude?: number; longitude?: number };
  tags?: string[];
  category?: string;
}

// A single entry from Viator's /destinations taxonomy (their own reference
// list of bookable locations — confirmed required live: the product search
// endpoint rejects a free-text destination string with "Invalid destination:
// not a number", and rejects an entirely missing `filtering` object with
// "Missing filtering", so a numeric destinationId resolved from this list is
// mandatory, not optional).
interface ViatorDestination {
  destinationId?: number;
  name?: string;
  type?: string; // e.g. "CITY", "COUNTRY", "REGION" — prefer CITY on name clashes.
}

// Module-level cache: the destination taxonomy is a large (~3000-entry), slow
// moving reference list — fine to fetch once per server process and reuse
// across every search, rather than re-fetching per request.
let destinationCache: { data: ViatorDestination[]; fetchedAt: number } | null = null;
const DESTINATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchViatorDestinations(baseUrl: string, apiKey: string): Promise<ViatorDestination[]> {
  if (destinationCache && Date.now() - destinationCache.fetchedAt < DESTINATION_CACHE_TTL_MS) {
    return destinationCache.data;
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/destinations`, {
      headers: {
        Accept: "application/json;version=2.0",
        "Accept-Language": "en-US",
        "exp-api-key": apiKey,
      },
    });
  } catch (err) {
    throw new ViatorError(
      `destinations lookup network error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ViatorError(`destinations lookup ${res.status} ${res.statusText} ${detail}`.trim());
  }
  const data = (await res.json()) as { destinations?: ViatorDestination[]; data?: ViatorDestination[] };
  const destinations = data.destinations ?? data.data ?? [];
  destinationCache = { data: destinations, fetchedAt: Date.now() };
  return destinations;
}

/**
 * Match a free-text destination (e.g. "Paris, France" or "Edinburgh, Edinburgh,
 * Scotland, United Kingdom") against Viator's destination taxonomy by its
 * leading city-name segment, preferring an exact case-insensitive name match
 * of type CITY when multiple entries share a name (e.g. a city vs a same-named
 * region). Returns null when nothing matches.
 */
function resolveDestinationId(
  destinations: ViatorDestination[],
  destination: string
): number | null {
  const cityName = destination.split(",")[0]?.trim().toLowerCase();
  if (!cityName) return null;
  const matches = destinations.filter((d) => d.name?.trim().toLowerCase() === cityName);
  if (matches.length === 0) return null;
  const best = matches.find((d) => d.type === "CITY") ?? matches[0];
  return typeof best.destinationId === "number" ? best.destinationId : null;
}

function durationLabel(d?: ViatorProduct["duration"]): string | null {
  if (!d) return null;
  if (d.label) return d.label;
  if (typeof d.fixedDurationInMinutes === "number") {
    const mins = d.fixedDurationInMinutes;
    if (mins < 60) return `${mins} min`;
    const hours = Math.round((mins / 60) * 10) / 10;
    return `${hours} hr${hours === 1 ? "" : "s"}`;
  }
  return null;
}

function bestImageUrl(images?: ViatorProduct["images"]): string | null {
  const variants = images?.[0]?.variants;
  if (!variants || variants.length === 0) return null;
  // Pick the widest variant available.
  const widest = variants.reduce((best, v) =>
    (v.width ?? 0) > (best.width ?? 0) ? v : best
  );
  return widest.url ?? null;
}

/**
 * Append the affiliate id to the outbound booking URL as a query param.
 * NOTE: confirm the exact affiliate query param name (`pid` vs `mcid` vs
 * `medium`) against Viator's affiliate linking docs before going live.
 */
function buildBookingUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  const affiliateId = process.env.VIATOR_AFFILIATE_ID;
  if (!affiliateId) return rawUrl;
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("pid", affiliateId);
    return url.toString();
  } catch {
    // Malformed URL from upstream — return as-is rather than dropping it.
    return rawUrl;
  }
}

function mapProduct(product: ViatorProduct, destination: string): MappedExperience | null {
  const provider_product_id = product.productCode;
  if (!provider_product_id) return null; // Need a stable key for upsert onConflict.

  return {
    provider: "viator",
    provider_product_id,
    title: product.title ?? "",
    category: product.category ?? product.tags?.[0] ?? null,
    rating:
      typeof product.reviews?.combinedAverageRating === "number"
        ? product.reviews.combinedAverageRating
        : null,
    review_count:
      typeof product.reviews?.totalReviews === "number"
        ? product.reviews.totalReviews
        : null,
    price_from:
      typeof product.pricing?.summary?.fromPrice === "number"
        ? product.pricing.summary.fromPrice
        : null,
    currency: product.pricing?.currency ?? null,
    duration_label: durationLabel(product.duration),
    image_url: bestImageUrl(product.images),
    description: product.description ?? null,
    destination,
    city: product.primaryDestinationName ?? product.destinations?.[0]?.name ?? null,
    country: null, // Not reliably present on the search response; left for a later enrichment pass.
    lat: typeof product.location?.latitude === "number" ? product.location.latitude : null,
    lng: typeof product.location?.longitude === "number" ? product.location.longitude : null,
    booking_url: buildBookingUrl(product.productUrl ?? product.webURL),
    source: "viator",
    fetched_at: new Date().toISOString(),
  };
}

/**
 * Build the request body for Viator's freetext product search endpoint.
 * Isolated here so field names can be corrected in one place once verified
 * against live docs — see the file-level NOTE.
 */
function buildSearchBody(opts: {
  destinationId: number;
  q?: string;
  category?: string;
  limit: number;
  offset: number;
}): Record<string, unknown> {
  const { destinationId, q, category, limit, offset } = opts;
  // Only send searchTerm for an actual free-text query/category — confirmed
  // live that defaulting it to the raw destination string (e.g. "Edinburgh,
  // Edinburgh, Scotland, United Kingdom") badly over-constrains results,
  // since Viator keyword-matches searchTerm against titles/descriptions and
  // `filtering.destination` already handles the geographic scoping. A plain
  // destination browse should omit searchTerm entirely and rely on
  // filtering.destination + pagination alone.
  const searchTerm = q?.trim() || category?.trim();
  return {
    ...(searchTerm ? { searchTerm } : {}),
    // `filtering.destination` is Viator's own numeric destination id — both a
    // free-text string and an entirely missing `filtering` object are
    // rejected live ("Invalid destination: not a number" / "Missing
    // filtering"), so this must be resolved via resolveDestinationId first.
    filtering: {
      destination: destinationId,
      ...(category ? { tags: [category] } : {}),
    },
    // Viator's pagination.start is 1-indexed (start=1 is the first record,
    // confirmed live) — offset is 0-indexed items-to-skip from the caller, so
    // convert with +1.
    pagination: {
      start: offset + 1,
      count: limit,
    },
    currency: "USD",
  };
}

/**
 * Freetext-search Viator's Partner API (Basic Access) for bookable products
 * and return them mapped to the `experiences` upsert shape. Throws
 * ViatorError on missing config / network / non-2xx so the route can degrade
 * gracefully rather than 500 — mirrors GooglePlacesError's throw conditions
 * in lib/places/google.ts.
 */
export async function searchViatorExperiences(opts: {
  destination: string;
  q?: string;
  category?: string;
  limit: number;
  offset?: number;
  center?: { lat: number; lng: number } | null;
}): Promise<MappedExperience[]> {
  const apiKey = process.env.VIATOR_API_KEY;
  if (!apiKey) throw new ViatorError("missing VIATOR_API_KEY");

  const { destination, q, category, limit, offset = 0 } = opts;

  // Viator issues separate keys for their sandbox vs production environments,
  // each only valid against its own base URL — confirmed via a live 401
  // "Invalid API Key" when a sandbox key was sent to api.viator.com (and vice
  // versa). Defaults to production now that a production key is in use;
  // override with VIATOR_API_BASE_URL="https://api.sandbox.viator.com/partner"
  // to test against sandbox instead.
  const baseUrl = process.env.VIATOR_API_BASE_URL || "https://api.viator.com/partner";

  const destinations = await fetchViatorDestinations(baseUrl, apiKey);
  const destinationId = resolveDestinationId(destinations, destination);
  if (destinationId == null) {
    throw new ViatorError(`no Viator destination match for "${destination}"`);
  }

  const body = buildSearchBody({ destinationId, q, category, limit, offset });

  let res: Response;
  try {
    // NOTE: verify endpoint path against
    // https://docs.viator.com/partner-api/technical/ before going live.
    res = await fetch(`${baseUrl}/products/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json;version=2.0",
        "Accept-Language": "en-US",
        // NOTE: confirm this is still the correct auth header name/format
        // ("exp-api-key" per documented convention) before going live.
        "exp-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ViatorError(
      `network error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ViatorError(`${res.status} ${res.statusText} ${detail}`.trim());
  }

  const data = (await res.json()) as { products?: ViatorProduct[]; data?: ViatorProduct[] };
  const products = data.products ?? data.data ?? [];
  return products
    .map((p) => mapProduct(p, destination))
    .filter((p): p is MappedExperience => p !== null);
}
