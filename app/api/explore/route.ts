/**
 * Fomo Explore — lightweight map pins for the Explore tab (server-only).
 *
 * GET /api/explore?layer=everything|places|deals|events|free&category=<comma-slugs>
 *                  &q=<text>&bbox=<minLat,minLng,maxLat,maxLng>&maxPrice=<0-4>
 *
 *   layer:    which pin types to return (default "everything" = all four).
 *   category: comma-separated lib/explore/categories.ts slugs, OR'd together
 *             — narrows place pins by free-text category substring and
 *             happening-backed pins (deal/event/free) by their enum
 *             `category`. Provider (Skiddle/Ticketmaster) event rows are
 *             NOT narrowed by this — their own `category` column is
 *             provider free text with no reliable mapping onto the Explore
 *             chip set, so a category filter simply passes every provider
 *             event through untouched rather than guessing wrong.
 *   q:        free-text title/name search, case-insensitive substring.
 *   bbox:     the map's current visible bounds ("Search this area") — when
 *             present, only pins inside it are returned; omitted, the whole
 *             city's catalogue is candidate (already city-scoped upstream:
 *             CITY.name for places, listLiveHappenings(CITY) for
 *             happenings, `destination: CITY.name` for provider events).
 *   maxPrice: place pins only, `price_level <= maxPrice` (Google's 0-4
 *             scale) — backs the "Cheap eats" collection.
 *
 * Returns `{ id, type, title, lat, lng, image, category, badge, href,
 * starts_at? }` pins (lib/explore/types.ts) — never the full Place/
 * Happening/EventItem row — so the client fetches one small payload per
 * filter change instead of three big ones. Capped at MAX_PINS total, split
 * evenly across the layers actually requested (so `layer=everything` doesn't
 * let ~3,400 places crowd out every deal/event/free pin) — a single-layer
 * request gets the full cap to itself.
 *
 * DELIBERATELY SIMPLER than app/api/feed/route.ts in two ways, both fine for
 * a map (not a card feed): no series collapsing (lib/happenings/series.ts) —
 * three parkrun locations are three separate, correctly-placed pins, not one
 * collapsed card; and no curated/provider event dedupe
 * (lib/happenings/merge-events.ts) — a gig that exists as both a curated
 * `happenings` row and a Ticketmaster row can render as two close-together
 * pins rather than one merged card. Both are Home-feed card concerns that
 * don't apply to a map of coordinates.
 */
import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { CITY } from "@/lib/city";
import { listPlacesByCity, listPlacesByIds } from "@/lib/db/places";
import { listLiveHappenings } from "@/lib/db/happenings";
import { listUpcomingEvents } from "@/lib/db/events";
import {
  nextOccurrence,
  normalizeRecurrence,
  happeningHasEnded,
} from "@/lib/happenings/occurrence";
import { isGenuineDeal } from "@/lib/happenings/groups";
import { categoryStyle } from "@/lib/happenings/category-style";
import { savingBadgeLabel, happeningTimeLabel, formatPlaceCategoryLabel } from "@/lib/happenings/format";
import { formatEventPrice, eventHasEnded } from "@/lib/events/format";
import {
  matchesPlaceCategory,
  matchesHappeningCategory,
  parseExploreCategories,
  type ExploreCategorySlug,
} from "@/lib/explore/categories";
import type { ExploreLayer, ExplorePin, ExploreResponse } from "@/lib/explore/types";
import type { Place, EventItem } from "@/lib/types";
import type { Happening } from "@/lib/happenings/types";
import { cachedJson, CACHE_MEDIUM, CACHE_PRIVATE_NO_STORE } from "@/lib/http/cache";

export const runtime = "nodejs";

const MAX_PINS = 300;
/** "Events" = next 7 days, per the task brief. */
const EVENTS_LOOKAHEAD_DAYS = 7;
/** Standing/dated deals can be valid up to a year out — mirrors app/api/feed/route.ts's own BOOK_EARLY_LOOKAHEAD_DAYS-scale window for `nextOccurrence`'s upper bound. */
const DEAL_LOOKAHEAD_DAYS = 366;

function parseLayer(value: string | null): ExploreLayer {
  if (value === "places" || value === "deals" || value === "events" || value === "free") return value;
  return "everything";
}

interface Bbox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

function parseBbox(value: string | null): Bbox | null {
  if (!value) return null;
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLat, minLng, maxLat, maxLng] = parts;
  if (minLat > maxLat || minLng > maxLng) return null;
  return { minLat, maxLat, minLng, maxLng };
}

function withinBbox(lat: number, lng: number, bbox: Bbox | null): boolean {
  if (!bbox) return true;
  return lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng;
}

function matchesQuery(title: string, q: string | null): boolean {
  if (!q) return true;
  return title.toLowerCase().includes(q.toLowerCase());
}

function matchesAnyCategory(
  categories: ExploreCategorySlug[],
  test: (slug: ExploreCategorySlug) => boolean
): boolean {
  return categories.length === 0 || categories.some(test);
}

/** A happening's own lat/lng wins; otherwise borrows its linked place's coordinates (`placesById`, batch-fetched once — mirrors app/api/feed/route.ts's `withPlaceImageFallback` pattern, just for coordinates instead of a photo). Null when neither resolves — that happening can't be pinned on a map at all. */
function resolveCoords(h: Happening, placesById: Map<string, Place>): { lat: number; lng: number } | null {
  if (h.lat != null && h.lng != null) return { lat: h.lat, lng: h.lng };
  if (h.place_id) {
    const p = placesById.get(h.place_id);
    if (p?.lat != null && p?.lng != null) return { lat: p.lat, lng: p.lng };
  }
  return null;
}

function placeBadge(p: Place): string | null {
  if (p.price_level === 0) return "Free";
  if (p.rating != null) return `★ ${p.rating.toFixed(1)}`;
  return null;
}

function placePin(p: Place): ExplorePin {
  return {
    id: p.id,
    type: "place",
    title: p.name ?? "Unnamed place",
    lat: p.lat as number,
    lng: p.lng as number,
    image: p.image_url,
    category: formatPlaceCategoryLabel(p.category) ?? "Place",
    badge: placeBadge(p),
    href: `/place/${p.id}`,
  };
}

function freePlacePin(p: Place): ExplorePin {
  return {
    id: p.id,
    type: "free",
    title: p.name ?? "Free in Edinburgh",
    lat: p.lat as number,
    lng: p.lng as number,
    image: p.image_url,
    category: formatPlaceCategoryLabel(p.category) ?? "Free",
    badge: "Free",
    href: `/place/${p.id}`,
  };
}

export async function GET(request: Request) {
  const db = await supabaseServer();
  const { searchParams } = new URL(request.url);
  const layer = parseLayer(searchParams.get("layer"));
  const categories = parseExploreCategories(searchParams.get("category"));
  const q = searchParams.get("q")?.trim() || null;
  const bbox = parseBbox(searchParams.get("bbox"));
  const rawMaxPrice = searchParams.get("maxPrice");
  const maxPriceLevel =
    rawMaxPrice != null && Number.isFinite(Number(rawMaxPrice)) ? Number(rawMaxPrice) : null;

  const now = new Date();
  const timeZone = CITY.timezone;

  const wantsPlaces = layer === "everything" || layer === "places";
  const wantsDeals = layer === "everything" || layer === "deals";
  const wantsEvents = layer === "everything" || layer === "events";
  const wantsFree = layer === "everything" || layer === "free";
  const activeLayerCount = [wantsPlaces, wantsDeals, wantsEvents, wantsFree].filter(Boolean).length;
  // A single-layer request gets the whole cap; "everything" splits it evenly
  // so ~3,400 places can't crowd out every deal/event/free pin.
  const sectionCap = Math.floor(MAX_PINS / Math.max(activeLayerCount, 1));

  try {
    // `places` (the full curated catalogue) is only needed for the Places
    // layer itself and the free-places half of the Free layer — Deals/Events
    // only ever need a targeted `listPlacesByIds` for coordinate fallback,
    // fetched separately below, so a plain `layer=deals`/`layer=events`
    // request never pays for the full places scan.
    let places: Place[] = [];
    if (wantsPlaces || wantsFree) {
      try {
        places = await listPlacesByCity(db, CITY.name);
      } catch (err) {
        console.error("[api/explore] places lookup failed", err);
      }
    }

    // `happenings` is needed for Deals, Events (curated activity/tour/
    // festival/event rows), and the happenings half of Free.
    let happenings: Happening[] = [];
    if (wantsDeals || wantsEvents || wantsFree) {
      try {
        happenings = await listLiveHappenings(db, CITY);
      } catch (err) {
        console.error("[api/explore] happenings lookup failed", err);
      }
    }

    // Coordinate fallback for happenings with a `place_id` but no lat/lng of
    // their own — one batched lookup covering every such row, same pattern
    // as the feed route's place-image fallback.
    let placesById = new Map<string, Place>();
    const placeIdsNeeded = new Set<string>();
    for (const h of happenings) {
      if (h.place_id && (h.lat == null || h.lng == null)) placeIdsNeeded.add(h.place_id);
    }
    if (placeIdsNeeded.size > 0) {
      try {
        const resolved = await listPlacesByIds(db, Array.from(placeIdsNeeded));
        placesById = new Map(resolved.map((p) => [p.id, p]));
      } catch (err) {
        console.error("[api/explore] happening coordinate lookup failed", err);
      }
    }

    // Places -----------------------------------------------------------
    const placePins: ExplorePin[] = [];
    if (wantsPlaces) {
      const candidates = places
        .filter((p) => p.lat != null && p.lng != null)
        .filter((p) => withinBbox(p.lat as number, p.lng as number, bbox))
        .filter((p) => matchesQuery(p.name ?? "", q))
        .filter((p) => matchesAnyCategory(categories, (c) => matchesPlaceCategory(p.category, c)))
        .filter((p) => maxPriceLevel == null || (p.price_level != null && p.price_level <= maxPriceLevel))
        // Best-of-city ordering when nothing else narrows it down — same
        // signal buildFreeAnyTime (app/api/feed/route.ts) ranks free places
        // by, so a capped, unfiltered "everything" view still surfaces the
        // places most worth surfacing rather than an arbitrary DB order.
        .sort((a, b) => (b.mention_count ?? 0) - (a.mention_count ?? 0) || (b.rating ?? 0) - (a.rating ?? 0));
      for (const p of candidates.slice(0, sectionCap)) placePins.push(placePin(p));
    }

    // Deals --------------------------------------------------------------
    const dealPins: ExplorePin[] = [];
    if (wantsDeals) {
      const dealTo = new Date(now.getTime() + DEAL_LOOKAHEAD_DAYS * 86_400_000);
      const candidates: { h: Happening; coords: { lat: number; lng: number }; startsAt: string | null }[] = [];
      for (const h of happenings) {
        if (h.kind !== "deal" || !isGenuineDeal(h)) continue;
        const dated = normalizeRecurrence(h.recurrence).type !== "always";
        const occurrence = dated ? nextOccurrence(h, now, dealTo, timeZone) : nextOccurrence(h, now, now, timeZone);
        if (!occurrence) continue;
        if (happeningHasEnded(h, now, timeZone)) continue; // final "no ended items" guard
        const coords = resolveCoords(h, placesById);
        if (!coords) continue;
        if (!withinBbox(coords.lat, coords.lng, bbox)) continue;
        if (!matchesQuery(h.title, q)) continue;
        if (!matchesAnyCategory(categories, (c) => matchesHappeningCategory(h.category, c))) continue;
        candidates.push({ h, coords, startsAt: occurrence.startsAt });
      }
      candidates.sort((a, b) => (b.h.priority ?? 50) - (a.h.priority ?? 50));
      for (const { h, coords, startsAt } of candidates.slice(0, sectionCap)) {
        dealPins.push({
          id: h.id,
          type: "deal",
          title: h.title,
          lat: coords.lat,
          lng: coords.lng,
          image: h.image_url,
          category: categoryStyle(h.category).label,
          badge: savingBadgeLabel(h) ?? "Deal",
          href: `/happening/${h.id}`,
          starts_at: startsAt,
        });
      }
    }

    // Free -----------------------------------------------------------------
    const freePins: ExplorePin[] = [];
    if (wantsFree) {
      const happeningCandidates: { h: Happening; coords: { lat: number; lng: number } }[] = [];
      for (const h of happenings) {
        if (normalizeRecurrence(h.recurrence).type !== "always" || h.is_free !== true) continue;
        if (happeningHasEnded(h, now, timeZone)) continue; // final "no ended items" guard
        const coords = resolveCoords(h, placesById);
        if (!coords) continue;
        if (!withinBbox(coords.lat, coords.lng, bbox)) continue;
        if (!matchesQuery(h.title, q)) continue;
        if (!matchesAnyCategory(categories, (c) => matchesHappeningCategory(h.category, c))) continue;
        happeningCandidates.push({ h, coords });
      }
      const placeCandidates = places
        .filter((p) => p.price_level === 0 && p.lat != null && p.lng != null)
        .filter((p) => withinBbox(p.lat as number, p.lng as number, bbox))
        .filter((p) => matchesQuery(p.name ?? "", q))
        .filter((p) => matchesAnyCategory(categories, (c) => matchesPlaceCategory(p.category, c)))
        .sort((a, b) => (b.mention_count ?? 0) - (a.mention_count ?? 0) || (b.rating ?? 0) - (a.rating ?? 0));

      // Curated happenings first (trusted editorial free-any-time rows),
      // then free places — same ordering rationale as buildFreeAnyTime.
      for (const { h, coords } of happeningCandidates) {
        if (freePins.length >= sectionCap) break;
        freePins.push({
          id: h.id,
          type: "free",
          title: h.title,
          lat: coords.lat,
          lng: coords.lng,
          image: h.image_url,
          category: categoryStyle(h.category).label,
          badge: "Free",
          href: `/happening/${h.id}`,
          starts_at: null,
        });
      }
      for (const p of placeCandidates) {
        if (freePins.length >= sectionCap) break;
        freePins.push(freePlacePin(p));
      }
    }

    // Events (next 7 days) ---------------------------------------------------
    const eventPins: ExplorePin[] = [];
    if (wantsEvents) {
      const eventsTo = new Date(now.getTime() + EVENTS_LOOKAHEAD_DAYS * 86_400_000);
      const DATE_SHAPED_KINDS: Happening["kind"][] = ["event", "festival", "activity", "tour"];
      const happeningCandidates: {
        h: Happening;
        coords: { lat: number; lng: number };
        startsAt: string | null;
        dayDate: string;
        lastDayDate: string;
      }[] = [];
      for (const h of happenings) {
        if (!DATE_SHAPED_KINDS.includes(h.kind)) continue;
        if (normalizeRecurrence(h.recurrence).type === "always") continue; // dated only — "always" rows live in Free
        const occurrence = nextOccurrence(h, now, eventsTo, timeZone);
        if (!occurrence) continue;
        if (happeningHasEnded(h, now, timeZone)) continue; // final "no ended items" guard
        const coords = resolveCoords(h, placesById);
        if (!coords) continue;
        if (!withinBbox(coords.lat, coords.lng, bbox)) continue;
        if (!matchesQuery(h.title, q)) continue;
        if (!matchesAnyCategory(categories, (c) => matchesHappeningCategory(h.category, c))) continue;
        happeningCandidates.push({
          h,
          coords,
          startsAt: occurrence.startsAt,
          dayDate: occurrence.dayDate,
          lastDayDate: occurrence.lastDayDate,
        });
      }

      let providerEvents: EventItem[] = [];
      try {
        providerEvents = await listUpcomingEvents(db, {
          destination: CITY.name,
          from: now.toISOString(),
          to: eventsTo.toISOString(),
          limit: 200,
        });
      } catch (err) {
        console.error("[api/explore] provider events lookup failed", err);
      }
      const providerCandidates = providerEvents
        .filter((e) => e.lat != null && e.lng != null)
        .filter((e) => withinBbox(e.lat as number, e.lng as number, bbox))
        .filter((e) => matchesQuery(e.name, q))
        .filter((e) => !eventHasEnded(e, now)); // final "no ended items" guard
      // Category chips don't narrow provider events — see this file's header.

      type EventCandidate =
        | { kind: "happening"; startsAt: string; build: () => ExplorePin }
        | { kind: "event"; startsAt: string; build: () => ExplorePin };
      const merged: EventCandidate[] = [
        ...happeningCandidates
          .filter((c) => c.startsAt != null)
          .map((c) => ({
            kind: "happening" as const,
            startsAt: c.startsAt as string,
            build: (): ExplorePin => ({
              id: c.h.id,
              type: "event",
              title: c.h.title,
              lat: c.coords.lat,
              lng: c.coords.lng,
              image: c.h.image_url,
              category: categoryStyle(c.h.category).label,
              // Real dayDate/lastDayDate from the occurrence (not
              // reconstructed from startsAt alone) — an in-progress span
              // (a months-long exhibition whose starts_at predates today)
              // otherwise badged by its original start day, which
              // happeningTimeLabel would print as a bare, dateless weekday
              // ("Sat") on a pin opened months later. See that function's
              // own "IN-PROGRESS SPANS" doc comment.
              badge:
                happeningTimeLabel(
                  { exact: true, startsAt: c.startsAt, dayDate: c.dayDate, lastDayDate: c.lastDayDate },
                  now,
                  timeZone
                ) ?? savingBadgeLabel(c.h),
              href: `/happening/${c.h.id}`,
              starts_at: c.startsAt,
            }),
          })),
        ...providerCandidates.map((e) => ({
          kind: "event" as const,
          startsAt: e.starts_at,
          build: (): ExplorePin => ({
            id: e.id,
            type: "event",
            title: e.name,
            lat: e.lat as number,
            lng: e.lng as number,
            image: e.image_url,
            category: e.category ? (formatPlaceCategoryLabel(e.category) ?? "Event") : "Event",
            badge: formatEventPrice(e) || null,
            href: `/event/${e.id}`,
            starts_at: e.starts_at,
          }),
        })),
      ];
      // Undated happening occurrences (a dated row whose `nextOccurrence`
      // resolved to a day but no exact clock time) fall out of the merge
      // above via the `startsAt != null` filter — a pin with no real start
      // time still deserves a spot, so they're appended afterwards, past
      // the soonest-first sort, capped the same as everything else.
      const undatedHappenings = happeningCandidates.filter((c) => c.startsAt == null);

      merged.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      for (const candidate of merged) {
        if (eventPins.length >= sectionCap) break;
        eventPins.push(candidate.build());
      }
      for (const c of undatedHappenings) {
        if (eventPins.length >= sectionCap) break;
        eventPins.push({
          id: c.h.id,
          type: "event",
          title: c.h.title,
          lat: c.coords.lat,
          lng: c.coords.lng,
          image: c.h.image_url,
          category: categoryStyle(c.h.category).label,
          badge: savingBadgeLabel(c.h),
          href: `/happening/${c.h.id}`,
          starts_at: null,
        });
      }
    }

    const pins = [...placePins, ...dealPins, ...eventPins, ...freePins].slice(0, MAX_PINS);
    return cachedJson<ExploreResponse>({ pins }, CACHE_MEDIUM);
  } catch (err) {
    console.error("[api/explore] failed", err);
    // Never cache a failure — the browser would keep serving an empty map.
    return cachedJson<ExploreResponse>({ pins: [], degraded: "explore-error" }, CACHE_PRIVATE_NO_STORE);
  }
}
