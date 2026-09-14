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
import { localDayDate } from "@/lib/happenings/occurrence";

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
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  const jaccard = titleSimilarity(a, b);
  const isSubset = containment(ta, tb) === 1;
  return (isSubset && jaccard >= TITLE_MATCH_THRESHOLD) || jaccard >= HIGH_CONFIDENCE_JACCARD;
}

function cardTitle(card: MergeableCard): string {
  return card.kind === "happening" ? card.happening.title : card.title;
}

function cardVenue(card: MergeableCard): string | null {
  return card.kind === "happening" ? card.happening.venue_name : card.lead.venue_name;
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

    let bestIndex = -1;
    let bestScore = -1;
    for (let i = 0; i < mergedCards.length; i++) {
      const card = mergedCards[i];
      if (card.occurrence.dayDate !== eventDay) continue;
      if (!isTitleMatch(cardTitle(card), event.name)) continue;
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

/**
 * Collapses provider-vs-provider duplicates — Ticketmaster and Skiddle both
 * regularly list the same gig. Unlike the happening/event merge above, there
 * is no curated row to defer to here, so this intentionally uses an EXACT
 * normalised-title + same-day key rather than the fuzzy threshold: with two
 * unverified rows and no authoritative one to prefer, a wrong merge would
 * silently destroy one provider's own booking link with no way to recover
 * it, so this only merges when the titles agree after normalisation, not
 * merely when they're similar. Keeps the earliest `starts_at` per key (the
 * on-sale/door time most likely to be correct when times disagree slightly).
 */
export function dedupeProviderEvents(events: EventItem[], timeZone: string): EventItem[] {
  const byKey = new Map<string, EventItem>();
  for (const event of events) {
    const dayDate = localDayDate(new Date(event.starts_at), timeZone);
    const key = `${normalizeText(event.name)}|${dayDate}`;
    const existing = byKey.get(key);
    if (!existing || new Date(event.starts_at).getTime() < new Date(existing.starts_at).getTime()) {
      byKey.set(key, event);
    }
  }
  return Array.from(byKey.values());
}
