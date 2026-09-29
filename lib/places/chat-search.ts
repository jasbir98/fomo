/**
 * Google Places (New) lookup for Ask Fomo's `find_places` tool (server-only).
 *
 * Deliberately separate from lib/places/google.ts's `searchPlaces`: that one
 * fetches a photo per place for the map, which is far too costly per chat
 * turn. This asks Google for one small field mask, maps it into the compact
 * `ChatPlace` the chat renders, and caches results in memory so a repeated
 * question doesn't pay for a second lookup. Throws on any failure — the
 * caller (app/api/chat/route.ts) turns that into an error tool_result.
 */
import "server-only";
import { CITY } from "@/lib/city";
import { safeHttpUrl } from "@/lib/http/safe-url";
import type { ChatPlace } from "@/lib/fomo-ai";

export type { ChatPlace };

export interface ChatPlaceSearch {
  query: string;
  area?: string | null;
  openNow?: boolean | null;
  /** 1-4: include every price level up to and including this one. */
  maxPrice?: number | null;
}

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.shortFormattedAddress",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.priceRange",
  "places.googleMapsUri",
  "places.currentOpeningHours.openNow",
  "places.primaryTypeDisplayName",
  "places.reviewSummary",
  "places.generativeSummary",
].join(",");

const MAX_RESULTS = 6;
const BIAS_RADIUS_METRES = 8000;
const TIMEOUT_MS = 8000;
const SUMMARY_MAX_CHARS = 140;

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const cache = new Map<string, { at: number; places: ChatPlace[] }>();

const PRICE_LEVELS = [
  "PRICE_LEVEL_INEXPENSIVE",
  "PRICE_LEVEL_MODERATE",
  "PRICE_LEVEL_EXPENSIVE",
  "PRICE_LEVEL_VERY_EXPENSIVE",
] as const;

const PRICE_LEVEL_NUMBER: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

interface GoogleMoney {
  currencyCode?: string;
  units?: string;
  nanos?: number;
}

interface GoogleText {
  text?: string;
}

interface GoogleChatPlace {
  id?: string;
  displayName?: GoogleText;
  shortFormattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  priceRange?: { startPrice?: GoogleMoney; endPrice?: GoogleMoney };
  googleMapsUri?: string;
  currentOpeningHours?: { openNow?: boolean };
  primaryTypeDisplayName?: GoogleText;
  reviewSummary?: { text?: GoogleText; disclosureText?: GoogleText };
  generativeSummary?: { overview?: GoogleText; disclosureText?: GoogleText };
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function cacheKey(args: ChatPlaceSearch): string {
  return JSON.stringify([
    normalize(args.query),
    normalize(args.area),
    args.openNow === true,
    args.maxPrice ?? null,
  ]);
}

function whole(money: GoogleMoney | undefined): number | null {
  if (!money || money.currencyCode !== "GBP" || typeof money.units !== "string") return null;
  const n = Number(money.units);
  return Number.isFinite(n) ? n : null;
}

function priceTextFor(place: GoogleChatPlace, level: number | null): string | null {
  const start = whole(place.priceRange?.startPrice);
  const end = whole(place.priceRange?.endPrice);
  if (start !== null && end !== null) return `£${start}–${end}`;
  if (start !== null) return `£${start}+`;
  if (level !== null && level >= 1) return "£".repeat(level);
  return null;
}

/** First paragraph, single-spaced, capped at ~140 chars on a word boundary. */
function trimSummary(raw: string | undefined): string | null {
  const first = (raw ?? "").split(/\n+/)[0]?.replace(/\s+/g, " ").trim();
  if (!first) return null;
  if (first.length <= SUMMARY_MAX_CHARS) return first;
  const cut = first.slice(0, SUMMARY_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > 80 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

function mapPlace(raw: GoogleChatPlace): ChatPlace | null {
  const id = typeof raw.id === "string" ? raw.id : null;
  const name = raw.displayName?.text?.trim();
  if (!id || !name) return null;

  const priceLevel =
    typeof raw.priceLevel === "string" && raw.priceLevel in PRICE_LEVEL_NUMBER
      ? PRICE_LEVEL_NUMBER[raw.priceLevel]
      : null;

  // Prefer the review summary (what people say); fall back to Google's own
  // generative overview. The disclosure travels with whichever was used.
  const reviewText = trimSummary(raw.reviewSummary?.text?.text);
  const summary = reviewText ?? trimSummary(raw.generativeSummary?.overview?.text);
  const disclosure = reviewText ? raw.reviewSummary?.disclosureText?.text : raw.generativeSummary?.disclosureText?.text;

  return {
    id,
    name,
    address: raw.shortFormattedAddress?.trim() || null,
    rating: typeof raw.rating === "number" ? raw.rating : null,
    ratingCount: typeof raw.userRatingCount === "number" ? raw.userRatingCount : null,
    priceLevel,
    priceText: priceTextFor(raw, priceLevel),
    openNow: typeof raw.currentOpeningHours?.openNow === "boolean" ? raw.currentOpeningHours.openNow : null,
    type: raw.primaryTypeDisplayName?.text?.trim() || null,
    summary,
    summaryDisclosure: summary ? disclosure?.trim() || "Summarized with Gemini" : null,
    mapsUrl: safeHttpUrl(raw.googleMapsUri),
  };
}

/** Search Google Places for venues matching a chat request. Throws on failure. */
export async function searchPlacesForChat(args: ChatPlaceSearch): Promise<ChatPlace[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY is not set");

  const query = args.query.trim();
  if (!query) throw new Error("empty query");

  const key = cacheKey(args);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.places;

  const area = args.area?.trim();
  const body: Record<string, unknown> = {
    textQuery: `${query} in ${area ? `${area}, ` : ""}${CITY.name}`,
    maxResultCount: MAX_RESULTS,
    locationBias: {
      circle: {
        center: { latitude: CITY.center.lat, longitude: CITY.center.lng },
        radius: BIAS_RADIUS_METRES,
      },
    },
    languageCode: "en",
    regionCode: "GB",
  };
  if (args.openNow) body.openNow = true;
  if (args.maxPrice && args.maxPrice >= 1 && args.maxPrice <= 4) {
    body.priceLevels = PRICE_LEVELS.slice(0, args.maxPrice);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let json: { places?: GoogleChatPlace[] };
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Places searchText failed: ${res.status}`);
    json = (await res.json()) as { places?: GoogleChatPlace[] };
  } finally {
    clearTimeout(timer);
  }

  const places = (json.places ?? []).map(mapPlace).filter((p): p is ChatPlace => p !== null);

  // Drop the oldest entries first (Map iterates in insertion order).
  cache.delete(key);
  cache.set(key, { at: Date.now(), places });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return places;
}
