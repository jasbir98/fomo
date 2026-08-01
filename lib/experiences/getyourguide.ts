// Server-side GetYourGuide Partner API adapter for the Experiences feature.
// Fetches bookable tours/activities for a destination and maps them into the
// shape used to upsert into the `experiences` table.
//
// IMPORTANT: the user has NOT yet completed GetYourGuide partner registration.
// GetYourGuide's Partner API requires contacting them for access, and even
// their "Basic API" tier has a 100k-monthly-visits minimum this app won't
// meet yet. So this adapter degrades to a clean no-op (returns []) whenever
// its required env vars are missing, instead of throwing — see the early
// return in searchGetYourGuideExperiences below. This lets the Experiences
// feature ship and work today on the Viator adapter alone; GetYourGuide
// activates itself automatically the moment real credentials are dropped in,
// with no code changes needed.
import "server-only";

// A live-fetched tour mapped to the `experiences` upsert shape. Mirrors the
// `Experience` DB row minus `id` / `created_at` (the DB fills those in).
// Defined locally (not imported from the sibling Viator adapter) so either
// provider adapter can be deleted/rewritten independently.
export interface MappedExperience {
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
  source: string | null;
  fetched_at: string | null;
}

/** Thrown when GetYourGuide returns a non-2xx or the request otherwise fails
 * once credentials are present. Never thrown for the missing-credentials
 * case — that's an intentional no-op, not a failure (see searchGetYourGuideExperiences). */
export class GetYourGuideError extends Error {}

// Raw shape of a single tour from the GetYourGuide Partner API search
// endpoint. Field names are best-effort guesses based on GYG's documented
// conventions — see the NOTE on buildSearchParams below for what needs
// verifying once partner access is granted.
interface GetYourGuideTour {
  tour_id?: string | number;
  title?: string;
  category?: string;
  abstract?: string;
  rating?: number;
  number_of_ratings?: number;
  price?: { amount?: number; currency?: string };
  duration?: string;
  pictures?: { url_template?: string }[];
  location?: { city?: string; country?: string; lat?: number; lng?: number };
  url?: string;
}

/**
 * Build the query params for GetYourGuide's Partner API tour search.
 *
 * `currency` and `cnt_language` are REQUIRED by the live API (confirmed via a
 * real 400 response: "currency: This value is missing." / "cnt_language:
 * This value is missing.") — default to USD/en, overridable via
 * GETYOURGUIDE_CURRENCY / GETYOURGUIDE_LANGUAGE env vars.
 *
 * NOTE: verify endpoint path, auth header, and remaining query param names
 * against https://integrator.getyourguide.com/documentation/overview once
 * partner API access is granted — built from documented conventions, not a
 * live-tested response. Specifically still unverified:
 *   - whether search is keyed by free-text `q` vs a resolved `cnt_id`
 *     (GYG location/city id) — this uses `q` as a placeholder.
 *   - the exact `category` filter param name/values.
 *   - the exact partner/affiliate id param name for outbound booking links
 *     (used as "partner_id" below as a placeholder).
 */
function buildSearchParams(opts: {
  destination: string;
  q?: string;
  category?: string;
  limit: number;
  offset: number;
  partnerId: string;
}): URLSearchParams {
  const { destination, q, category, limit, offset, partnerId } = opts;
  const params = new URLSearchParams({
    q: q?.trim() || destination,
    limit: String(limit),
    partner_id: partnerId,
    currency: process.env.GETYOURGUIDE_CURRENCY || "USD",
    cnt_language: process.env.GETYOURGUIDE_LANGUAGE || "en",
  });
  // NOTE: `offset` param name/semantics unverified against a live response
  // (this adapter is still blocked on an invalid access token) — placeholder
  // for pagination support, confirm once credentials work.
  if (offset > 0) params.set("offset", String(offset));
  if (category) params.set("category", category);
  return params;
}

/**
 * Append the partner/affiliate id to a GetYourGuide tour URL so bookings are
 * attributed to this account. Placeholder param name — confirm against GYG's
 * affiliate link documentation once partner access is granted.
 */
function buildBookingUrl(tourUrl: string, partnerId: string): string {
  try {
    const url = new URL(tourUrl);
    url.searchParams.set("partner_id", partnerId);
    return url.toString();
  } catch {
    // Fall back to the raw URL if it's not a valid absolute URL.
    return tourUrl;
  }
}

function mapTour(
  tour: GetYourGuideTour,
  destination: string,
  partnerId: string
): MappedExperience | null {
  const id = tour.tour_id;
  if (id === undefined || id === null) return null; // Need a stable key for upsert onConflict.
  const image_url = tour.pictures?.[0]?.url_template
    ? tour.pictures[0].url_template!.replace("{width}x{height}", "800x600")
    : null;
  return {
    provider: "getyourguide",
    provider_product_id: String(id),
    title: tour.title ?? "",
    category: tour.category ?? null,
    rating: typeof tour.rating === "number" ? tour.rating : null,
    review_count:
      typeof tour.number_of_ratings === "number" ? tour.number_of_ratings : null,
    price_from:
      typeof tour.price?.amount === "number" ? tour.price.amount : null,
    currency: tour.price?.currency ?? null,
    duration_label: tour.duration ?? null,
    image_url,
    description: tour.abstract ?? null,
    destination,
    city: tour.location?.city ?? null,
    country: tour.location?.country ?? null,
    lat: typeof tour.location?.lat === "number" ? tour.location.lat : null,
    lng: typeof tour.location?.lng === "number" ? tour.location.lng : null,
    booking_url: tour.url ? buildBookingUrl(tour.url, partnerId) : null,
    source: "getyourguide",
    fetched_at: new Date().toISOString(),
  };
}

/**
 * Search GetYourGuide's Partner API for bookable tours/activities and return
 * them mapped to the `experiences` upsert shape.
 *
 * Degrades to a clean no-op ([]) whenever GETYOURGUIDE_API_KEY or
 * GETYOURGUIDE_PARTNER_ID is missing — this is the *expected* current state
 * (partner registration is pending; even GYG's Basic API tier requires a
 * 100k-monthly-visits minimum this app doesn't meet yet), not an error
 * condition. Do NOT throw here. Once both env vars are set, this activates
 * automatically with no code changes.
 *
 * Once credentials are present, throws GetYourGuideError on network error /
 * non-2xx so the caller can decide how to handle a real request failure.
 */
export async function searchGetYourGuideExperiences(opts: {
  destination: string;
  q?: string;
  category?: string;
  limit: number;
  offset?: number;
  center?: { lat: number; lng: number } | null;
}): Promise<MappedExperience[]> {
  const apiKey = process.env.GETYOURGUIDE_API_KEY;
  const partnerId = process.env.GETYOURGUIDE_PARTNER_ID;

  // Intentional degrade path (not an error): partner registration is pending,
  // so these env vars won't be set in production yet. Return [] so the
  // Experiences feature works today on Viator alone.
  if (!apiKey || !partnerId) return [];

  const { destination, q, category, limit, offset = 0 } = opts;
  const params = buildSearchParams({ destination, q, category, limit, offset, partnerId });

  // NOTE: verify endpoint path, auth header, and query param names against
  // https://integrator.getyourguide.com/documentation/overview once partner
  // API access is granted — built from documented conventions, not a
  // live-tested response.
  let res: Response;
  try {
    res = await fetch(`https://api.getyourguide.com/1/tours?${params.toString()}`, {
      method: "GET",
      headers: {
        "X-ACCESS-TOKEN": apiKey,
        Accept: "application/json",
      },
    });
  } catch (err) {
    throw new GetYourGuideError(
      `network error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GetYourGuideError(
      `${res.status} ${res.statusText} ${detail}`.trim()
    );
  }

  const data = (await res.json()) as { data?: GetYourGuideTour[] };
  const tours = data.data ?? [];
  return tours
    .map((t) => mapTour(t, destination, partnerId))
    .filter((t): t is MappedExperience => t !== null);
}
