/**
 * Fomo Happenings — "Near you now" selection for Home.
 *
 * Pure derivation over the Today feed GET /api/feed already returns — no new
 * API, no extra fetch. Someone walking down the Cowgate should see "free pub
 * quiz, 400 m away, starts 19:00": today's What's on cards (plus the "Any
 * day" ones the feed pulls out of that list) and today's deals that have
 * coordinates and lie within a short walk, nearest first.
 *
 * Time labels come from the card's own data only. Most Today cards carry no
 * real clock time (a date-only row is stored at 00:00 UTC), so those read
 * "on today" — never an invented countdown.
 *
 * NOT `server-only`: the Home page that calls it is a client component.
 */
import { CITY } from "@/lib/city";
import { distanceKm, formatDistanceLabel, walkMinutes, type Coordinates } from "@/lib/geo";
import { isDateOnlyStart } from "@/lib/events/format";
import { isActiveNow, localDayDate } from "@/lib/happenings/occurrence";
import { occurrenceIsPastLocalHours } from "@/lib/happenings/local-hours";
import type { DealCardData, FeedCardData, FeedResponse } from "@/lib/happenings/feed-types";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";

/** ~19 minutes on foot at `walkMinutes`' pace — the "20-minute walk" in the empty-state copy. */
export const NEAR_RADIUS_KM = 1.5;
export const NEAR_LIMIT = 8;
/** Further than this from the city centre, "near me" can't mean anything in Fomo's catalogue. */
export const OUTSIDE_CITY_KM = 15;

/** A start with no `ends_at` is assumed to run this long — same default as lib/events/format.ts and occurrence.ts. */
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

export interface NearNowItem {
  card: FeedCardData;
  distanceKm: number;
  walkMinutes: number;
  /** "starts 19:00" / "on until 22:00" / "on today". */
  timeLabel: string;
  /** "450 m · 6 min walk · starts 19:00" — the card's reason line. */
  reason: string;
}

export type NearNowResult = { status: "ok"; items: NearNowItem[] } | { status: "outside_city"; items: [] };

/** Picks the fields a card's time and place come from, whatever its shape. */
interface CardFacts {
  coords: Coordinates | null;
  /** Real (non-midnight) start instant, ms. */
  startMs: number | null;
  /** Real (non-midnight) end instant, ms. */
  endMs: number | null;
  /** First and last local day of this card's own span, when known. */
  dayDate: string | null;
  lastDayDate: string | null;
  /** Venue hours note for the happening behind the card, if any. */
  timeNote: string | null;
}

function coordsOf(row: { lat: number | null; lng: number | null }): Coordinates | null {
  return typeof row.lat === "number" && typeof row.lng === "number" ? { lat: row.lat, lng: row.lng } : null;
}

/** A real clock instant, or null for a missing, malformed or date-only (00:00 UTC) value. */
function realInstantMs(iso: string | null | undefined): number | null {
  if (!iso || isDateOnlyStart(iso)) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function happeningFacts(h: Happening, occ: { startsAt: string | null; endsAt: string | null; dayDate: string; lastDayDate: string }): CardFacts {
  return {
    coords: coordsOf(h),
    startMs: realInstantMs(occ.startsAt),
    endMs: realInstantMs(occ.endsAt),
    dayDate: occ.dayDate,
    lastDayDate: occ.lastDayDate,
    timeNote: h.time_note ?? null,
  };
}

function eventFacts(e: EventItem, timeZone: string): CardFacts {
  const startDay = localDayDate(new Date(e.starts_at), timeZone);
  return {
    coords: coordsOf(e),
    startMs: realInstantMs(e.starts_at),
    endMs: realInstantMs(e.ends_at),
    dayDate: startDay,
    lastDayDate: e.ends_at ? localDayDate(new Date(e.ends_at), timeZone) : startDay,
    timeNote: null,
  };
}

function cardFacts(card: FeedCardData, timeZone: string): CardFacts {
  switch (card.kind) {
    case "happening":
      return happeningFacts(card.happening, card.occurrence);
    case "event":
      return eventFacts(card.event, timeZone);
    case "series":
      // A series' members are at different places; the lead's is the one
      // its card shows, so that's the one we measure to.
      return happeningFacts(card.lead, card.occurrence);
    case "recurring":
      return card.lead.kind === "happening"
        ? happeningFacts(card.lead.happening, card.lead.occurrence)
        : eventFacts(card.lead.event, timeZone);
  }
}

/** "19:00" in `timeZone`. */
function clock(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(ms));
}

/**
 * The card's time line, from its own data only: a real start later today →
 * "starts 19:00"; else a real end still ahead → "on until 22:00"; else
 * "on today". Returns null when the card has already finished (the feed may
 * have been cached since before it ended).
 */
export function nearTimeLabel(facts: Pick<CardFacts, "startMs" | "endMs">, now: Date, timeZone: string): string | null {
  const nowMs = now.getTime();
  const { startMs, endMs } = facts;
  if (endMs !== null && endMs <= nowMs) return null;
  if (endMs === null && startMs !== null && startMs + DEFAULT_DURATION_MS <= nowMs) return null;
  if (startMs !== null && startMs > nowMs && localDayDate(new Date(startMs), timeZone) === localDayDate(now, timeZone)) {
    return `starts ${clock(startMs, timeZone)}`;
  }
  // 23:59 is how sources say "end of the day", not a real closing time.
  if (endMs !== null && localDayDate(new Date(endMs), timeZone) === localDayDate(now, timeZone) && clock(endMs, timeZone) !== "23:59") {
    return `on until ${clock(endMs, timeZone)}`;
  }
  return "on today";
}

function nearItem(card: FeedCardData, facts: CardFacts, from: Coordinates, now: Date, timeZone: string, today: string): NearNowItem | null {
  if (!facts.coords) return null;
  if (facts.dayDate && facts.dayDate > today) return null;
  if (facts.lastDayDate && facts.lastDayDate < today) return null;
  if (facts.timeNote && occurrenceIsPastLocalHours(facts.timeNote, today, now, timeZone)) return null;
  const km = distanceKm(from, facts.coords);
  if (km > NEAR_RADIUS_KM) return null;
  const timeLabel = nearTimeLabel(facts, now, timeZone);
  if (!timeLabel) return null;
  const minutes = Math.max(1, walkMinutes(km));
  return {
    card,
    distanceKm: km,
    walkMinutes: minutes,
    timeLabel,
    reason: `${formatDistanceLabel(km)} · ${minutes} min walk · ${timeLabel}`,
  };
}

function dealsOf(feed: Pick<FeedResponse, "deals">): DealCardData[] {
  return [...feed.deals.venueGroups.flatMap((g) => g.offers), ...feed.deals.singles];
}

function itemId(card: FeedCardData): string {
  if (card.kind === "happening") return `happening:${card.happening.id}`;
  if (card.kind === "event") return `event:${card.event.id}`;
  return `${card.kind}:${card.key}`;
}

/**
 * Today's cards and deals within NEAR_RADIUS_KM of `coords`, nearest first,
 * at most NEAR_LIMIT. `feed` must be the `window=now` feed. Returns
 * `outside_city` when `coords` is more than OUTSIDE_CITY_KM from Edinburgh.
 */
export function nearNow(
  feed: Pick<FeedResponse, "whatsOn" | "anyDay" | "deals">,
  coords: Coordinates,
  now: Date,
  timeZone: string = CITY.timezone
): NearNowResult {
  if (distanceKm(coords, CITY.center) > OUTSIDE_CITY_KM) return { status: "outside_city", items: [] };

  const today = localDayDate(now, timeZone);
  const seen = new Set<string>();
  const items: NearNowItem[] = [];
  const add = (card: FeedCardData, facts: CardFacts = cardFacts(card, timeZone)) => {
    const id = itemId(card);
    if (seen.has(id)) return;
    const item = nearItem(card, facts, coords, now, timeZone, today);
    if (!item) return;
    seen.add(id);
    items.push(item);
  };

  for (const card of feed.whatsOn[0]?.cards ?? []) add(card);
  for (const card of feed.anyDay?.cards ?? []) add(card);
  for (const deal of dealsOf(feed)) {
    // A deal's occurrence is its soonest one when the feed was built, which
    // may not be today (a Tuesday offer on a Monday, or a feed cached since
    // yesterday) — ask the rule itself, and drop the occurrence's days.
    if (!isActiveNow(deal.happening, now, timeZone)) continue;
    const card: FeedCardData = { kind: "happening", happening: deal.happening, occurrence: deal.occurrence };
    add(card, { ...cardFacts(card, timeZone), dayDate: null, lastDayDate: null });
  }

  items.sort((a, b) => a.distanceKm - b.distanceKm);
  return { status: "ok", items: items.slice(0, NEAR_LIMIT) };
}
