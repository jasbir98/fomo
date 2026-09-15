// Server-side Google Places API (New) Autocomplete + Place Details for
// Explore's search dropdown (app/api/places/autocomplete/route.ts,
// app/api/places/resolve/route.ts). Same fetch/error conventions as
// lib/places/google.ts's Text Search helper — a dedicated module rather than
// folding these in there since Autocomplete/Details are a different Google
// endpoint family (session-tokened, no field-mask-driven upsert mapping).
import "server-only";

/** Thrown when Google returns a non-2xx or the request otherwise fails. */
export class GooglePlacesAutocompleteError extends Error {}

export interface AutocompleteSuggestion {
  placeId: string;
  /** structuredFormat.mainText.text — the place name. */
  primary: string;
  /** structuredFormat.secondaryText.text — usually the locality/address. */
  secondary: string | null;
}

interface GoogleAutocompleteSuggestion {
  placePrediction?: {
    placeId?: string;
    structuredFormat?: {
      mainText?: { text?: string };
      secondaryText?: { text?: string };
    };
  };
}

/**
 * Places Autocomplete (New) — up to 5 suggestions biased to `center`,
 * restricted to GB. `sessionToken` should be the same token used for the
 * eventual `resolvePlaceDetails` call (Google bills autocomplete+details as
 * one session when tokened together). Throws on network/non-2xx; the route
 * handler is responsible for turning that into a degraded 200.
 */
export async function autocompletePlaces(opts: {
  input: string;
  sessionToken: string;
  center: { lat: number; lng: number };
}): Promise<AutocompleteSuggestion[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new GooglePlacesAutocompleteError("missing GOOGLE_PLACES_API_KEY");

  const { input, sessionToken, center } = opts;
  const body = {
    input,
    sessionToken,
    locationBias: {
      circle: {
        center: { latitude: center.lat, longitude: center.lng },
        radius: 20000,
      },
    },
    includedRegionCodes: ["gb"],
  };

  let res: Response;
  try {
    res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new GooglePlacesAutocompleteError(
      `network error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GooglePlacesAutocompleteError(`${res.status} ${res.statusText} ${detail}`.trim());
  }

  const data = (await res.json()) as { suggestions?: GoogleAutocompleteSuggestion[] };
  const out: AutocompleteSuggestion[] = [];
  for (const s of data.suggestions ?? []) {
    const pred = s.placePrediction;
    const placeId = pred?.placeId;
    const primary = pred?.structuredFormat?.mainText?.text;
    if (!placeId || !primary) continue;
    out.push({ placeId, primary, secondary: pred?.structuredFormat?.secondaryText?.text ?? null });
  }
  return out.slice(0, 5);
}

export interface ResolvedGooglePlace {
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

/**
 * Place Details (New) for a single `placeId` — the minimal field mask
 * Explore's resolve card needs. Pass the same `sessionToken` the
 * autocomplete call used to close out that billing session.
 */
export async function resolvePlaceDetails(opts: {
  placeId: string;
  sessionToken?: string;
}): Promise<ResolvedGooglePlace> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new GooglePlacesAutocompleteError("missing GOOGLE_PLACES_API_KEY");

  const { placeId, sessionToken } = opts;
  const qs = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : "";

  let res: Response;
  try {
    res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${qs}`, {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "id,displayName,formattedAddress,location",
      },
    });
  } catch (err) {
    throw new GooglePlacesAutocompleteError(
      `network error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GooglePlacesAutocompleteError(`${res.status} ${res.statusText} ${detail}`.trim());
  }

  const data = (await res.json()) as {
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
  };

  return {
    name: data.displayName?.text ?? null,
    address: data.formattedAddress ?? null,
    lat: typeof data.location?.latitude === "number" ? data.location.latitude : null,
    lng: typeof data.location?.longitude === "number" ? data.location.longitude : null,
  };
}
