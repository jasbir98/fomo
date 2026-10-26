/**
 * Provider-catalogue merge/dedupe for the What's on feed.
 *
 * WHY THIS EXISTS: `happenings` (curated, researched by hand) and `events`
 * (raw Ticketmaster/Skiddle rows) are two independent catalogues that both
 * describe the same real-world calendar. The same gig routinely lands in
 * both — a curator writes up "Hogmanay Street Party" as a happening, and the
 * Ticketmaster sync separately ingests "Edinburgh's Hogmanay Street Party
 * 2026 - Tickets" as an event row. Once task 2 stopped hard-filtering out
 * unpriced provider events, that overlap became visible as duplicate cards
 * for the same night — this module collapses each such pair back into one.
 *
 * FALSE-POSITIVE RISK, AND WHY THIS IS DELIBERATELY BIASED AGAINST IT: a
 * missed merge just leaves two cards on screen for one event — mildly
 * annoying, immediately obvious, and harmless. A WRONG merge is silent and
 * much worse: it deletes a real, distinct event's card outright and hands
 * its audience the other event's booking link instead (a ceilidh's crowd
 * sent to buy tickets for a comedy night, say). Every design choice below —
 * same-day as a hard gate rather than a score input, the subset rule, the
 * high-confidence escape hatch — exists to keep false negatives cheap and
 * false positives rare, never the other way round.
 *
 * Plain token-set Jaccard alone is NOT enough to guarantee that: two titles
 * that share a lot of generic filler ("at", "the", venue words) but differ
 * in exactly the one word that actually names the event —
 * "Ceilidh at the Assembly Rooms" vs "Comedy at the Assembly Rooms" — score
 * 0.67, comfortably over a naive single threshold, while being two
 * completely different events that happen to share a venue. Jaccard weights
 * every token equally, so a long shared venue phrase can outvote the one
 * distinguishing word. The fix is `isTitleMatch`'s two-branch rule below,
 * which requires either a genuine containment relationship (one title is
 * the other plus decoration) or a near-total token overlap — see that
 * function's own comment for the exact rule and worked examples.
 */
import type { EventItem } from "@/lib/types";
import type { HappeningCardData, SeriesCardData } from "@/lib/happenings/feed-types";
import { weeklySpanOf, type WeeklySpan } from "@/lib/events/format";
import { localDayDate, nextOccurrence, normalizeRecurrence, weekdayOf } from "@/lib/happenings/occurrence";
import type { Happening } from "@/lib/happenings/types";
import { NO_VENUE_KEY, PROVIDER_PRIORITY, normalizeEventTitle, normalizeVenueKey } from "@/lib/events/identity";

/** The two What's-on card kinds a provider event can be merged into — never
 *  `EventCardData`, which is what's being merged AWAY. */
export type MergeableCard = HappeningCardData | SeriesCardData;

const DIACRITICS_RE = /[\u0300-\u036f]/g;
/** Trailing "(2026 tour)" / "[SOLD OUT]" style qualifiers — noise for
 *  matching, never part of what makes two titles the same event. */
const BRACKETED_RE = /\([^)]*\)|\[[^\]]*\]/g;
/** Straight and curly apostrophes are dropped outright (not turned into a
 *  space) so "Edinburgh's" normalises to the single token "edinburghs"
 *  rather than splitting into "edinburgh" + a stray, meaningless "s" token
 *  that would otherwise pad out both the intersection and the union and
 *  quietly drag a genuine match's score around. */
const APOSTROPHE_RE = /['\u2019]/g;
const NON_ALNUM_RE = /[^a-z0-9\s]/g;
const YEAR_RE = /^(19|20)\d{2}$/;
/** A season range ("2026/27", "2026-27") is one edition, not a year plus a
 *  stray "27" token — dropped whole, like a bare year. */
const YEAR_RANGE_RE = /\b(19|20)\d{2}\s*[/\u2013-]\s*\d{2}\b/g;

/**
 * Words that show up on a provider listing page ("... Tickets", "... Tour",
 * "Live") but never on a curator's own title for the same thing — noise
 * that would otherwise drag down the similarity score of a genuine match for
 * no reason.
 */
const NOISE_TOKENS = new Set(["tickets", "ticket", "tour", "live", "concert", "gig", "show", "event"]);

/**
 * Common English function words — articles, conjunctions, and prepositions
 * — stripped from every title before comparison, not just a leading "the".
 * These carry no identifying information about WHICH event something is,
 * but a short, single-word title (an artist name like "Mogwai") is
 * disproportionately punished by even one leftover filler token: "Mogwai"
 * vs "Mogwai - Live in Concert" already drops "live"/"concert" as noise, but
 * the stray "in" alone was enough to halve the Jaccard score (1/2) and sink
 * a match that should be obvious. Stripping stopwords generally, not just
 * "the" at the front, fixes that whole class of miss.
 *
 * `v` / `vs` are deliberately NOT in this set — for a fixture title
 * ("Scotland v England", "Hibernian v Celtic") that token is the entire
 * distinguishing structure of the title, not filler; stripping it would
 * leave two different fixtures that share a home side looking identical.
 */
const STOPWORDS = new Set(["the", "a", "an", "and", "at", "in", "on", "of", "for", "to", "with", "from", "by"]);

/**
 * Lowercases, strips diacritics/punctuation/bracketed qualifiers/year
 * numbers, drops noise tokens (see `NOISE_TOKENS`), then drops stopwords
 * (see `STOPWORDS`). Returns a normalised, space-joined string — the shared
 * prep step for both the title-similarity score and the exact-match
 * provider/provider dedupe key below.
 *
 * Stopword-stripping falls back to the pre-stopword token list if it would
 * otherwise leave nothing: a title that's ENTIRELY function words (or, after
 * noise-stripping, reduces to one) must never normalise to an empty set —
 * two empty sets compare as a perfect (and meaningless) match, which would
 * merge two otherwise-unrelated rows for the worst possible reason.
 */
export function normalizeText(raw: string): string {
  let s = raw.normalize("NFKD").replace(DIACRITICS_RE, "");
  s = s.toLowerCase();
  s = s.replace(BRACKETED_RE, " ");
  s = s.replace(YEAR_RANGE_RE, " ");
  s = s.replace(APOSTROPHE_RE, "");
  s = s.replace(NON_ALNUM_RE, " ");
  const rawTokens = s.split(/\s+/).filter(Boolean);
  const coreTokens = rawTokens.filter((t) => !NOISE_TOKENS.has(t) && !YEAR_RE.test(t));
  const withoutStopwords = coreTokens.filter((t) => !STOPWORDS.has(t));
  const tokens = withoutStopwords.length > 0 ? withoutStopwords : coreTokens;
  return tokens.join(" ");
}

function tokenSet(raw: string): Set<string> {
  return new Set(normalizeText(raw).split(" ").filter(Boolean));
}

/**
 * Token-set Jaccard similarity of two raw titles, after `normalizeText`:
 * `|intersection| / |union|`. Used both as branch (B)'s own score and as the
 * ranking metric when several same-day cards all pass `isTitleMatch` for the
 * same event (`mergeProviderEventsIntoCards` picks the highest-scoring one).
 * Not, on its own, a merge decision — see `isTitleMatch`.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * `|intersection| / |smaller set|` — 1.0 exactly when the smaller title's
 * tokens are a complete subset of the larger's, i.e. the smaller title is
 * "contained" inside the larger one. This is the signal that actually
 * distinguishes "same event, plus decoration" from "two different things
 * that share some words": a genuine duplicate pair is almost always one
 * catalogue's title plus a city prefix, a year, "tickets", a bracketed
 * qualifier — the shorter title's every token reappears in the longer one.
 * Two DIFFERENT events that merely share a venue or festival name each
 * contribute at least one token the other lacks, so neither is a subset of
 * the other and this comes out below 1.0 even when Jaccard alone is high.
 */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const t of smaller) if (larger.has(t)) intersection++;
  return intersection / smaller.size;
}

/**
 * The floor for branch (A) below — deliberately not the whole rule on its
 * own (see `isTitleMatch`). Guards against a trivial subset made of one or
 * two throwaway shared tokens (e.g. just "the") counting as containment;
 * the shared portion still has to be most of both titles.
 */
export const TITLE_MATCH_THRESHOLD = 0.6;

/**
 * The escape hatch for branch (B) below — titles that are near-identical
 * (trivial token churn only, no real containment gap either way) still
 * count as a match even without a clean subset relationship.
 */
export const HIGH_CONFIDENCE_JACCARD = 0.85;

/**
 * The merge decision: same-day is checked by the caller (a hard gate, never
 * part of this score); given that, two titles are the SAME event only when
 * EITHER:
 *
 *   (A) containment == 1.0 (the smaller title's tokens are a full subset of
 *       the larger's — "same thing, plus decoration") AND Jaccard >=
 *       `TITLE_MATCH_THRESHOLD` (the shared portion is still most of both
 *       titles, not just a couple of filler words); OR
 *   (B) Jaccard >= `HIGH_CONFIDENCE_JACCARD` (titles are near-identical, so
 *       close that a clean containment relationship isn't needed).
 *
 * Worked examples (see this module's tests/report, not committed):
 *
 *   "Hogmanay Street Party" / "Edinburgh's Hogmanay Street Party 2026 -
 *   Tickets"                              containment 1.0, Jaccard 0.75 → (A)
 *   "The Jesus and Mary Chain" / "Jesus and Mary Chain Live"
 *                                          containment 1.0, Jaccard 1.0  → (A)/(B)
 *   "Fringe: Late Night Gig" / "Late Night Gig (Fringe) tickets"
 *                                          containment 1.0, Jaccard 0.67 → (A)
 *   "Mogwai" / "Mogwai - Live in Concert" containment 1.0, Jaccard 1.0  → (A)/(B)
 *          (only reaches 1.0 because the stray "in" is a stopword — see
 *          `STOPWORDS`; without it this pair used to miss at Jaccard 0.5)
 *   "The Who" / "Doctor Who"              containment 1.0, Jaccard 0.5  → no match
 *          (branch (A) needs Jaccard >= 0.6 too — a single shared token
 *          being a full subset of a two-token title isn't enough on its own)
 *   "Ceilidh at the Assembly Rooms" / "Comedy at the Assembly Rooms"
 *          containment 0.67 (NOT 1.0 — "ceilidh"/"comedy" each unmatched
 *          once "at"/"the" strip as stopwords), Jaccard 0.5   → no match
 *   "Quiz Night at The Stand" / "Open Mic Night at The Stand"
 *          containment 0.67, Jaccard 0.4                      → no match
 *   "Edinburgh Jazz Festival" / "Edinburgh Film Festival"
 *          containment 0.67, Jaccard 0.5                         → no match
 *   "Hamilton" / "Hamlet"                 containment 0, Jaccard 0 → no match
 *
 * Known accepted false positive: "Edinburgh Jazz Festival 2026" WILL match
 * "Edinburgh Jazz Festival Gala" under branch (A) — the year strips out,
 * leaving a clean subset. This is an "umbrella event vs. a specific
 * sub-event" pair, not two unrelated things, and merging them still leaves
 * the better (curated) card on screen with the provider's booking link
 * attached — accepted by design, not a gap to close with more machinery.
 */
export function isTitleMatch(a: string, b: string): boolean {
  return isTokenSetMatch(tokenSet(a), tokenSet(b));
}

function jaccardOf(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/** `isTitleMatch`'s rule over already-tokenised titles. */
function isTokenSetMatch(ta: Set<string>, tb: Set<string>): boolean {
  const jaccard = jaccardOf(ta, tb);
  const isSubset = containment(ta, tb) === 1;
  return (isSubset && jaccard >= TITLE_MATCH_THRESHOLD) || jaccard >= HIGH_CONFIDENCE_JACCARD;
}

/** Words that say "Edinburgh", not which venue — never stripped as venue tokens. */
const CITY_TOKENS = new Set(["edinburgh", "edinburghs", "scotland", "uk"]);

/**
 * A title's tokens with its venue's name taken out, when the title spells
 * the whole venue out: "Alison Moyet at Usher Hall" at "Usher Hall" ->
 * {alison, moyet}. A title that only shares some of the venue's words keeps
 * them all, and a title that is nothing but its venue is left whole.
 */
function tokensWithoutVenue(title: string, venue: string | null): Set<string> {
  const tokens = tokenSet(title);
  if (!venue) return tokens;
  const venueTokens = [...tokenSet(venue)].filter((t) => !CITY_TOKENS.has(t));
  if (venueTokens.length === 0 || !venueTokens.every((t) => tokens.has(t))) return tokens;
  const stripped = new Set([...tokens].filter((t) => !venueTokens.includes(t)));
  return stripped.size > 0 ? stripped : tokens;
}

/** Same venue, as far as two free-text venue names can say: identical venue
 *  keys (lib/events/identity.ts), or one name contained in the other. */
export function isSameVenue(a: string | null, b: string | null): boolean {
  const ka = normalizeVenueKey(a);
  const kb = normalizeVenueKey(b);
  if (ka === NO_VENUE_KEY || kb === NO_VENUE_KEY) return false;
  return ka === kb || isTitleMatch(a ?? "", b ?? "");
}

/** Identical titles once the venue, years, noise words and stopwords are
 *  stripped: "The Classic Rock Show" == "The Classic Rock Show at Usher Hall",
 *  but "The Saturday Show" != "The Early Saturday Show". */
export function isSameTitleAtVenue(aTitle: string, aVenue: string | null, bTitle: string, bVenue: string | null): boolean {
  const a = tokensWithoutVenue(aTitle, aVenue);
  const b = tokensWithoutVenue(bTitle, bVenue);
  return a.size === b.size && [...a].every((t) => b.has(t));
}

/**
 * `isTitleMatch` for two listings already known to be at the same venue,
 * with the venue's name stripped from each title first. Catches the pairs
 * where one source appends the venue and the other doesn't: "Alison Moyet
 * at Usher Hall" vs "Alison Moyet" scores Jaccard 0.5 raw (a miss), 1.0
 * stripped. Callers must check the venue themselves (`isSameVenue`); without
 * that gate, stripping would make "Quiz at The Stand" match any "Quiz".
 */
export function isTitleMatchAtVenue(aTitle: string, aVenue: string | null, bTitle: string, bVenue: string | null): boolean {
  if (isTitleMatch(aTitle, bTitle)) return true;
  return isTokenSetMatch(tokensWithoutVenue(aTitle, aVenue), tokensWithoutVenue(bTitle, bVenue));
}

function cardTitle(card: MergeableCard): string {
  return card.kind === "happening" ? card.happening.title : card.title;
}

function cardVenue(card: MergeableCard): string | null {
  return card.kind === "happening" ? card.happening.venue_name : card.lead.venue_name;
}

/** "Victoria Bar's" -> "Victoria Bar" — see `isWeeklySpanMatch`. */
const POSSESSIVE_RE = /['\u2019]s\b/gi;

/**
 * A weekly span event ("Victoria Bar's Wednesday Quiz Night", one date-only
 * row for 1 Sep – 30 Dec — see lib/events/format.ts's `weeklySpanOf`) has no
 * single day to gate on, so it pairs with a curated card ("Wednesday Quiz
 * Night at Victoria Bar", weekly on Wednesdays) on any of its run's matching
 * weekdays instead. Looser day gate, so the venue must agree too (a hard
 * gate here, unlike the tiebreak in the main loop), and possessives are
 * dropped from both titles so "Bar's" and "Bar" are the same token.
 */
function isWeeklySpanMatch(card: MergeableCard, event: EventItem, span: WeeklySpan): boolean {
  const day = card.occurrence.dayDate;
  if (day < span.firstDay || day > span.lastDay || weekdayOf(day) !== span.weekday) return false;
  const venueKey = normalizeVenueKey(cardVenue(card));
  if (venueKey === NO_VENUE_KEY || venueKey !== normalizeVenueKey(event.venue_name)) return false;
  return isTitleMatch(cardTitle(card).replace(POSSESSIVE_RE, ""), event.name.replace(POSSESSIVE_RE, ""));
}

/**
 * Copies `card` with `bookingUrl` grafted onto its happening/lead object,
 * UNLESS the card already has one of its own — curated `booking_url` always
 * wins when it exists. Always returns a shallow copy (or `card` itself,
 * unchanged, when there's nothing to add); the row read from the DB is never
 * mutated in place.
 */
function withBorrowedBookingUrl(card: MergeableCard, bookingUrl: string | null): MergeableCard {
  if (!bookingUrl) return card;
  if (card.kind === "happening") {
    if (card.happening.booking_url) return card;
    return { ...card, happening: { ...card.happening, booking_url: bookingUrl } };
  }
  if (card.lead.booking_url) return card;
  return { ...card, lead: { ...card.lead, booking_url: bookingUrl } };
}

/**
 * Matches each provider `EventItem` against the already-built happening/
 * series cards for the SAME window and folds a match into its card rather
 * than letting it become a second, duplicate `EventCardData`.
 *
 * Same local calendar day is a HARD requirement, never a scoring input — two
 * unrelated things that happen to share a near-identical name on different
 * nights (a touring show's two different city dates, say) must not merge
 * just because the title score alone would clear the bar. Whether a
 * same-day card and event are the SAME event is then decided by
 * `isTitleMatch` (see its own comment for the containment/Jaccard rule);
 * `titleSimilarity` alone only ranks among several same-day matches for one
 * event, it never gates the decision by itself. Venue/place-name similarity
 * is available as a soft tiebreaker (see `cardVenue`) when two same-day
 * matching candidates score within a hair of each other, but is deliberately
 * never required to confirm a match — curated rows carry a `place_id`,
 * provider rows only a free-text venue string, and the two often don't line
 * up even for a genuine match.
 *
 * O(n·m): `events.length` × `cards.length`, both small per-request lists —
 * no network or DB access happens in here.
 *
 * Returns the (possibly booking-url-patched) cards array plus whichever
 * events found no home, so the caller can still turn those into their own
 * `EventCardData` cards as before.
 */
export function mergeProviderEventsIntoCards(
  cards: MergeableCard[],
  events: EventItem[],
  timeZone: string
): { cards: MergeableCard[]; unmatchedEvents: EventItem[] } {
  const mergedCards = [...cards];
  const unmatchedEvents: EventItem[] = [];

  for (const event of events) {
    const eventDay = localDayDate(new Date(event.starts_at), timeZone);
    const eventVenue = event.venue_name;
    const span = weeklySpanOf(event);

    let bestIndex = -1;
    let bestScore = -1;
    for (let i = 0; i < mergedCards.length; i++) {
      const card = mergedCards[i];
      if (span) {
        if (!isWeeklySpanMatch(card, event, span)) continue;
      } else {
        if (card.occurrence.dayDate !== eventDay) continue;
        // Raw titles first; failing that, the same titles with the venue
        // stripped, but only when both sides name the same venue.
        const venueStrippedMatch =
          isSameVenue(cardVenue(card), eventVenue) &&
          isTitleMatchAtVenue(cardTitle(card), cardVenue(card), event.name, eventVenue);
        if (!isTitleMatch(cardTitle(card), event.name) && !venueStrippedMatch) continue;
      }
      let score = titleSimilarity(cardTitle(card), event.name);
      // Venue agreement only ever nudges a tie between two same-day,
      // already-matching candidates towards the more plausible one — it
      // never decides whether something matches in the first place.
      const venue = cardVenue(card);
      if (venue && eventVenue && isTitleMatch(venue, eventVenue)) {
        score += 0.001;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0) {
      mergedCards[bestIndex] = withBorrowedBookingUrl(mergedCards[bestIndex], event.ticket_url);
      continue;
    }
    unmatchedEvents.push(event);
  }

  return { cards: mergedCards, unmatchedEvents };
}

/** Two rows only count as the same performance when their starts are within
 *  this of each other — keeps a matinee and an evening show apart. */
export const DEDUPE_MAX_START_GAP_MS = 3 * 60 * 60 * 1000;

/** True if `candidate` should replace `existing` when both describe the same
 *  event: has a price > has an image > provider priority > earlier start. */
function isBetterProviderEvent(candidate: EventItem, existing: EventItem): boolean {
  const cPrice = candidate.price_from != null;
  const ePrice = existing.price_from != null;
  if (cPrice !== ePrice) return cPrice;

  const cImage = candidate.image_url != null;
  const eImage = existing.image_url != null;
  if (cImage !== eImage) return cImage;

  const cPri = PROVIDER_PRIORITY[candidate.provider] ?? 0;
  const ePri = PROVIDER_PRIORITY[existing.provider] ?? 0;
  if (cPri !== ePri) return cPri > ePri;

  // Final tiebreak: the earlier start (the door/on-sale time most likely to
  // be correct when times disagree slightly).
  return new Date(candidate.starts_at).getTime() < new Date(existing.starts_at).getTime();
}

/**
 * Collapses provider-vs-provider duplicates — Ticketmaster, Skiddle and
 * Songkick regularly list the same gig, and because each provider upserts on
 * its own (provider, provider_event_id) the DB holds them as separate rows
 * (the ingest-time cross-source dedupe in scripts/daily-sources.mjs only
 * works within one run).
 *
 * Two rows are the same event when their normalised titles (venue/city
 * suffixes stripped — see lib/events/identity.ts, "Don Broco @ Edinburgh Corn
 * Exchange" == "Don Broco"), local calendar day and venue key all agree AND
 * their start times are within `DEDUPE_MAX_START_GAP_MS`, so a matinee and an
 * evening show at one venue stay separate, as do two different acts on one
 * night. If either row has no venue, title + day + the time guard decide.
 * On a collapse the better row is kept (`isBetterProviderEvent`); order of
 * first appearance is preserved.
 */
export function dedupeProviderEvents(events: EventItem[], timeZone: string): EventItem[] {
  const out: EventItem[] = [];
  // title|day -> indexes into `out` of the kept rows in that bucket
  const buckets = new Map<string, number[]>();
  const venueKeys: string[] = [];

  for (const event of events) {
    const dayDate = localDayDate(new Date(event.starts_at), timeZone);
    const title = normalizeText(normalizeEventTitle(event.name, event.venue_name)) || event.name.trim().toLowerCase();
    const venueKey = normalizeVenueKey(event.venue_name);
    const bucketKey = `${title}|${dayDate}`;
    const startMs = new Date(event.starts_at).getTime();

    const bucket = buckets.get(bucketKey) ?? [];
    const matchIdx = bucket.find((idx) => {
      const other = out[idx];
      const otherKey = venueKeys[idx];
      const venueCompatible = venueKey === NO_VENUE_KEY || otherKey === NO_VENUE_KEY || venueKey === otherKey;
      if (!venueCompatible) return false;
      return Math.abs(new Date(other.starts_at).getTime() - startMs) <= DEDUPE_MAX_START_GAP_MS;
    });

    if (matchIdx === undefined) {
      bucket.push(out.length);
      buckets.set(bucketKey, bucket);
      out.push(event);
      venueKeys.push(venueKey);
    } else if (isBetterProviderEvent(event, out[matchIdx])) {
      out[matchIdx] = event;
      // Keep a real venue key if the survivor lacked one.
      if (venueKey !== NO_VENUE_KEY) venueKeys[matchIdx] = venueKey;
    } else if (venueKeys[matchIdx] === NO_VENUE_KEY) {
      venueKeys[matchIdx] = venueKey;
    }
  }
  return out;
}

/** Happening kinds `dedupeHappenings` collapses: dated one-offs. Deals,
 *  tours and activities can share a title and a day and still be different
 *  offers (a student rate vs an over-60s one), so they are left to
 *  scripts/dedupe-happenings.mjs, which also compares price and eligibility. */
const DEDUPE_HAPPENING_KINDS = new Set<Happening["kind"]>(["event", "festival"]);
/** Weekly rows are a venue's standing line-up ("The Saturday Show", "The
 *  Early Saturday Show"): never collapsed here. */
const DEDUPE_HAPPENING_RECURRENCES = new Set(["once", "annual", "dates"]);
const HAPPENING_DEDUPE_LOOKAHEAD_MS = 366 * 86_400_000;

/** The local wall-clock time of `iso`, or null when it's midnight (a date-only
 *  row stored as 00:00, e.g. Ticketmaster UK research rows). */
function clockTime(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  return hm === "00:00" ? null : hm;
}

/** Keep order for two copies of one happening: a real start time, a photo,
 *  a booking link, a place link, then the more recently verified. */
function happeningKeepScore(h: Happening, timeZone: string): number {
  return (
    (clockTime(h.starts_at, timeZone) ? 16 : 0) +
    (h.image_url ? 8 : 0) +
    (h.booking_url ? 4 : 0) +
    (h.place_id || (h.lat != null && h.lng != null) ? 2 : 0)
  );
}

function isBetterHappening(candidate: Happening, existing: Happening, timeZone: string): boolean {
  const c = happeningKeepScore(candidate, timeZone);
  const e = happeningKeepScore(existing, timeZone);
  if (c !== e) return c > e;
  return (candidate.verified_at ?? "") > (existing.verified_at ?? "");
}

/**
 * Collapses curated happenings that are the same dated event researched
 * twice, usually from two listings of one Ticketmaster page: "The Classic
 * Rock Show" (Ticketmaster UK, 00:00) and "The Classic Rock Show at Usher
 * Hall" (Ticketmaster, 19:00); "Edinburgh's Hogmanay" and "Edinburgh's
 * Hogmanay 2026/27". Two rows are one when they're the same kind (a dated
 * event or festival, never a weekly one: see `DEDUPE_HAPPENING_KINDS`), their
 * next occurrences fall on the same local day, their titles are identical
 * once the venue name and years are stripped (`isSameTitleAtVenue`; stricter
 * than the provider merge, since both sides here are curated and a wrong
 * merge hides a real event), and their venues agree. A festival may name its
 * venue loosely ("Various city centre venues"), so for festivals the venue
 * check is skipped. When both rows carry a real clock time more than
 * `DEDUPE_MAX_START_GAP_MS` apart they stay separate (a matinee and an
 * evening show).
 *
 * The survivor (`isBetterHappening`) borrows a photo or booking link from the
 * row it replaces when it has none. Order of first appearance is kept.
 * Read-time only: the duplicate stays live in the DB; making it dormant is
 * scripts/dedupe-happenings.mjs's job.
 */
export function dedupeHappenings(happenings: Happening[], now: Date, timeZone: string): Happening[] {
  const to = new Date(now.getTime() + HAPPENING_DEDUPE_LOOKAHEAD_MS);
  const out: Happening[] = [];
  const byDay = new Map<string, number[]>(); // "kind|day" -> indexes into `out`

  for (const h of happenings) {
    if (!DEDUPE_HAPPENING_KINDS.has(h.kind) || !DEDUPE_HAPPENING_RECURRENCES.has(normalizeRecurrence(h.recurrence).type)) {
      out.push(h);
      continue;
    }
    const occ = nextOccurrence(h, now, to, timeZone);
    if (!occ) {
      out.push(h);
      continue;
    }
    const key = `${h.kind}|${occ.dayDate}`;
    const bucket = byDay.get(key) ?? [];
    const matchIdx = bucket.find((idx) => {
      const other = out[idx];
      if (h.kind !== "festival" && !isSameVenue(h.venue_name, other.venue_name)) return false;
      if (!isSameTitleAtVenue(h.title, h.venue_name, other.title, other.venue_name)) return false;
      const a = clockTime(h.starts_at, timeZone) && h.starts_at ? Date.parse(h.starts_at) : null;
      const b = clockTime(other.starts_at, timeZone) && other.starts_at ? Date.parse(other.starts_at) : null;
      return a == null || b == null || Math.abs(a - b) <= DEDUPE_MAX_START_GAP_MS;
    });

    if (matchIdx === undefined) {
      bucket.push(out.length);
      byDay.set(key, bucket);
      out.push(h);
      continue;
    }
    const existing = out[matchIdx];
    const [keep, drop] = isBetterHappening(h, existing, timeZone) ? [h, existing] : [existing, h];
    out[matchIdx] = {
      ...keep,
      image_url: keep.image_url ?? drop.image_url,
      booking_url: keep.booking_url ?? drop.booking_url,
    };
  }
  return out;
}
