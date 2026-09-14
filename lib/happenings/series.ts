/**
 * Fomo Happenings — deterministic series grouping.
 *
 * Collapses near-identical happenings that are really the SAME thing at
 * different locations (or, in principle, split across dates) into one
 * series — "Parkrun · 3 locations" instead of three separate "Cramond
 * parkrun" / "Holyrood parkrun" / "Portobello parkrun" cards. No AI: every
 * signal here is a plain field/string comparison.
 *
 * Built by querying the live `happenings` catalog directly (104 live rows
 * at the time of writing) rather than guessing at a rule in the abstract —
 * see this module's companion report for the full list. The one real
 * series in the current data is Edinburgh's three parkruns (Cramond,
 * Holyrood, Portobello): all `kind: "activity"`, `category: "outdoors"`,
 * `source_name: "parkrun.org.uk"`.
 *
 * ## Why this is conservative
 *
 * A naive "shared word" matcher is a landmine — the worked example that
 * motivated this file is the street "Thistle Street" wrongly merging into
 * the venue "Thistle Street Bar" in an earlier version of this idea. Two
 * more traps turned up while building the rule against the real catalog:
 *
 *   - Every Usher Hall gig's title ends "... Usher Hall". A matcher that
 *     just splits titles into words would treat "usher"/"hall" as a shared
 *     anchor and merge unrelated concerts (Marillion, Del Amitri, Roger
 *     Taylor, ...) into one fake "series".
 *   - "Tony Hadley Christmas Big Band Usher Hall" and "Muppet Christmas
 *     Carol in Concert Usher Hall" share the word "Christmas" — a seasonal
 *     adjective, not an identity, and again two unrelated one-off gigs.
 *
 * Three defences, applied in order, are what keep this safe:
 *
 *   1. SCOPE — only the `kind`s the task's own examples are about
 *      (`activity`, `tour`, `free_access`, `festival`) are ever grouped.
 *      `deal` is excluded: venue-grouping already collapses a venue's
 *      deals onto one card (lib/happenings/groups.ts /
 *      app/api/feed/route.ts's `buildDealsSection`), which is a DIFFERENT
 *      and already-solved problem ("here's everything on offer at this
 *      venue"), not "these are the same offer at different venues" — see
 *      e.g. Camera Obscura's three distinct, differently-worded deals,
 *      which must never collapse into one. `event` is excluded outright:
 *      one-off ticketed gigs (Skiddle/Ticketmaster) are exactly where a
 *      shared venue name or a seasonal word like "Christmas"/"Live"
 *      collides across genuinely unrelated shows, verified against every
 *      live `event` row while building this file, and the brief's own
 *      examples never include one.
 *   2. ANCHOR TOKENS — a title is reduced to its "identity" words by
 *      stripping (a) THIS happening's own venue name / district / address
 *      words (kills the Usher Hall trap at the source — a venue's own
 *      words can never survive to become its anchor), (b) generic
 *      connector words, weekday names, and `CITY.name`/`CITY.districts`,
 *      and (c) a short denylist of generic event-description nouns and
 *      adjectives that recur across otherwise-unrelated rows (kills the
 *      Christmas trap). Two happenings can only match if they share a
 *      surviving token of at least `ANCHOR_MIN_LENGTH` characters — for
 *      the parkruns, that token is "parkrun" itself.
 *   3. COMPATIBILITY — even a shared anchor must still agree on `kind`
 *      (exact), `category` (exact — no null-wildcarding: every real match
 *      found here already has identical categories, so requiring exact
 *      equality costs nothing and is strictly safer), and organiser
 *      (`booking_url` hostname when both sides have one, else exact
 *      `source_name`) before two happenings are allowed into the same
 *      group.
 *
 * ## Grouping mechanics
 *
 * Deliberately NOT a pairwise/transitive union-find: chaining A~B~C could
 * merge A and C on nothing more than each separately sharing a different
 * word with B, without A and C ever agreeing on anything themselves. This
 * instead buckets every happening by `(anchor token, kind, category,
 * organiser)`, keeps only buckets with 2+ members, and — largest bucket
 * first — lets each happening claim at most one final group (its
 * strongest match), so a happening with several anchor words can never
 * end up glued to two different unrelated groups through weak, indirect
 * links.
 */
import { CITY } from "@/lib/city";
import type { Happening, HappeningKind } from "@/lib/happenings/types";

/** A shared word shorter than this is far more likely to be a coincidence
 *  ("live", "free", "walk") than a real identity — see the module doc's
 *  "Christmas"/Usher-Hall traps. */
const ANCHOR_MIN_LENGTH = 5;

/** Only these kinds are ever grouped — see the module doc's SCOPE defence. */
const SERIES_ELIGIBLE_KINDS: ReadonlySet<HappeningKind> = new Set([
  "activity",
  "tour",
  "free_access",
  "festival",
]);

const WEEKDAY_WORDS = new Set([
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
]);

const CONNECTOR_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "for", "with", "from",
  "at", "in", "on", "by", "near", "around", "along", "across", "over", "under",
]);

/**
 * Generic event-description words that recur across unrelated happenings
 * and must never serve as a shared "identity" anchor by themselves — see
 * the module doc's Usher-Hall/Christmas examples. Deliberately NOT venue
 * nouns like "park"/"street"/"hall" — those are handled by stripping each
 * happening's OWN venue/district/address words instead (see
 * `ownLocationNoise`), which only ever disqualifies a word for the row it
 * actually belongs to, never for another row's title.
 */
const GENERIC_DENYLIST = new Set([
  "free", "tour", "tours", "walk", "walking", "walks", "market", "festival",
  "show", "event", "events", "party", "night", "nights", "day", "days",
  "club", "centre", "center", "museum", "gallery", "galleries", "garden",
  "gardens", "hall", "house", "weekend", "programme", "program", "tickets",
  "ticket", "concert", "live", "christmas", "entry", "access", "pass",
  "guided", "daily", "concession", "original", "family", "friday", "fridays",
  "saturdays", "sundays", "annual", "official", "public", "sale", "group",
  "student", "resident", "residents", "members", "member", "trail", "workshop",
]);

/** Lowercase, strip a trailing possessive ("Arthur's" -> "arthur",
 *  "Edinburgh's" -> "edinburgh"), then drop anything that isn't a letter or
 *  digit. Never a token that mixes letters and digits differently than the
 *  source — this is deliberately dumb, no stemming beyond the possessive. */
function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function wordsOf(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  const out = new Set<string>();
  for (const raw of text.split(/[\s,/()–—-]+/)) {
    const w = normalizeWord(raw);
    if (w) out.add(w);
  }
  return out;
}

/** Words that identify WHERE a specific happening is, not WHAT it is —
 *  stripped from its own title before anchor extraction. Built fresh per
 *  happening (never shared across rows), so a word can only disqualify
 *  itself, never another row — this is what keeps "Usher Hall" from ever
 *  becoming a cross-row anchor. */
function ownLocationNoise(h: Happening): Set<string> {
  const words = new Set<string>();
  for (const w of wordsOf(h.venue_name)) words.add(w);
  for (const w of wordsOf(h.district)) words.add(w);
  for (const w of wordsOf(h.address)) words.add(w);
  for (const d of CITY.districts) for (const w of wordsOf(d)) words.add(w);
  for (const w of wordsOf(CITY.name)) words.add(w);
  return words;
}

/** The surviving "identity" tokens for one happening — see the module doc's
 *  ANCHOR TOKENS defence. */
function anchorTokens(h: Happening): Set<string> {
  const noise = ownLocationNoise(h);
  const out = new Set<string>();
  for (const raw of h.title.split(/[\s,/()–—-]+/)) {
    const w = normalizeWord(raw);
    if (!w) continue;
    if (/^\d+$/.test(w)) continue; // bare years/numbers never identify anything
    if (w.length < ANCHOR_MIN_LENGTH) continue;
    if (CONNECTOR_STOPWORDS.has(w)) continue;
    if (WEEKDAY_WORDS.has(w)) continue;
    if (GENERIC_DENYLIST.has(w)) continue;
    if (noise.has(w)) continue;
    out.add(w);
  }
  return out;
}

function bookingHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** `booking_url` hostname when both sides have one (the stronger signal —
 *  two different rows both booking through the same third-party platform
 *  domain), else the raw `source_name` string. See the module doc's
 *  COMPATIBILITY defence for why this must agree, not just the anchor word. */
function organiserKey(h: Happening): string {
  const host = bookingHost(h.booking_url);
  return host ? `host:${host}` : `src:${h.source_name}`;
}

function titleCase(word: string): string {
  return word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1);
}

export interface HappeningSeriesGroup {
  /** Stable within one grouping run (same anchor token + kind + category +
   *  organiser always produces the same key) — safe as a React list key,
   *  but NOT a database id and not guaranteed stable across catalog edits. */
  key: string;
  /** Display title, e.g. "Parkrun" — the shared anchor word, title-cased. */
  title: string;
  /** Every member, in the order `happenings` was given. Always length >= 2 — a "group" of one is just a happening, not a series. */
  members: Happening[];
}

/**
 * Groups `happenings` into series. Callers should pass the FULL list they
 * have (including deals and events) rather than pre-filtering — kinds
 * outside `SERIES_ELIGIBLE_KINDS` are simply never grouped, so nothing bad
 * happens if a caller forgets to filter, and this stays the one place the
 * scope decision lives.
 *
 * See the module doc for the full algorithm; in short: bucket by
 * `(anchor token, kind, category, organiser)`, drop buckets under 2
 * members, then — largest bucket first — let each happening claim at most
 * one final group.
 */
export function groupHappeningsIntoSeries(happenings: Happening[]): HappeningSeriesGroup[] {
  const eligible = happenings.filter((h) => SERIES_ELIGIBLE_KINDS.has(h.kind));

  const buckets = new Map<string, { token: string; members: Happening[] }>();
  for (const h of eligible) {
    const tokens = anchorTokens(h);
    if (tokens.size === 0) continue;
    const organiser = organiserKey(h);
    for (const token of tokens) {
      const key = `${token}::${h.kind}::${h.category ?? "null"}::${organiser}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.members.push(h);
      else buckets.set(key, { token, members: [h] });
    }
  }

  // Largest bucket first (ties broken by key, for determinism) so a
  // happening that could in principle match more than one qualifying
  // bucket claims its strongest — most-corroborated — match.
  const candidates = [...buckets.entries()]
    .filter(([, bucket]) => bucket.members.length >= 2)
    .sort((a, b) => b[1].members.length - a[1].members.length || a[0].localeCompare(b[0]));

  const claimed = new Set<string>();
  const groups: HappeningSeriesGroup[] = [];
  for (const [key, bucket] of candidates) {
    const unclaimed = bucket.members.filter((m) => !claimed.has(m.id));
    if (unclaimed.length < 2) continue; // everyone left here already belongs to a stronger group
    for (const m of unclaimed) claimed.add(m.id);
    groups.push({ key, title: titleCase(bucket.token), members: unclaimed });
  }

  groups.sort((a, b) => a.title.localeCompare(b.title));
  return groups;
}

/** `happeningId -> group` for every happening that IS part of a series (2+
 *  members). A happening with no series membership simply has no entry. */
export function seriesLookup(groups: HappeningSeriesGroup[]): Map<string, HappeningSeriesGroup> {
  const map = new Map<string, HappeningSeriesGroup>();
  for (const g of groups) for (const m of g.members) map.set(m.id, g);
  return map;
}
