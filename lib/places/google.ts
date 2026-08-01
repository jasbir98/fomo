// Server-side Google Places API (New) Text Search for the /api/places route.
// Fetches POIs for a destination + optional category, and maps them into the
// shape used to upsert into the `places` table.
import "server-only";
import type { Center } from "./geocode";

/** The place categories the map UI can request. */
export type PlaceCategory = "food" | "photo" | "lockers" | "transport";

const CATEGORY_SLUGS: PlaceCategory[] = [
  "food",
  "photo",
  "lockers",
  "transport",
];

/** Narrow an arbitrary query slug to a known PlaceCategory (or undefined). */
export function normalizeCategory(
  raw: string | null | undefined
): PlaceCategory | undefined {
  if (!raw) return undefined;
  const slug = raw.toLowerCase().trim();
  return (CATEGORY_SLUGS as string[]).includes(slug)
    ? (slug as PlaceCategory)
    : undefined;
}

/**
 * Build the Text Search query string. When `q` (free-text search) is present,
 * it drives the query — biased by destination for locality — instead of the
 * category+destination mix.
 */
export function buildTextQuery(
  destination: string,
  category?: PlaceCategory,
  q?: string
): string {
  const trimmedQ = q?.trim();
  if (trimmedQ) return `${trimmedQ} in ${destination}`;
  switch (category) {
    case "food":
      return `restaurants in ${destination}`;
    case "photo":
      return `scenic viewpoints and landmarks in ${destination}`;
    case "lockers":
      return `coin lockers and luggage storage in ${destination}`;
    case "transport":
      return `train and subway stations in ${destination}`;
    default:
      return `top tourist attractions in ${destination}`;
  }
}

// Google's priceLevel is an enum string in the New API; map to an int 0–4.
const PRICE_LEVEL_MAP: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

function mapPriceLevel(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  return raw in PRICE_LEVEL_MAP ? PRICE_LEVEL_MAP[raw] : null;
}

// Raw shape of a single place from the New Places API (fields we request).
interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  priceLevel?: string;
  primaryType?: string;
  types?: string[];
  photos?: { name?: string }[];
  addressComponents?: { shortText?: string; types?: string[] }[];
}

// A live-fetched place mapped to the `places` upsert shape. Not a full Place
// row — the DB fills id / defaults; the route builds a Place from this either
// via the upsert-returned row or (in fallback) synthetically.
export interface MappedPlace {
  google_place_id: string;
  name: string | null;
  category: string | null;
  rating: number | null;
  image_url: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  price_level: number | null;
  // ISO 3166-1 alpha-2 (e.g. "JP", "FR"), read from Google's addressComponents.
  // Explicitly set (even when null) so this always overrides the `places`
  // table's `country default 'JP'` column default — see fix note below.
  country: string | null;
  destination: string;
  source: string;
  fetched_at: string;
}

function humanizeType(raw: string): string {
  // Google types are snake_case slugs like "tourist_attraction".
  return raw.replace(/_/g, " ").trim();
}

/**
 * Resolve a Places (New) photo resource name (e.g.
 * "places/ABC123/photos/XYZ") to a publicly loadable image URL via the Photo
 * Media endpoint. Uses `skipHttpRedirect=true` so Google returns JSON with a
 * `photoUri` instead of a 302 — that URI is a plain googleusercontent.com
 * link the client can load directly in an <img>, with no API key attached
 * (the key never leaves the server). Returns null on any failure so a photo
 * lookup issue never fails the whole search.
 */
async function resolvePhotoUrl(
  photoName: string,
  apiKey: string
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=800&skipHttpRedirect=true`,
      { headers: { "X-Goog-Api-Key": apiKey } }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { photoUri?: string };
    return data.photoUri ?? null;
  } catch {
    return null;
  }
}

async function mapPlace(
  place: GooglePlace,
  destination: string,
  apiKey: string
): Promise<MappedPlace | null> {
  const id = place.id;
  if (!id) return null; // Need a stable key for upsert onConflict.
  const typeSlug = place.primaryType ?? place.types?.[0] ?? null;
  const photoName = place.photos?.[0]?.name;
  const image_url = photoName ? await resolvePhotoUrl(photoName, apiKey) : null;
  const country =
    place.addressComponents?.find((c) => c.types?.includes("country"))
      ?.shortText ?? null;
  return {
    google_place_id: id,
    name: place.displayName?.text ?? null,
    category: typeSlug ? humanizeType(typeSlug) : null,
    rating: typeof place.rating === "number" ? place.rating : null,
    image_url,
    lat:
      typeof place.location?.latitude === "number"
        ? place.location.latitude
        : null,
    lng:
      typeof place.location?.longitude === "number"
        ? place.location.longitude
        : null,
    address: place.formattedAddress ?? null,
    price_level: mapPriceLevel(place.priceLevel),
    country,
    destination,
    source: "google",
    fetched_at: new Date().toISOString(),
  };
}

// Minimal field mask — cost is billed by the highest field tier requested,
// so keep this tight. `photos` and `addressComponents` were added to fix two
// real bugs: (1) every live-Google place previously had image_url hardcoded
// to null (photos need this separate field + a Photo Media fetch — see
// resolvePhotoUrl above), and (2) every live-Google place silently inherited
// the `places.country` column's `default 'JP'` (a holdover from the Japan
// pilot) because nothing set it explicitly — confirmed via a live search for
// "Paris, France", which returned country: "JP" on every result.
const FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location," +
  "places.rating,places.priceLevel,places.primaryType,places.types," +
  "places.photos,places.addressComponents";

/** Thrown when Google returns a non-2xx or the request otherwise fails. */
export class GooglePlacesError extends Error {}

/**
 * Text-search Google Places (New) for POIs and return them mapped to the
 * upsert shape. Throws GooglePlacesError on network / non-2xx so the route can
 * fall back to seed data. The caller guarantees the API key exists.
 */
export async function searchPlaces(opts: {
  destination: string;
  category?: PlaceCategory;
  limit: number;
  center: Center | null;
  q?: string;
}): Promise<MappedPlace[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new GooglePlacesError("missing GOOGLE_PLACES_API_KEY");

  const { destination, category, limit, center, q } = opts;

  const body: Record<string, unknown> = {
    textQuery: buildTextQuery(destination, category, q),
    maxResultCount: limit,
  };
  if (center) {
    body.locationBias = {
      circle: {
        center: { latitude: center.lat, longitude: center.lng },
        radius: 5000,
      },
    };
  }

  let res: Response;
  try {
    res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new GooglePlacesError(
      `network error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GooglePlacesError(
      `${res.status} ${res.statusText} ${detail}`.trim()
    );
  }

  const data = (await res.json()) as { places?: GooglePlace[] };
  const places = data.places ?? [];
  const mapped = await Promise.all(
    places.map((p) => mapPlace(p, destination, apiKey))
  );
  return mapped.filter((p): p is MappedPlace => p !== null);
}
