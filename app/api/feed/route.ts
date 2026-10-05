/**
 * Fomo Home feed — GET /api/feed?window=now|coming_up|book_early&range=all|month&price=all|cheap&at=<ISO, optional>
 *
 * RESHAPED for the Home restructure (see lib/happenings/feed-types.ts's doc
 * comment for the full before/after). Home is now five sections instead of
 * a hero + date buckets + a flat "standing deals" list:
 *
 *   hero        — the best live happening whose own occurrence actually
 *                 falls inside the request's `window` (any kind — What's on
 *                 or Deals candidates compete for this slot; whichever wins
 *                 is excluded from its own section below so nothing renders
 *                 twice). Scoped to `window` since 2026-09-27 — previously
 *                 scored over the full dated pool regardless of `window`,
 *                 which is how e.g. a "today only" happening ended up as the
 *                 hero on `coming_up` too; see `pickHero`'s own doc comment.
 *                 `null` when nothing in that window clears the hero bar —
 *                 the client falls back to a compact preview of the window's
 *                 own first few cards rather than leaving the slot empty.
 *                 EXCEPT on `window=book_early`: that tab's hero is instead
 *                 the top-ranked Book Early `kind: "happening"` card (or
 *                 null, never the global pick), flagged via
 *                 `heroKind: "book_early"` so the client knows to render the
 *                 Book Early presentation instead of Fomo Pick's.
 *   whatsOn     — one chronologically sorted bucket for `now`/`coming_up`
 *                 (was two — "This weekend" then "Later on" — for
 *                 `coming_up`; a single client-side date filter row replaces
 *                 that split, see Home), empty outright for
 *                 `window=book_early` (see `FeedWindow`'s doc comment).
 *                 Every dated happening EXCEPT `kind: "deal"` (those moved to
 *                 `deals`), merged with Skiddle/Ticketmaster events —
 *                 deduped/merged against curated happenings and each other
 *                 (lib/happenings/merge-events.ts) rather than shown twice.
 *                 `price=cheap` opts back into the old hard price ceiling;
 *                 the default `price=all` shows the whole merged catalogue
 *                 regardless of price — see `whatsOnHappeningPasses`'s doc
 *                 comment and `FeedPrice`'s own doc comment in feed-types.ts.
 *   anyDay      — the "Any day" section (lib/happenings/everyday.ts): cards from
 *                 the same pool as `whatsOn` that run essentially every day
 *                 (a walking tour that runs 7 days a week, a nightly comedy
 *                 club), pulled out so they don't top the dated list daily.
 *                 On `coming_up`, items already available today are omitted
 *                 (Today's section shows them). Null when empty/book_early.
 *   bookEarly   — always-on, independent of `window`. Ranking/labels live in
 *                 lib/happenings/book-early.ts. Home only renders it under
 *                 "Coming up" (it's a section about future on-sales, so it
 *                 has no business under the Today tab), but the field
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
 * re-rendered the same today cards "Now" had just shown. The two
 * that remain partition the calendar — `now` is exactly the rest of TODAY
 * (the "Today" tab; the URL value stays `now` for compatibility),
 * `coming_up` starts at the top of tomorrow — so no card can appear under
 * both.
 * "This month" survives as `range`, which only caps `coming_up`'s lookahead
 * at the end of the current month.
 *
 * Identity comes from the session cookie (lib/supabase/server.ts) —
 * proxy.ts already 401s every /api/* call with no session before this
 * handler ever runs, but the explicit check below is kept for the same
 * belt-and-braces reason /api/saved keeps its own.
 *
 * `at`: ISO timestamp override, for testing/scrubbing. Defaults to the
 * request's server time.
 *
 * ZERO-ROWS / MISSING-TABLE SAFETY — unchanged from the pre-restructure
 * route: `happenings` may not exist yet in every environment and has few
 * rows in most; lib/db/happenings.ts degrades both to `[]`, and this route
 * never throws over an empty catalog.
 */
import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { CITY, districtFromAddress } from "@/lib/city";
// Cached drop-ins for lib/db/{happenings,events,places} — see lib/db/cached.ts.
import { listLiveHappenings, listPlacesByCity, listPlacesByIds, listUpcomingEvents } from "@/lib/db/cached";
import { priceSignalForEvent, WHATS_ON_PRICE_EXEMPT_CATEGORIES } from "@/lib/cards/price";
import {
  localDayDate,
  addDays,
  startOfLocalDay,
  endOfLocalDay,
  nextOccurrence,
  normalizeRecurrence,
  happeningHasEnded,
} from "@/lib/happenings/occurrence";
import { eventHasEnded } from "@/lib/events/format";
import {
  formatPlaceCategoryLabel,
  oneLinerSummary,
  shortLocationLine,
  type FeedBucketKey,
} from "@/lib/happenings/format";
import { happeningRecommendationScore, eventRecommendationScore } from "@/lib/happenings/hero";
import { categoryStyle } from "@/lib/happenings/category-style";
import { dealFacets, isGenuineDeal } from "@/lib/happenings/groups";
import { groupHappeningsIntoSeries, seriesLookup, type HappeningSeriesGroup } from "@/lib/happenings/series";
import { dedupeProviderEvents, mergeProviderEventsIntoCards, normalizeText, type MergeableCard } from "@/lib/happenings/merge-events";
import { groupRecurringCards } from "@/lib/happenings/recurring";
import { everydayCardRunsOn, isEverydayCard, isEverydayRecurrence } from "@/lib/happenings/everyday";
import {
  buildBookEarlyEventCard,
  buildBookEarlyHappeningCard,
  rankBookEarly,
  type BookEarlyCardData,
  type BookEarlyHappeningCard,
} from "@/lib/happenings/book-early";
import type { Happening, HappeningCategory, Occurrence } from "@/lib/happenings/types";
import type {
  DealCardData,
  DealsSection,
  FeedBucket,
  FeedCardData,
  FeedHeroCard,
  FeedResponse,
  FeedWindow,
  FeedRange,
  FeedPrice,
  FreeAnyTimeItem,
  VenueDealGroup,
} from "@/lib/happenings/feed-types";
import { isUnauthorizedError } from "@/lib/supabase-error";
import type { Db } from "@/lib/supabase/types";
import type { EventItem, Place } from "@/lib/types";
import { cachedJson, CACHE_PRIVATE_NO_STORE } from "@/lib/http/cache";

import { parseWhoGroups, type DealWhoGroup } from "@/lib/happenings/groups";

export const runtime = "nodejs";

const HERO_LOOKAHEAD_DAYS = 30;
/** How far ahead a provider event (Skiddle/Ticketmaster) can start and still
 *  be a hero candidate — much shorter than a happening's own 30-day
 *  lookahead because an unverified provider row has no curator judgment
 *  behind it; the user's own call (task brief) restricts these to free/cheap
 *  events only, never sports-exempt-but-unpriced ones. */
const HERO_EVENT_LOOKAHEAD_DAYS = 7;
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
 * today and `coming_up` starts at the top of tomorrow — which is what
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
    // Floor stays at `now` (not start of day): things already in progress
    // (spans, exhibitions that started earlier and haven't ended) are still
    // "on today"; things that finished this morning are not.
    return { from: now, to: endOfLocalDay(today, timeZone) };
  }

  const from = startOfLocalDay(addDays(today, 1), timeZone);
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
 * Final in-memory "has this already ended" guard for a What's on card —
 * belt-and-braces, run right before every section is serialised (see the
 * GET handler below). Every card here already exists only because
 * `nextOccurrence`/`nextOccurrences` found a live occurrence for it, so this
 * is redundant in the ordinary case; it exists to catch a bug in a future
 * change to this route (a merge/dedupe step, a new code path) rather than
 * because today's construction is known to leak. A series card is checked
 * via its `lead` — an approximation (another member could theoretically
 * still be running after the lead itself ended), acceptable for a guard
 * whose job is catching gross bugs, not re-deciding series membership.
 */
function cardHasEnded(card: FeedCardData, now: Date, timeZone: string): boolean {
  if (card.kind === "event") return eventHasEnded(card.event, now);
  if (card.kind === "recurring") return cardHasEnded(card.lead, now, timeZone);
  const happening = card.kind === "series" ? card.lead : card.happening;
  return happeningHasEnded(happening, now, timeZone);
}

/**
 * A happening's own `image_url` wins when it has one; otherwise borrows its
 * linked place's photo (`placesById`, batch-fetched once per request — see
 * the route's own doc comment). Returns `h` unchanged (no new object) in the
 * common case so this is cheap to map over the full happenings list.
 */
/**
 * Free places carry a free-text `places.category` ("park", "viewpoint",
 * "gallery"…), not a HappeningCategory — so without this, the ~3/4 of free
 * places that have no photo rendered a bare pin tile on /free and Home. Maps
 * the common types onto the category whose default photo fits; anything
 * unrecognised stays null (the row keeps its pin tile rather than a wrong
 * photo). Only feeds the default-image fallback, nothing else reads it.
 */
const PLACE_IMAGE_CATEGORY: Record<string, HappeningCategory> = {
  park: "outdoors",
  garden: "outdoors",
  viewpoint: "outdoors",
  "walking route": "outdoors",
  "golf course": "outdoors",
  beach: "outdoors",
  nature: "outdoors",
  gallery: "arts",
  museum: "museum",
  "historic site": "museum",
  library: "museum",
  market: "food",
  "shopping street": "other",
  street: "other",
};

function placeDefaultImageCategory(category: string | null | undefined): HappeningCategory | null {
  return PLACE_IMAGE_CATEGORY[(category ?? "").trim().toLowerCase().replace(/[_-]+/g, " ")] ?? null;
}

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

/**
 * Picks the single best hero card. Two candidate pools compete for the slot:
 * every dated happening (any kind, incl. deals) within `HERO_LOOKAHEAD_DAYS`,
 * and every free-or-cheap provider event (lib/cards/price.ts's
 * `priceSignalForEvent`) starting within `HERO_EVENT_LOOKAHEAD_DAYS` — an
 * unpriced-but-sports-exempt event (which `whatsOnHappeningPasses` lets into
 * What's on) is deliberately NOT a hero candidate, per the user's own call:
 * the hero is led by demonstrable value, not just "this is in the window".
 * Scoring itself lives in lib/happenings/hero.ts, which also produces the
 * short `reason` string carried on the winning card. Ties (equal score) go
 * to whichever candidate's own start time is sooner.
 *
 * `windowRange`, when given, further restricts BOTH pools to occurrences
 * that actually fall inside it — the intersection of the window and the
 * usual `HERO_*_LOOKAHEAD_DAYS` cap, never wider than either alone. This is
 * what makes the hero reflect the active tab: on `window=now` a happening
 * whose next occurrence is next week no longer wins the slot just because it
 * scores well, and on `window=coming_up` today's occurrences (the
 * `now`/Today tab's own territory) are excluded from the running rather than
 * winning there too, which is how the exact same "today only" hero used to
 * show up on Coming up before this. `null` (the route's own `book_early`
 * request) keeps the unrestricted, `now`-anchored search — that result is
 * only ever used to compute the ids excluded from What's on/Book Early, not
 * shown as a hero, since Book Early has its own hero pick downstream.
 */
function pickHero(
  happenings: Happening[],
  events: EventItem[],
  now: Date,
  timeZone: string,
  who: readonly DealWhoGroup[] = [],
  windowRange: { from: Date; to: Date } | null = null
): FeedHeroCard | null {
  const cappedHappeningTo = new Date(now.getTime() + HERO_LOOKAHEAD_DAYS * 86_400_000);
  const cappedEventCutoff = now.getTime() + HERO_EVENT_LOOKAHEAD_DAYS * 86_400_000;
  const happeningFrom = windowRange ? windowRange.from : now;
  const happeningTo = windowRange && windowRange.to.getTime() < cappedHappeningTo.getTime() ? windowRange.to : cappedHappeningTo;
  const eventFrom = windowRange ? windowRange.from.getTime() : now.getTime();
  const eventCutoff = windowRange ? Math.min(windowRange.to.getTime(), cappedEventCutoff) : cappedEventCutoff;

  // Every candidate's score/reason/tiebreak start time, computed up front —
  // deliberately NOT reduced to a running "best so far" via a mutated outer
  // variable inside this loop: TypeScript's control-flow narrowing can't see
  // through a nested closure's reassignment of an outer `let`, which turns a
  // "let best = null; function consider() { best = ... }" pattern into a
  // spurious "Property does not exist on type 'never'" at the read site.
  // Collecting candidates into a plain array and reducing in a second, non-
  // nested loop sidesteps that entirely.
  const candidates: { card: FeedHeroCard; score: number; startMs: number; everyday: boolean }[] = [];

  for (const h of happenings) {
    if (!isDated(h)) continue;
    const occurrence = nextOccurrence(h, happeningFrom, happeningTo, timeZone);
    if (!occurrence) continue;
    const { score, reason } = happeningRecommendationScore(h, occurrence, now, timeZone, who);
    // London midnight, not UTC midnight — a dateless occurrence's tie-break
    // instant must sort against real `starts_at` instants (both happenings'
    // and events') the same way `bucketForDayDate`/`localDayDate` already
    // treat that calendar day, or a summer-BST evening event could sort as
    // "later" than a dateless occurrence that's actually earlier in the day.
    const startMs = occurrence.startsAt
      ? new Date(occurrence.startsAt).getTime()
      : startOfLocalDay(occurrence.dayDate, timeZone).getTime();
    candidates.push({
      card: { kind: "happening", happening: h, occurrence, reason },
      score,
      startMs,
      everyday: isEverydayRecurrence(h.recurrence),
    });
  }

  for (const e of events) {
    const startMs = new Date(e.starts_at).getTime();
    if (Number.isNaN(startMs) || startMs < eventFrom || startMs > eventCutoff) continue;
    if (priceSignalForEvent(e) !== "cheap") continue; // free-or-cheap only, never a guessed-cheap sports exemption
    const { score, reason } = eventRecommendationScore(e, now, timeZone);
    candidates.push({ card: { kind: "event", event: e, reason }, score, startMs, everyday: false });
  }

  // Something on every day (a daily guided walk, the free walking tour) is
  // never the pick while anything else qualifies — it'd lead the page every
  // single day. It lives in the "Any day" section instead (everyday.ts).
  const pool = candidates.some((c) => !c.everyday) ? candidates.filter((c) => !c.everyday) : candidates;
  let best: (typeof candidates)[number] | null = null;
  for (const c of pool) {
    if (!best || c.score > best.score || (c.score === best.score && c.startMs < best.startMs)) {
      best = c;
    }
  }
  return best ? best.card : null;
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
 * `WHATS_ON_PRICE_EXEMPT_CATEGORIES` (lib/cards/price.ts) — sports fixtures
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
  placesById: Map<string, Place>,
  now: Date,
  timeZone: string
): Promise<FreeAnyTimeItem[]> {
  // `!isDated` (recurrence "always") rows don't "end" on a normal calendar
  // day, but a row's own validity bound (`ends_at`) can still have passed —
  // final guard, belt-and-braces (query-layer already drops a past
  // `season_valid_until` row — see lib/db/happenings.ts's `isPastSeason` —
  // this catches the `ends_at`-bounded case the same way).
  const alwaysFree = happenings.filter((h) => !isDated(h) && h.is_free && !happeningHasEnded(h, now, timeZone));

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
        category: placeDefaultImageCategory(p.category),
        district: districtFromAddress(p.address) ?? null,
        typeLabel: formatPlaceCategoryLabel(p.category),
      }));
  } catch (err) {
    console.error("[api/feed] free places lookup failed", err);
  }

  return [...happeningItems, ...placeItems];
}

/**
 * Every `kind: "deal"` happening that is a genuine, redeemable discount
 * (lib/happenings/groups.ts's `isGenuineDeal` — a plain ticket price or
 * "on sale now" row that got tagged `kind: "deal"` upstream is filtered out
 * here rather than shown), decorated with a soonest occurrence (for display)
 * and WHAT/WHO facets (for client-side filtering). Also excludes a deal
 * that's both `recurrence: "always"` AND `is_free === true` — that exact
 * combination is `buildFreeAnyTime`'s own selection criterion, and the two
 * sections must stay mutually exclusive (mirrors the pre-restructure
 * `buildStandingDeals`'s identical exclusion, just expressed against `kind`
 * now instead of inferring "is this a deal" from recurrence alone).
 */
// The Home hero is NOT excluded here: /deals never shows that hero, so
// dropping it made the single best deal the one you couldn't find in Deals.
function buildDealCards(happenings: Happening[], now: Date, timeZone: string): DealCardData[] {
  const to = new Date(now.getTime() + BOOK_EARLY_LOOKAHEAD_DAYS * 86_400_000);
  const cards: DealCardData[] = [];
  for (const h of happenings) {
    if (h.kind !== "deal") continue;
    if (!isDated(h) && h.is_free === true) continue; // → freeAnyTime only
    if (!isGenuineDeal(h)) continue; // ticket price / on-sale notice, not an actual discount
    const occurrence = isDated(h) ? nextOccurrence(h, now, to, timeZone) : nextOccurrence(h, now, now, timeZone);
    if (!occurrence) continue;
    const { what, who } = dealFacets(h);
    cards.push({ kind: "happening", happening: h, occurrence, what, who });
  }
  return cards;
}

/**
 * Groups deal cards by resolvable `place_id` into venue cards (task 3);
 * everything else (city/region/national scope, or a `place_id` that didn't
 * resolve to a live `places` row) stays a single card (task's own "offers
 * without a venue" rule) — UNLESS it shares a normalised `venue_name` with
 * another deal (either another place-id-less single, or one that DID
 * resolve to a place). That second pass is what keeps e.g. Camera Obscura's
 * three deals as ONE group of three: two of them share a `place_id` and
 * grouped above, but the third has no `place_id` at all — without this, it
 * rendered as a second, separate "Camera Obscura" card right next to the
 * venue group (reported bug). Matched against `normalizeText`
 * (lib/happenings/merge-events.ts) — the same normalisation the provider-
 * event dedupe already uses, so "Camera Obscura & World of Illusions" and a
 * differently-punctuated variant of the same name still line up.
 */
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

  const venueGroups: VenueDealGroup[] = Array.from(byPlace.entries()).map(([placeId, offers]) => {
    const place = placesById.get(placeId)!;
    return {
      placeId: placeId as string | null,
      placeName: place.name ?? "Edinburgh venue",
      placeImageUrl: place.image_url,
      district: districtFromAddress(place.address),
      offers,
    };
  });

  // Second pass over what's left, keyed by normalised venue_name: fold a
  // place-id-less single into an EXISTING (place-resolved) group when its
  // venue name matches one, else bucket it with any other place-id-less
  // singles that share a venue name — 2+ of those become a fresh,
  // `placeId: null` group of their own (see the module doc above).
  const groupByNormName = new Map<string, VenueDealGroup>();
  for (const g of venueGroups) groupByNormName.set(normalizeText(g.placeName), g);

  const remainingSingles: DealCardData[] = [];
  const fallbackBuckets = new Map<string, DealCardData[]>();
  for (const card of singles) {
    const venueName = card.happening.venue_name;
    if (!venueName) {
      remainingSingles.push(card);
      continue;
    }
    const norm = normalizeText(venueName);
    const existing = groupByNormName.get(norm);
    if (existing) {
      existing.offers.push(card);
      continue;
    }
    const bucket = fallbackBuckets.get(norm) ?? [];
    bucket.push(card);
    fallbackBuckets.set(norm, bucket);
  }

  for (const cards of fallbackBuckets.values()) {
    if (cards.length < 2) {
      remainingSingles.push(...cards);
      continue;
    }
    const first = cards[0].happening;
    venueGroups.push({
      placeId: null,
      placeName: first.venue_name ?? "Edinburgh venue",
      placeImageUrl: cards.find((c) => c.happening.image_url)?.happening.image_url ?? null,
      district: first.district ?? null,
      offers: cards,
    });
  }

  venueGroups.sort((a, b) => {
    const countCmp = b.offers.length - a.offers.length;
    if (countCmp !== 0) return countCmp;
    const savingCmp = (b.offers[0]?.happening.saving_amount ?? 0) - (a.offers[0]?.happening.saving_amount ?? 0);
    return savingCmp;
  });

  remainingSingles.sort((a, b) => {
    const priorityCmp = (b.happening.priority ?? 50) - (a.happening.priority ?? 50);
    if (priorityCmp !== 0) return priorityCmp;
    return (b.happening.saving_amount ?? -1) - (a.happening.saving_amount ?? -1);
  });

  return { venueGroups, singles: remainingSingles };
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
  // Public: signed-out visitors browse the feed too (user decision
  // 2026-09-15). Every table read here is `read_all` to anon under RLS, so a
  // cookie-less request simply runs as the anon role.
  const db = await supabaseServer();
  // Signed-in visitors get the hero ranked for their deals profile; the rest
  // of the response is the same for everyone.
  // Started now, awaited only where the hero needs it — it's a network call
  // to Supabase Auth when a session cookie is present, so it overlaps the
  // catalogue reads instead of running before them. Never rejects: a failed
  // lookup just means the generic (signed-out) hero ranking.
  const whoPromise = db.auth
    .getUser()
    .then(({ data: { user } }) => parseWhoGroups(user?.user_metadata))
    .catch(() => parseWhoGroups(undefined));

  const { searchParams } = new URL(request.url);
  const window = parseWindow(searchParams.get("window"));
  const range = parseRange(searchParams.get("range"));
  const price = parsePrice(searchParams.get("price"));
  const atParam = searchParams.get("at");
  const now = atParam && !Number.isNaN(Date.parse(atParam)) ? new Date(atParam) : new Date();
  const timeZone = CITY.timezone;

  try {
    // Start the reads that don't depend on each other now, in parallel —
    // they used to run one after another (~3.5s cold). The awaits further
    // down call lib/db/cached.ts with identical arguments, so they pick up
    // these same in-flight promises instead of querying again. Failures are
    // swallowed here only; each real await below still sees and handles them.
    const bookEarlyEventsOpts = {
      destination: CITY.name,
      from: now.toISOString(),
      to: new Date(now.getTime() + BOOK_EARLY_LOOKAHEAD_DAYS * 86_400_000).toISOString(),
      limit: 100,
    };
    const prewarm: Promise<unknown>[] = [listUpcomingEvents(db, bookEarlyEventsOpts), listPlacesByCity(db, CITY.name)];
    if (window !== "book_early") {
      const { from, to } = occurrenceWindowRange(window, range, now, timeZone);
      if (to >= from) {
        prewarm.push(listUpcomingEvents(db, { destination: CITY.name, from: from.toISOString(), to: to.toISOString(), limit: 500 }));
      }
    }
    for (const p of prewarm) p.catch(() => {});

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

    // Fetched here (not down by Book Early, where it used to live) because
    // `pickHero` also needs the provider-event catalogue for its free/cheap
    // event candidates — a year-long lookahead comfortably covers the hero's
    // own much shorter `HERO_EVENT_LOOKAHEAD_DAYS` window, so this one query
    // serves both without a second round trip.
    const bookEarlyEvents = await listUpcomingEvents(db, bookEarlyEventsOpts);

    // Computed up front (not just down at the `whatsOn` block, which only
    // runs for `window !== "book_early"`) because `pickHero` itself now
    // needs it to scope the hero to the requested tab — see `pickHero`'s own
    // doc comment. `null` on `window=book_early`, which has no date window
    // of its own and keeps `pickHero`'s unrestricted search (its result is
    // only used for What's on/Book Early exclusion on that request, never
    // shown — see below).
    const heroWindowRange = window !== "book_early" ? occurrenceWindowRange(window, range, now, timeZone) : null;
    const who = await whoPromise;
    const hero = pickHero(happenings, bookEarlyEvents, now, timeZone, who, heroWindowRange);
    const heroHappeningId = hero?.kind === "happening" ? hero.happening.id : null;
    const heroEventId = hero?.kind === "event" ? hero.event.id : null;

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
    let anyDay: FeedBucket | null = null;
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
        if (!(isDated(h) && h.kind !== "deal" && h.id !== heroHappeningId && whatsOnHappeningPasses(h, price))) continue;
        const group = seriesByMemberId.get(h.id);
        if (group) {
          if (seenSeriesInWindow.has(group.key)) continue;
          const members = group.members.filter((m) => m.id !== heroHappeningId);
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
      // "cheap" ceiling (lib/cards/price.ts's priceSignalForEvent) silently
      // dropped almost the entire Ticketmaster/Skiddle catalogue, because
      // those rows essentially never carry a `price_from` and so score
      // `null`, not "cheap". `price === "cheap"` opts back into that exact
      // old predicate (the What's on filter chip); the default "all" applies
      // no price filter at all — see `FeedPrice`'s own doc comment.
      //
      // Bounded by the window's own `from`, not `now`: on "Coming up" that's
      // tomorrow, so the `limit` budget isn't spent on today's
      // events only for them to be discarded by the bucket filter below —
      // which used to be able to starve the section empty on a busy day.
      // Skipped entirely for an inverted range ("This month", selected with
      // no days left in it), which by definition matches nothing. `limit`
      // raised from 60 to 200 to 500: as the catalogue grows with more sources,
      // a higher budget ensures dedupe/merge can find all matching pairs.
      const windowEventsRaw =
        to < from
          ? []
          : await listUpcomingEvents(db, {
              destination: CITY.name,
              from: from.toISOString(),
              to: to.toISOString(),
              limit: 500,
            });
      // Exclude the hero itself so an event-kind hero never also renders as
      // a What's on card — mirrors the happening-side `h.id !== heroHappeningId`
      // exclusion above.
      const windowEvents = heroEventId ? windowEventsRaw.filter((e) => e.id !== heroEventId) : windowEventsRaw;
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

      const todayStr = localDayDate(now, timeZone);
      // Floored to `today` when the raw day is already behind it — an
      // in-progress span (a months-long exhibition whose `starts_at` was
      // back in June, still running now) must sort/bucket as "available
      // today", not by the original start day that's since scrolled off the
      // calendar. Only ever moves a card FORWARD to today, never further
      // back or into the future — a genuinely future day is returned as-is.
      // Both helpers are only ever called on `allCards` (happening/series/
      // event — recurring grouping runs later, over their sorted output, see
      // `groupedCards` below), but are typed against the broader
      // `FeedCardData` union; the `recurring` branch is dead code today,
      // kept only so this stays exhaustive if that ever changes.
      const dayDateOf = (c: FeedCardData): string => {
        const raw =
          c.kind === "event"
            ? localDayDate(new Date(c.event.starts_at), timeZone)
            : c.kind === "recurring"
              ? c.dates[0]
              : c.occurrence.dayDate;
        return raw < todayStr ? todayStr : raw;
      };
      const startAtOf = (c: FeedCardData): string =>
        c.kind === "event" ? c.event.starts_at : c.kind === "recurring" ? "" : c.occurrence.startsAt ?? "";

      // Single chronological bucket, sorted day then start time — "This
      // weekend" sitting above "Later on" as two separate buckets read as the
      // wrong relationship (the weekend isn't a different KIND of thing, just
      // sooner); the date-filter chip row above the list on `coming_up`
      // (Home, app/(shell)/page.tsx) is what now lets the caller narrow to a
      // weekend or a single day, client-side, over this one list. `now`
      // keeps its own single bucket, belt-and-braces filtered by
      // the card's local day in case it lands on the window
      // boundary differently than its raw timestamp suggests (the range
      // itself already excludes days outside it via `occurrenceWindowRange`).
      const bucketKey: FeedBucketKey = window === "now" ? "today_tomorrow" : "coming_up";
      const cards = allCards
        .filter((card) => !cardHasEnded(card, now, timeZone)) // final "no ended items ever leave an API" guard
        .filter((card) => {
          // Direct day comparison (not `bucketForDayDate`, which still groups
          // today + tomorrow for hero scoring): Today = today's day, Coming
          // up = tomorrow onwards.
          const day = dayDateOf(card);
          return window === "now" ? day === todayStr : day > todayStr;
        })
        .sort((a, b) => {
          const dayCmp = dayDateOf(a).localeCompare(dayDateOf(b));
          if (dayCmp !== 0) return dayCmp;
          return startAtOf(a).localeCompare(startAtOf(b));
        });

      // Collapses the same title-at-the-same-venue-on-several-dates pattern
      // (a per-date-entered exhibition, a weekly Ticketmaster/Skiddle
      // listing — "The Comedy Cellar Edinburgh Live Stand-Up Comedy" turned
      // up 46 times in `coming_up` before this) into one "Tue 29 Sep + N
      // more dates" card. Run LAST, over the already ranked/sorted list, so
      // a group lands at its earliest (best-ranked) member's own position —
      // see lib/happenings/recurring.ts's module doc.
      const groupedCards = groupRecurringCards(cards, timeZone);

      // "Any day" split (lib/happenings/everyday.ts): a card that's on
      // essentially every day (free walking tour, a nightly comedy club) is
      // pulled out of the chronological list — it started ~10am every day
      // and so topped Today forever — into its own trailing section. Run
      // AFTER groupRecurringCards so a daily provider listing (collapsed to
      // one `recurring` card with `dates`) is judged as the one card it is.
      const windowStartDay = window === "now" ? todayStr : addDays(todayStr, 1);
      const seriesMembers = (key: string) => seriesGroups.find((g) => g.key === key)?.members ?? [];
      const mainCards: FeedCardData[] = [];
      const anyDayCards: FeedCardData[] = [];
      for (const card of groupedCards) {
        if (!isEverydayCard(card, { windowStartDay, seriesMembers })) {
          mainCards.push(card);
          continue;
        }
        // Coming up: an everyday item whose recurrence rule already runs
        // today is in Today's Any day section — repeating it under Coming up
        // forever would just be noise, so it's dropped here (not moved back
        // into the dated list either). A weekday-only (5-day) item, when
        // today is a weekend day, doesn't run today, so it stays. A dates-
        // based `recurring` card has no rule to check and stays.
        if (window === "coming_up" && everydayCardRunsOn(card, todayStr, seriesMembers)) continue;
        anyDayCards.push(card);
      }

      if (mainCards.length > 0) {
        const title = window === "now" ? "Today" : "Coming Up";
        const meta = window === "now" ? `${mainCards.length} active` : null;
        whatsOn = [{ key: bucketKey, title, meta, cards: mainCards }];
      }
      if (anyDayCards.length > 0) {
        anyDay = { key: "any_day", title: "Any day", meta: "Runs most days", cards: anyDayCards };
      }
    }

    // On the Book early TAB, the global Fomo Pick hero has no business
    // sitting above a list whose whole point is "book this ahead of time" —
    // so on that request only, the hero slot is the top-ranked Book Early
    // `kind: "happening"` card instead (excluded from the list below so it
    // isn't shown twice), and the global hero is no longer excluded from the
    // Book Early candidate set (it was never a Book Early card to begin
    // with, so there's nothing to dedupe against). Every other request keeps
    // the original behaviour unchanged, since /book-early, /deals and /free
    // all read this same route with `window=now` and depend on the full,
    // hero-excluded list.
    const bookEarlyAllRaw = buildBookEarly(
      happenings,
      bookEarlyEvents,
      window === "book_early" ? null : heroHappeningId,
      now,
      timeZone,
      seriesByMemberId
    );
    // Final "no ended items ever leave an API" guard — every candidate here
    // already passed `nextOccurrence`/an explicit future-events filter
    // inside `buildBookEarly`, so this is belt-and-braces, same reasoning as
    // `cardHasEnded` above.
    const bookEarlyAll = bookEarlyAllRaw.filter((c) =>
      c.kind === "happening" ? !happeningHasEnded(c.happening, now, timeZone) : !eventHasEnded(c.event, now)
    );

    let responseHero: FeedHeroCard | null =
      hero && !(hero.kind === "happening" ? happeningHasEnded(hero.happening, now, timeZone) : eventHasEnded(hero.event, now))
        ? hero
        : null;
    let bookEarly = bookEarlyAll;
    let heroKind: FeedResponse["heroKind"];
    if (window === "book_early") {
      const topIndex = bookEarlyAll.findIndex((c) => c.kind === "happening");
      const top: BookEarlyHappeningCard | undefined =
        topIndex >= 0 && bookEarlyAll[topIndex].kind === "happening"
          ? (bookEarlyAll[topIndex] as BookEarlyHappeningCard)
          : undefined;
      if (top) {
        // No comparable recommendationScore run for the Book Early tab's own
        // pick (it's ranked by rankBookEarly's own tiering, not this
        // module's score) — `reason` stays null rather than a misleading one.
        responseHero = { kind: "happening", happening: top.happening, occurrence: top.occurrence, reason: null };
        bookEarly = [...bookEarlyAll.slice(0, topIndex), ...bookEarlyAll.slice(topIndex + 1)];
        heroKind = "book_early";
      } else {
        // No happening-kind Book Early candidate to lead with — never fall
        // back to the global Fomo Pick hero on this tab. `heroKind` still
        // needs to read "book_early" here (not fall through to the
        // `?? "fomo_pick"` default below) — otherwise the client can't tell
        // "no Book Early candidate" apart from "no `window` param at all"
        // and renders the wrong hero treatment for this tab, which is
        // exactly what this branch's own comment says never to do.
        responseHero = null;
        heroKind = "book_early";
      }
    }

    const dealCards = buildDealCards(happenings, now, timeZone).filter(
      (c) => !happeningHasEnded(c.happening, now, timeZone) // final guard
    );
    const deals = await buildDealsSection(db, dealCards);

    const freeAnyTime = await buildFreeAnyTime(db, happenings, seriesByMemberId, seriesLeads, placesById, now, timeZone);

    return cachedJson<FeedResponse>(
      { hero: responseHero, heroKind, whatsOn, anyDay, bookEarly, deals, freeAnyTime },
      CACHE_PRIVATE_NO_STORE
    );
  } catch (err) {
    console.error("[api/feed] failed", err);
    // A non-2xx status (rather than a 200 with empty sections) is the signal
    // every client page now checks (`res.ok`) to tell "the feed request
    // actually failed" apart from "the feed is genuinely empty" — a 200 here
    // used to render as "Nothing lined up... try another tab" on every page
    // reading this route, which reads as no content rather than a failure.
    // Unauthorized still gets its own distinct status (401) rather than the
    // generic 500 below, since that's a real "sign in again" case, not a
    // transient failure a Retry button should paper over.
    const unauthorized = isUnauthorizedError(err);
    return cachedJson<FeedResponse>(
      {
        hero: null,
        whatsOn: [],
        anyDay: null,
        bookEarly: [],
        deals: { venueGroups: [], singles: [] },
        freeAnyTime: [],
        degraded: unauthorized ? "unauthorized" : undefined,
      },
      CACHE_PRIVATE_NO_STORE,
      { status: unauthorized ? 401 : 500 }
    );
  }
}
