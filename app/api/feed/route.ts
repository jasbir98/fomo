/**
 * Fomo Home feed — GET /api/feed?window=now|coming_up|book_early&range=all|month&price=all|cheap&at=<ISO, optional>
 *
 * RESHAPED for the Home restructure (see lib/happenings/feed-types.ts's doc
 * comment for the full before/after). Home is now five sections instead of
 * a hero + date buckets + a flat "standing deals" list:
 *
 *   hero        — unchanged in spirit: the single best live happening,
 *                 independent of `window`, scored over the full dated pool
 *                 (any kind — What's on, Deals, or Book Early candidates all
 *                 compete for this slot; whichever wins is excluded from its
 *                 own section below so nothing renders twice).
 *   whatsOn     — window-driven date buckets, empty outright for
 *                 `window=book_early` (see `FeedWindow`'s doc comment).
 *                 Every dated happening EXCEPT `kind: "deal"` (those moved to
 *                 `deals`), merged with Skiddle/Ticketmaster events —
 *                 deduped/merged against curated happenings and each other
 *                 (lib/happenings/merge-events.ts) rather than shown twice.
 *                 `price=cheap` opts back into the old hard price ceiling;
 *                 the default `price=all` shows the whole merged catalogue
 *                 regardless of price — see `whatsOnHappeningPasses`'s doc
 *                 comment and `FeedPrice`'s own doc comment in feed-types.ts.
 *   bookEarly   — always-on, independent of `window`. Ranking/labels live in
 *                 lib/happenings/book-early.ts. Home only renders it under
 *                 "Coming up" (it's a section about future on-sales, so it
 *                 has no business under a today/tomorrow tab), but the field
 *                 stays window-independent because /book-early, /deals and
 *                 /free all read this same route with `window=now` and
 *                 depend on getting the full list back.
 *   deals       — always-on, independent of `window`. Every `kind: "deal"`
 *                 happening (replaces the old recurrence-based
 *                 `standingDeals`), grouped by `place_id` into one card per
 *                 venue where it resolves, or left as a single card
 *                 otherwise. WHAT/WHO filtering happens entirely client-side
 *                 against the precomputed facets on each card — see
 *                 lib/happenings/groups.ts.
 *   freeAnyTime — unchanged.
 *
 * `window` was a three-way Now/This month/Coming up control and is now a
 * two-way Now/Coming up one, because the three overlapped: all of them
 * expanded occurrences from `now`, and both "This month" and "Coming up"
 * re-rendered the same today/tomorrow cards "Now" had just shown. The two
 * that remain partition the calendar — `now` is exactly today + tomorrow,
 * `coming_up` starts the day after — so no card can appear under both.
 * "This month" survives as `range`, which only caps `coming_up`'s lookahead
 * at the end of the current month.
 *
 * Identity comes from the session cookie (lib/supabase/server.ts) —
 * proxy.ts already 401s every /api/* call with no session before this
 * handler ever runs, but the explicit check below is kept for the same
 * belt-and-braces reason /api/now and /api/saved keep theirs.
 *
 * `at`: ISO timestamp override, for testing/scrubbing — same escape hatch as
 * GET /api/now. Defaults to the request's server time.
 *
 * ZERO-ROWS / MISSING-TABLE SAFETY — unchanged from the pre-restructure
 * route: `happenings` may not exist yet in every environment and has few
 * rows in most; lib/db/happenings.ts degrades both to `[]`, and this route
 * never throws over an empty catalog.
 */
import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { CITY, districtFromAddress } from "@/lib/city";
import { listLiveHappenings } from "@/lib/db/happenings";
import { listUpcomingEvents } from "@/lib/db/events";
import { listPlacesByCity, listPlacesByIds } from "@/lib/db/places";
import { priceSignalForEvent, WHATS_ON_PRICE_EXEMPT_CATEGORIES } from "@/lib/now/price";
import {
  localDayDate,
  addDays,
  startOfLocalDay,
  endOfLocalDay,
  nextOccurrence,
  daysUntilLastChance,
  normalizeRecurrence,
} from "@/lib/happenings/occurrence";
import {
  bucketForDayDate,
  formatPlaceCategoryLabel,
  happeningHeroScore,
  oneLinerSummary,
  shortLocationLine,
  weekendBucketTitle,
  weekendDates,
  type FeedBucketKey,
} from "@/lib/happenings/format";
import { categoryStyle } from "@/lib/happenings/category-style";
import { dealFacets } from "@/lib/happenings/groups";
import { groupHappeningsIntoSeries, seriesLookup, type HappeningSeriesGroup } from "@/lib/happenings/series";
import { dedupeProviderEvents, mergeProviderEventsIntoCards, type MergeableCard } from "@/lib/happenings/merge-events";
import {
  buildBookEarlyEventCard,
  buildBookEarlyHappeningCard,
  rankBookEarly,
  type BookEarlyCardData,
} from "@/lib/happenings/book-early";
import type { Happening, Occurrence } from "@/lib/happenings/types";
import type {
  DealCardData,
  DealsSection,
  FeedBucket,
  FeedCardData,
  FeedResponse,
  FeedWindow,
  FeedRange,
  FeedPrice,
  FreeAnyTimeItem,
  HappeningCardData,
  VenueDealGroup,
} from "@/lib/happenings/feed-types";
import { isUnauthorizedError } from "@/lib/supabase-error";
import type { Db } from "@/lib/supabase/types";
import type { Place } from "@/lib/types";
import { cachedJson, CACHE_PRIVATE_NO_STORE } from "@/lib/http/cache";

export const runtime = "nodejs";

const HERO_LOOKAHEAD_DAYS = 30;
/** Book Early's own window: candidates up to a year out (task brief), independent of the request's `window`. */
const BOOK_EARLY_LOOKAHEAD_DAYS = 366;
/** Below this many researched Book Early items, top up with provider events so the section isn't a lone card. */
const BOOK_EARLY_MIN_CURATED = 3;

function parseWindow(value: string | null): FeedWindow {
  if (value === "coming_up") return "coming_up";
  if (value === "book_early") return "book_early";
  return "now";
}

function parseRange(value: string | null): FeedRange {
  return value === "month" ? "month" : "all";
}

/** "cheap" opts back into the old hard price ceiling; anything else (including
 *  no param at all) is the honest, unfiltered merged catalogue — see
 *  lib/happenings/feed-types.ts's `FeedPrice` doc comment for why "all" is
 *  the default now, not "cheap". */
function parsePrice(value: string | null): FeedPrice {
  return value === "cheap" ? "cheap" : "all";
}

/** How far ahead the unfiltered "Coming up" window looks. */
const COMING_UP_LOOKAHEAD_DAYS = 90;

/** The last calendar day of `today`'s month, as a "YYYY-MM-DD" day string. */
function monthEndDayDate(today: string): string {
  const [y, m] = today.split("-").map(Number);
  const lastDayOfMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return addDays(`${today.slice(0, 7)}-01`, lastDayOfMonth - 1);
}

/**
 * The occurrence-expansion range for a feed window, anchored to `now`.
 *
 * The two windows are DISJOINT by construction — `now` ends at the close of
 * tomorrow and `coming_up` starts at the top of the day after — which is what
 * stops the same card rendering under both tabs. Previously every window
 * started at `now`, so today's occurrences were expanded for all three and
 * the overlap was only partly papered over by `bucketOrder` afterwards.
 *
 * `range` narrows `coming_up` only. When "month" is picked late enough that
 * the month's end is already behind `from`, this returns an inverted
 * (`to` < `from`) range rather than clamping — "this month" genuinely has
 * nothing left to show at that point, and `nextOccurrences` already treats an
 * inverted range as no results.
 *
 * `window` is typed as `Exclude<FeedWindow, "book_early">` deliberately —
 * `book_early` isn't a date window at all (see `FeedWindow`'s own doc
 * comment), it has no meaningful `{from, to}` here, and the GET handler
 * below skips calling this function entirely for it rather than letting it
 * silently fall through to the `coming_up` branch and then discarding the
 * (meaningless) result.
 */
function occurrenceWindowRange(
  window: Exclude<FeedWindow, "book_early">,
  range: FeedRange,
  now: Date,
  timeZone: string
): { from: Date; to: Date } {
  const today = localDayDate(now, timeZone);

  if (window === "now") {
    return { from: now, to: endOfLocalDay(addDays(today, 1), timeZone) };
  }

  const from = startOfLocalDay(addDays(today, 2), timeZone);
  const lastDay = range === "month" ? monthEndDayDate(today) : addDays(today, COMING_UP_LOOKAHEAD_DAYS);
  return { from, to: endOfLocalDay(lastDay, timeZone) };
}

/**
 * True for a genuinely time-limited happening — everything except an
 * "always" recurrence (permanently-free rows, which belong in the trailing
 * Free Any Time zone, never the hero or a date bucket).
 */
function isDated(h: Pick<Happening, "recurrence">): boolean {
  return normalizeRecurrence(h.recurrence).type !== "always";
}

/**
 * A happening's own `image_url` wins when it has one; otherwise borrows its
 * linked place's photo (`placesById`, batch-fetched once per request — see
 * the route's own doc comment). Returns `h` unchanged (no new object) in the
 * common case so this is cheap to map over the full happenings list.
 */
function withPlaceImageFallback(h: Happening, placesById: Map<string, Place>): Happening {
  if (h.image_url || !h.place_id) return h;
  const placeImage = placesById.get(h.place_id)?.image_url;
  return placeImage ? { ...h, image_url: placeImage } : h;
}

/** Soonest occurrence across a series' members within `[from, to]`, or null
 *  if none of them have one — mirrors `nextOccurrence`'s single-happening
 *  contract but for a whole group (see lib/happenings/series.ts). Used
 *  everywhere a series collapses onto one card: the card's own date must
 *  reflect the EARLIEST member, not arbitrarily the lead's. */
function soonestOccurrenceForMembers(members: Happening[], from: Date, to: Date, timeZone: string): Occurrence | null {
  let soonest: Occurrence | null = null;
  for (const m of members) {
    const occ = nextOccurrence(m, from, to, timeZone);
    if (!occ) continue;
    if (
      !soonest ||
      occ.dayDate < soonest.dayDate ||
      (occ.dayDate === soonest.dayDate && (occ.startsAt ?? "") < (soonest.startsAt ?? ""))
    ) {
      soonest = occ;
    }
  }
  return soonest;
}

/**
 * The one member of each series that every section links to and borrows
 * display fields (image, category, eligibility) from — the happening whose
 * own next occurrence is earliest, over a year-long lookahead so the lead
 * choice doesn't flip between a "now" request and a "coming_up" one.
 * Computed once per request and reused by every section so a series always
 * points at the same `/happening/[id]` regardless of which section it
 * appeared in.
 */
function pickSeriesLeads(groups: HappeningSeriesGroup[], now: Date, timeZone: string): Map<string, Happening> {
  const to = new Date(now.getTime() + BOOK_EARLY_LOOKAHEAD_DAYS * 86_400_000);
  const leads = new Map<string, Happening>();
  for (const g of groups) {
    let best: { happening: Happening; startMs: number } | null = null;
    for (const m of g.members) {
      const occ = nextOccurrence(m, now, to, timeZone);
      const startMs = occ
        ? occ.startsAt
          ? new Date(occ.startsAt).getTime()
          : new Date(`${occ.dayDate}T00:00:00Z`).getTime()
        : Infinity;
      if (!best || startMs < best.startMs || (startMs === best.startMs && m.id < best.happening.id)) {
        best = { happening: m, startMs };
      }
    }
    leads.set(g.key, best!.happening);
  }
  return leads;
}

/** Picks the single best hero happening, independent of the request's own window — see the route's doc comment. Scored over EVERY dated happening regardless of kind, so the hero can come from What's on, Deals, or a Book Early candidate alike. */
function pickHero(happenings: Happening[], now: Date, timeZone: string): HappeningCardData | null {
  const to = new Date(now.getTime() + HERO_LOOKAHEAD_DAYS * 86_400_000);
  let best: { card: HappeningCardData; score: number } | null = null;

  for (const h of happenings) {
    if (!isDated(h)) continue;
    const occurrence = nextOccurrence(h, now, to, timeZone);
    if (!occurrence) continue;
    const score = happeningHeroScore(h, daysUntilLastChance(occurrence, now, timeZone), now, timeZone);
    if (!best || score > best.score) {
      best = { card: { kind: "happening", happening: h, occurrence }, score };
    }
  }
  return best?.card ?? null;
}

/**
 * The "cheap" gate for What's on. Every What's on happening kind EXCEPT
 * `event` is curated free/cheap content by construction (an activity, tour,
 * festival, or dated free_access row the research pipeline only adds when
 * it's genuinely free or nominal) and always qualifies. `kind: "event"`
 * happenings (dated one-offs — gigs, fixtures — that are neither a deal nor
 * free-access) are the one kind where the curator may not have verified an
 * affordable price, and the Happening schema has no numeric ticket-price
 * column to check (only `is_free`/`saving_amount`, neither of which is a
 * final price) — so, per the task's own "unknown-price events excluded"
 * rule, only `is_free === true` events pass; everything else with unknown
 * pricing is excluded rather than guessed cheap. EXCEPT a category in
 * `WHATS_ON_PRICE_EXEMPT_CATEGORIES` (lib/now/price.ts) — sports fixtures
 * pass regardless of price, per the user's 2026-09-14 call; the card's own
 * price badge (savingBadgeLabel) still shows an honest figure or nothing.
 *
 * All of the above is now scoped to `price === "cheap"` only (the opt-in
 * What's on filter chip — see `FeedPrice`'s doc comment). Under the default
 * `"all"` there is no unknown-price exclusion left to apply: a dated,
 * non-deal happening passes regardless of its `kind` or price, because the
 * whole point of "all" is the honest, unfiltered merged catalogue.
 */
function whatsOnHappeningPasses(h: Happening, price: FeedPrice): boolean {
  if (price === "all") return true;
  if (h.kind !== "event") return true;
  if (h.category && WHATS_ON_PRICE_EXEMPT_CATEGORIES.includes(h.category)) return true;
  return h.is_free === true;
}

function bucketMeta(key: FeedBucketKey, cards: FeedCardData[]): string | null {
  if (cards.length === 0) return null;
  if (key === "today_tomorrow") return `${cards.length} active`;
  if (key === "this_weekend") {
    const allFestival = cards.every((c) => c.kind === "happening" && c.happening.kind === "festival");
    return allFestival ? "Civic Highlight" : `${cards.length} on`;
  }
  return null;
}

const BUCKET_TITLES: Record<FeedBucketKey, (now: Date, timeZone: string) => string> = {
  today_tomorrow: () => "Happening Today & Tomorrow",
  this_weekend: (now, timeZone) => {
    const { saturday, sunday } = weekendDates(now, timeZone);
    return weekendBucketTitle(saturday, sunday);
  },
  coming_up: () => "Coming Up",
};

/** Real-venue categories rank above "trivia" ones (a lone plaque, a bare
 *  street, a walking route) per the task's own note: those can still show,
 *  just not ahead of an actual place worth visiting. Checked case-
 *  insensitively against `places.category`, which is free text, not an enum. */
const TRIVIA_CATEGORIES = new Set(["viewpoint", "walking route", "street", "shopping street"]);

/** Categories that are dated/event-shaped, not "visit any time" venues — a
 *  `festival` row (Leith Festival Gala Day, Leith Jazz and Blues Festival)
 *  has actual dates and belongs in the events feed / date buckets, never a
 *  zone whose whole premise is "free, no date attached". */
const DATED_PLACE_CATEGORIES = new Set(["festival"]);

function isTriviaPlace(p: Pick<Place, "category" | "name">): boolean {
  if (p.category && TRIVIA_CATEGORIES.has(p.category.toLowerCase())) return true;
  return /\bplaque\b/i.test(p.name ?? "");
}

/**
 * Composes the trailing "Free Any Time" zone: permanently-free happenings
 * first (curated, so trusted first), then free (`price_level === 0`) live
 * `places` rows, excluding dated/event-shaped categories. Best-effort — a
 * places lookup failure degrades to happenings-only rather than failing the
 * whole feed. Series-aware (see lib/happenings/series.ts): several
 * permanently-free members of the same series collapse onto one row,
 * "N locations" in place of the usual district/venue line, linking to the
 * series lead rather than duplicating a row per location.
 */
async function buildFreeAnyTime(
  db: Db,
  happenings: Happening[],
  seriesByMemberId: Map<string, HappeningSeriesGroup>,
  seriesLeads: Map<string, Happening>,
  placesById: Map<string, Place>
): Promise<FreeAnyTimeItem[]> {
  const alwaysFree = happenings.filter((h) => !isDated(h) && h.is_free);

  const happeningItems: FreeAnyTimeItem[] = [];
  const seenSeries = new Set<string>();
  for (const h of alwaysFree) {
    const group = seriesByMemberId.get(h.id);
    if (group) {
      if (seenSeries.has(group.key)) continue;
      seenSeries.add(group.key);
      const lead = seriesLeads.get(group.key) ?? h;
      const imageUrl = lead.image_url || (lead.place_id ? placesById.get(lead.place_id)?.image_url : null) || null;
      happeningItems.push({
        kind: "happening",
        id: lead.id,
        name: group.title,
        description: oneLinerSummary(lead.summary),
        imageUrl,
        locationLine: `${group.members.length} locations`,
        category: lead.category,
        district: lead.district ?? null,
        typeLabel: categoryStyle(lead.category).label,
      });
      continue;
    }
    const imageUrl = h.image_url || (h.place_id ? placesById.get(h.place_id)?.image_url : null) || null;
    happeningItems.push({
      kind: "happening",
      id: h.id,
      name: h.title,
      description: oneLinerSummary(h.summary),
      imageUrl,
      // District/venue only — h.time_note is free-text research prose (see
      // shortLocationLine's doc comment), never fit for a card row.
      locationLine: shortLocationLine(h.district ?? h.venue_name, null),
      category: h.category,
      district: h.district ?? null,
      typeLabel: categoryStyle(h.category).label,
    });
  }

  let placeItems: FreeAnyTimeItem[] = [];
  try {
    const places = await listPlacesByCity(db, CITY.name);
    placeItems = places
      .filter((p) => p.price_level === 0 && !DATED_PLACE_CATEGORIES.has((p.category ?? "").toLowerCase()))
      .sort((a, b) => {
        const photoCmp = Number(!!b.image_url) - Number(!!a.image_url);
        if (photoCmp !== 0) return photoCmp;
        const triviaCmp = Number(isTriviaPlace(a)) - Number(isTriviaPlace(b));
        if (triviaCmp !== 0) return triviaCmp;
        const mentionCmp = (b.mention_count ?? 0) - (a.mention_count ?? 0);
        if (mentionCmp !== 0) return mentionCmp;
        const ratingCmp = (b.rating ?? 0) - (a.rating ?? 0);
        if (ratingCmp !== 0) return ratingCmp;
        return (a.name ?? "").localeCompare(b.name ?? "");
      })
      .map((p) => ({
        kind: "place",
        id: p.id,
        name: p.name ?? "Free in Edinburgh",
        description: oneLinerSummary(p.detail_line) ?? p.category,
        imageUrl: p.image_url,
        // `p.hours` is only ever kept when it's a short structured value
        // ("10am–5pm") — a free-text opening-hours research note is dropped
        // rather than wrapped onto a second card line (shortLocationLine).
        locationLine: shortLocationLine(districtFromAddress(p.address) ?? p.address, p.hours),
        category: null,
        district: districtFromAddress(p.address) ?? null,
        typeLabel: formatPlaceCategoryLabel(p.category),
      }));
  } catch (err) {
    console.error("[api/feed] free places lookup failed", err);
  }

  return [...happeningItems, ...placeItems];
}

/**
 * Every `kind: "deal"` happening, decorated with a soonest occurrence (for
 * display) and WHAT/WHO facets (for client-side filtering). Excludes a deal
 * that's both `recurrence: "always"` AND `is_free === true` — that exact
 * combination is `buildFreeAnyTime`'s own selection criterion, and the two
 * sections must stay mutually exclusive (mirrors the pre-restructure
 * `buildStandingDeals`'s identical exclusion, just expressed against `kind`
 * now instead of inferring "is this a deal" from recurrence alone).
 */
function buildDealCards(happenings: Happening[], heroId: string | null, now: Date, timeZone: string): DealCardData[] {
  const to = new Date(now.getTime() + BOOK_EARLY_LOOKAHEAD_DAYS * 86_400_000);
  const cards: DealCardData[] = [];
  for (const h of happenings) {
    if (h.kind !== "deal" || h.id === heroId) continue;
    if (!isDated(h) && h.is_free === true) continue; // → freeAnyTime only
    const occurrence = isDated(h) ? nextOccurrence(h, now, to, timeZone) : nextOccurrence(h, now, now, timeZone);
    if (!occurrence) continue;
    const { what, who } = dealFacets(h);
    cards.push({ kind: "happening", happening: h, occurrence, what, who });
  }
  return cards;
}

/** Groups deal cards by resolvable `place_id` into venue cards (task 3); everything else (city/region/national scope, or a `place_id` that didn't resolve to a live `places` row) stays a single card (task's own "offers without a venue" rule). */
async function buildDealsSection(db: Db, dealCards: DealCardData[]): Promise<DealsSection> {
  const placeIds = Array.from(new Set(dealCards.filter((c) => c.happening.place_id).map((c) => c.happening.place_id as string)));
  let placesById = new Map<string, Place>();
  if (placeIds.length > 0) {
    try {
      const places = await listPlacesByIds(db, placeIds);
      placesById = new Map(places.map((p) => [p.id, p]));
    } catch (err) {
      console.error("[api/feed] deal venue lookup failed, falling back to single cards", err);
    }
  }

  const byPlace = new Map<string, DealCardData[]>();
  const singles: DealCardData[] = [];
  for (const card of dealCards) {
    const placeId = card.happening.place_id;
    if (placeId && placesById.has(placeId)) {
      const list = byPlace.get(placeId) ?? [];
      list.push(card);
      byPlace.set(placeId, list);
    } else {
      singles.push(card);
    }
  }

  const venueGroups: VenueDealGroup[] = Array.from(byPlace.entries())
    .map(([placeId, offers]) => {
      const place = placesById.get(placeId)!;
      return {
        placeId,
        placeName: place.name ?? "Edinburgh venue",
        placeImageUrl: place.image_url,
        district: districtFromAddress(place.address),
        offers,
      };
    })
    .sort((a, b) => {
      const countCmp = b.offers.length - a.offers.length;
      if (countCmp !== 0) return countCmp;
      const savingCmp = (b.offers[0]?.happening.saving_amount ?? 0) - (a.offers[0]?.happening.saving_amount ?? 0);
      return savingCmp;
    });

  singles.sort((a, b) => {
    const priorityCmp = (b.happening.priority ?? 50) - (a.happening.priority ?? 50);
    if (priorityCmp !== 0) return priorityCmp;
    return (b.happening.saving_amount ?? -1) - (a.happening.saving_amount ?? -1);
  });

  return { venueGroups, singles };
}

/**
 * Book Early candidates (task brief, ranking superseded by the coordinator's
 * mid-build update — see lib/happenings/book-early.ts's module doc): dated
 * happenings (kind festival/event/tour/activity, or any with a
 * `booking_url`) whose next occurrence is more than 7 days out and within
 * ~12 months, that ALSO have a `booking_opens_at`, a high/medium
 * `sellout_risk`, or are a festival/event with a `booking_url`. Only when
 * fewer than BOOK_EARLY_MIN_CURATED qualify is the list topped up with the
 * soonest Skiddle/Ticketmaster events more than 14 days out with a
 * `ticket_url` (any price; Book Early is explicitly not subject to the
 * "cheap" gate).
 */
function buildBookEarly(
  happenings: Happening[],
  events: import("@/lib/types").EventItem[],
  heroId: string | null,
  now: Date,
  timeZone: string,
  seriesByMemberId: Map<string, HappeningSeriesGroup>
): BookEarlyCardData[] {
  const to = new Date(now.getTime() + BOOK_EARLY_LOOKAHEAD_DAYS * 86_400_000);
  const cards: BookEarlyCardData[] = [];
  const seenSeries = new Set<string>();

  for (const h of happenings) {
    if (h.id === heroId) continue;
    if (!isDated(h)) continue;
    const dateShaped = h.kind === "festival" || h.kind === "event" || h.kind === "tour" || h.kind === "activity" || !!h.booking_url;
    if (!dateShaped) continue;

    // A series (see lib/happenings/series.ts) qualifies for Book Early as a
    // whole the moment ANY of its members does — a per-location card would
    // just be N near-duplicates of the same "book ahead" prompt. Only the
    // first-encountered qualifying member's occurrence/tier stand in for
    // the group; the location count is folded into its sublabel below.
    const group = seriesByMemberId.get(h.id);
    if (group && seenSeries.has(group.key)) continue;

    const occurrence = nextOccurrence(h, now, to, timeZone);
    if (!occurrence) continue;
    const startMs = occurrence.startsAt ? new Date(occurrence.startsAt).getTime() : new Date(`${occurrence.dayDate}T00:00:00Z`).getTime();
    const daysAway = (startMs - now.getTime()) / 86_400_000;
    if (daysAway <= 7) continue;

    const highOrMedRisk = h.sellout_risk === "high" || h.sellout_risk === "medium";
    const majorWithBooking = (h.kind === "festival" || h.kind === "event") && !!h.booking_url;
    if (!(h.booking_opens_at != null || highOrMedRisk || majorWithBooking)) continue;

    const card = buildBookEarlyHappeningCard(h, occurrence, now, timeZone);
    if (group) {
      seenSeries.add(group.key);
      const locations = `${group.members.length} locations`;
      card.sublabel = card.sublabel ? `${card.sublabel} · ${locations}` : locations;
    }
    cards.push(card);
  }

  // Skiddle/Ticketmaster rows carry no on-sale date or sell-out signal, so on
  // their own they only prove "this is in the future" — 36 of them buried the
  // five researched items that actually sell fast (Hogmanay, Tattoo, Fringe).
  // They're a fallback for a thin curated list, never a peer of it.
  const curatedCount = cards.length;
  if (curatedCount < BOOK_EARLY_MIN_CURATED) {
    const fallback = events
      .filter((e) => !!e.ticket_url && (new Date(e.starts_at).getTime() - now.getTime()) / 86_400_000 > 14)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
      .slice(0, BOOK_EARLY_MIN_CURATED - curatedCount);
    for (const e of fallback) cards.push(buildBookEarlyEventCard(e));
  }

  return rankBookEarly(cards);
}

export async function GET(request: Request) {
  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    // Auth-gated (session cookie decides 401 vs 200) — explicit no-store so
    // no intermediary caches this per-session response.
    return cachedJson<FeedResponse>(
      {
        hero: null,
        whatsOn: [],
        bookEarly: [],
        deals: { venueGroups: [], singles: [] },
        freeAnyTime: [],
        degraded: "unauthorized",
      },
      CACHE_PRIVATE_NO_STORE
    );
  }

  const { searchParams } = new URL(request.url);
  const window = parseWindow(searchParams.get("window"));
  const range = parseRange(searchParams.get("range"));
  const price = parsePrice(searchParams.get("price"));
  const atParam = searchParams.get("at");
  const now = atParam && !Number.isNaN(Date.parse(atParam)) ? new Date(atParam) : new Date();
  const timeZone = CITY.timezone;

  try {
    const rawHappenings = await listLiveHappenings(db, CITY);

    // Batch-fetch every place a happening might borrow a photo from —
    // collected up front, over ALL happenings, so one query covers the hero,
    // What's on, series, Book early and Free Any Time alike (previously this
    // fallback only ever reached Free Any Time; the others rendered no image
    // at all for a happening with no `image_url` of its own, even when its
    // linked place had a perfectly good photo).
    const placeIdsNeeded = new Set<string>();
    for (const h of rawHappenings) {
      if (h.place_id && !h.image_url) {
        placeIdsNeeded.add(h.place_id);
      }
    }
    let placesById = new Map<string, Place>();
    if (placeIdsNeeded.size > 0) {
      try {
        const places = await listPlacesByIds(db, Array.from(placeIdsNeeded));
        placesById = new Map(places.map((p) => [p.id, p]));
      } catch (err) {
        console.error("[api/feed] place image fallback lookup failed", err);
      }
    }

    // Every section below reads from `happenings`, not `rawHappenings` — each
    // row's `image_url` is resolved once here (its own photo, else its linked
    // place's), so no section has to remember to re-apply the fallback
    // itself. `withPlaceImageFallback` is a no-op for a row that already has
    // an image or has no resolvable place, so this never overwrites a real
    // per-happening photo.
    const happenings = rawHappenings.map((h) => withPlaceImageFallback(h, placesById));

    const hero = pickHero(happenings, now, timeZone);
    const heroId = hero?.happening.id ?? null;

    // Series grouping (lib/happenings/series.ts) — collapses e.g. the three
    // parkruns into one "Parkrun · 3 locations" card wherever they'd
    // otherwise show up separately. Computed once so every section (What's
    // on, Free Any Time, Book Early) agrees on the same groups and the same
    // lead member/link.
    const seriesGroups = groupHappeningsIntoSeries(happenings);
    const seriesByMemberId = seriesLookup(seriesGroups);
    const seriesLeads = pickSeriesLeads(seriesGroups, now, timeZone);

    // Book Early replaces What's on outright rather than narrowing it (see
    // `FeedWindow`'s own doc comment) — the entire happening-card loop, the
    // `listUpcomingEvents` window query, dedupe/merge and bucketing below are
    // real work (a DB round trip, an O(n·m) fuzzy match) that nobody reads
    // when `whatsOn` is going to render as empty anyway, so it's skipped
    // outright rather than computed and discarded.
    let whatsOn: FeedBucket[] = [];
    if (window !== "book_early") {
      const { from, to } = occurrenceWindowRange(window, range, now, timeZone);

      // What's on: every dated, non-deal happening (its soonest occurrence in
      // the window), excluding the hero so it never appears twice. A series
      // member collapses onto a single card the first time any of its members
      // is encountered, dated by the soonest occurrence across every member
      // (not just that one), and links to the series' lead.
      const happeningCards: MergeableCard[] = [];
      const seenSeriesInWindow = new Set<string>();
      for (const h of happenings) {
        if (!(isDated(h) && h.kind !== "deal" && h.id !== heroId && whatsOnHappeningPasses(h, price))) continue;
        const group = seriesByMemberId.get(h.id);
        if (group) {
          if (seenSeriesInWindow.has(group.key)) continue;
          const members = group.members.filter((m) => m.id !== heroId);
          const soonest = soonestOccurrenceForMembers(members, from, to, timeZone);
          if (!soonest) continue;
          seenSeriesInWindow.add(group.key);
          happeningCards.push({
            kind: "series",
            key: group.key,
            title: group.title,
            lead: seriesLeads.get(group.key) ?? h,
            locationCount: group.members.length,
            occurrence: soonest,
          });
          continue;
        }
        const occurrence = nextOccurrence(h, from, to, timeZone);
        if (occurrence) happeningCards.push({ kind: "happening", happening: h, occurrence });
      }

      // Every event in the window is a candidate now — the old hard-coded
      // "cheap" ceiling (lib/now/price.ts's priceSignalForEvent) silently
      // dropped almost the entire Ticketmaster/Skiddle catalogue, because
      // those rows essentially never carry a `price_from` and so score
      // `null`, not "cheap". `price === "cheap"` opts back into that exact
      // old predicate (the What's on filter chip); the default "all" applies
      // no price filter at all — see `FeedPrice`'s own doc comment.
      //
      // Bounded by the window's own `from`, not `now`: on "Coming up" that's
      // the day after tomorrow, so the `limit` budget isn't spent on today's
      // events only for them to be discarded by the bucket filter below —
      // which used to be able to starve the section empty on a busy day.
      // Skipped entirely for an inverted range ("This month", selected with
      // no days left in it), which by definition matches nothing. `limit`
      // raised from 60 to 200: with the price ceiling gone by default, a busy
      // window's full catalogue is much bigger, and truncating it here would
      // arbitrarily drop rows before dedupe/merge and sorting ever see them.
      const windowEvents =
        to < from
          ? []
          : await listUpcomingEvents(db, {
              destination: CITY.name,
              from: from.toISOString(),
              to: to.toISOString(),
              limit: 200,
            });
      const priceFilteredEvents =
        price === "cheap"
          ? windowEvents.filter(
              (e) =>
                priceSignalForEvent(e) === "cheap" ||
                (e.category && WHATS_ON_PRICE_EXEMPT_CATEGORIES.includes(e.category))
            )
          : windowEvents;

      // Ticketmaster and Skiddle both regularly list the same gig, and a
      // curated `happenings` row for the same real-world event is common
      // too now that the provider catalogue isn't being filtered back out —
      // collapse both kinds of duplicate down to one card per real event
      // before turning whatever's left into `EventCardData` (see
      // lib/happenings/merge-events.ts's module doc for why/how).
      const dedupedEvents = dedupeProviderEvents(priceFilteredEvents, timeZone);
      const { cards: mergedHappeningCards, unmatchedEvents } = mergeProviderEventsIntoCards(
        happeningCards,
        dedupedEvents,
        timeZone
      );
      const eventCards: FeedCardData[] = unmatchedEvents.map((e) => ({ kind: "event" as const, event: e }));

      const allCards: FeedCardData[] = [...mergedHappeningCards, ...eventCards];

      const dayDateOf = (c: FeedCardData): string =>
        c.kind === "event" ? localDayDate(new Date(c.event.starts_at), timeZone) : c.occurrence.dayDate;
      const startAtOf = (c: FeedCardData): string =>
        c.kind === "event" ? c.event.starts_at : c.occurrence.startsAt ?? "";

      // "now" is exactly today + tomorrow; "coming_up" is everything after, so
      // `today_tomorrow` is deliberately absent from its order — that bucket
      // appearing under all three old windows was the redundancy this replaces.
      // The range itself already excludes those days (occurrenceWindowRange),
      // so this is belt-and-braces for a card whose local day lands on the
      // boundary differently than its raw timestamp suggests.
      const bucketOrder: FeedBucketKey[] =
        window === "now" ? ["today_tomorrow"] : ["this_weekend", "coming_up"];

      const grouped = new Map<FeedBucketKey, FeedCardData[]>();
      for (const card of allCards) {
        const key = bucketForDayDate(dayDateOf(card), now, timeZone);
        if (!bucketOrder.includes(key)) continue;
        const list = grouped.get(key) ?? [];
        list.push(card);
        grouped.set(key, list);
      }

      whatsOn = bucketOrder
        .map((key) => {
          const cards = (grouped.get(key) ?? []).sort((a, b) => {
            const dayCmp = dayDateOf(a).localeCompare(dayDateOf(b));
            if (dayCmp !== 0) return dayCmp;
            return startAtOf(a).localeCompare(startAtOf(b));
          });
          return { key, title: BUCKET_TITLES[key](now, timeZone), meta: bucketMeta(key, cards), cards };
        })
        .filter((bucket) => bucket.cards.length > 0);

      // "Coming Up" as a heading under the Coming up tab, directly beneath a
      // "This Weekend" heading, is the tab's own name echoed back — retitle it
      // to the relationship the user actually reads off it ("the rest, after
      // the weekend"). Only when the weekend bucket is genuinely present;
      // alone, "Coming Up" is the correct label.
      if (whatsOn.length > 1 && whatsOn[0].key === "this_weekend") {
        const rest = whatsOn.find((b) => b.key === "coming_up");
        if (rest) rest.title = "Later On";
      }
    }

    // Book Early: its own longer, window-independent event lookahead — a
    // separate query from `windowEvents` above, which is bounded to the
    // request's own (often much shorter) window.
    const bookEarlyEvents = await listUpcomingEvents(db, {
      destination: CITY.name,
      from: now.toISOString(),
      to: new Date(now.getTime() + BOOK_EARLY_LOOKAHEAD_DAYS * 86_400_000).toISOString(),
      limit: 100,
    });
    const bookEarly = buildBookEarly(happenings, bookEarlyEvents, heroId, now, timeZone, seriesByMemberId);

    const dealCards = buildDealCards(happenings, heroId, now, timeZone);
    const deals = await buildDealsSection(db, dealCards);

    const freeAnyTime = await buildFreeAnyTime(db, happenings, seriesByMemberId, seriesLeads, placesById);

    return cachedJson<FeedResponse>({ hero, whatsOn, bookEarly, deals, freeAnyTime }, CACHE_PRIVATE_NO_STORE);
  } catch (err) {
    console.error("[api/feed] failed", err);
    return cachedJson<FeedResponse>(
      {
        hero: null,
        whatsOn: [],
        bookEarly: [],
        deals: { venueGroups: [], singles: [] },
        freeAnyTime: [],
        degraded: isUnauthorizedError(err) ? "unauthorized" : undefined,
      },
      CACHE_PRIVATE_NO_STORE
    );
  }
}
