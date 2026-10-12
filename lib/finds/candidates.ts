/**
 * Finds suggest — candidate selection, ranking and copy fallbacks.
 *
 * The pure half of `scripts/finds.ts suggest` ("Fomo Finds" on Instagram,
 * "For you" in the app): given the live happenings and the upcoming events it
 * decides which are worth suggesting this week, scores them and picks the top
 * few with a happening/event mix. No fetch, no DB, no DeepSeek, `now` is a
 * parameter — so lib/finds/candidates.test.ts runs it on fixtures.
 *
 * Scoring goes through the `Scorers` interface so tests can pass stubs and
 * assert filters/mix without depending on hero.ts's weights; `heroScorers`
 * (below) is the real thing — lib/happenings/hero.ts — and what
 * scripts/finds.ts uses.
 *
 * Same wedge rules as scripts/lib/weekly-picks.mjs: students + young
 * professionals, so family-only (`category: 'family'`) and over-60-only
 * (`eligibility: 'over_60'`) rows are never suggested.
 */
import { CITY } from "@/lib/city";
import { eventRecommendationScore, happeningRecommendationScore } from "@/lib/happenings/hero";
import { eventHasEnded } from "@/lib/events/format";
import { isStale, moneyLabel, savingBadgeLabel, shortDayLabel } from "@/lib/happenings/format";
import { isGenuineDeal } from "@/lib/happenings/groups";
import {
  addDays,
  localDayDate,
  nextOccurrence,
  normalizeRecurrence,
  weekdayOf,
} from "@/lib/happenings/occurrence";
import type { Happening, Occurrence } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";
import type { FindRow, FindSubjectType } from "@/lib/finds/types";
import { findKey } from "@/lib/finds/types";

/** An event is a candidate only when free or at most this many pounds (same "cheap" line as weekly-picks and the feed). */
export const CHEAP_EVENT_MAX_GBP = 15;
/** Longest `why` we store; the IG slides and the card both truncate past roughly this. */
export const WHY_MAX_CHARS = 90;

const EXCLUDED_ELIGIBILITY = new Set(["over_60"]);
const EXCLUDED_CATEGORY = new Set(["family"]);

/** Value sub-score ceiling for evergreen deals; mirrors hero.ts's HERO_VALUE_CAP (35) so the two scales stay comparable. */
const EVERGREEN_VALUE_CAP = 35;
/** `kind: 'festival'` rows are programme/ticket-release noise next to a concrete steal — same down-rank weekly-picks applies. */
const FESTIVAL_PENALTY = 10;

export interface Scored {
  score: number;
  reason: string | null;
}

/** The two hero.ts scorers, injected. `h`/`occurrence` is a dated happening occurrence; `always` rows never reach `happening`. */
export interface Scorers {
  happening(h: Happening, occurrence: Occurrence, now: Date): Scored;
  event(e: EventItem, now: Date): Scored;
}

/** The production scorers: the Home hero's recommendation scores (lib/happenings/hero.ts). */
export const heroScorers: Scorers = {
  happening: (h, occurrence, now) => happeningRecommendationScore(h, occurrence, now),
  event: (e, now) => eventRecommendationScore(e, now),
};

/** One suggestable subject with everything the table, the AI prompt and the upsert need. */
export interface FindCandidate {
  subject_type: FindSubjectType;
  subject_id: string;
  title: string;
  venue: string | null;
  /** "Sat 17 Oct 7:30pm", "Sat 17 Oct", or "Any day" for an evergreen deal. */
  when: string;
  /** "Free", "£8 wristband", "From £12", or "" when unknown (never a placeholder). */
  price: string;
  /** Extra facts for the AI prompt: the offer's own wording, clipped. */
  detail: string;
  score: number;
  /** hero.ts's short "why this" string, if any factor was distinctive. */
  reason: string | null;
  /** Epoch ms of the next start/occurrence day; ordering tie-break only. */
  sortMs: number;
}

// --- gates -------------------------------------------------------------

/** Wedge rules shared by happenings and events (events carry no `eligibility`). */
export function passesAudienceGate(item: { eligibility?: string | null; category?: string | null }): boolean {
  if (item.eligibility && EXCLUDED_ELIGIBILITY.has(item.eligibility)) return false;
  if (item.category && EXCLUDED_CATEGORY.has(item.category)) return false;
  return true;
}

/**
 * Whether a happening applies in the city — the same rule as
 * lib/db/happenings.ts's listLiveHappenings query (national rows everywhere,
 * region rows for the city's region, venue/city rows for the city itself),
 * re-done in JS because the script reads with a plain `select=*`.
 */
export function happeningAppliesInCity(h: Pick<Happening, "scope" | "region" | "city">): boolean {
  if (h.scope === "national") return true;
  if (h.scope === "region") return h.region === CITY.region;
  return h.city === CITY.name;
}

/** Events the feed would list: `status` is absent before supabase/add_event_lifecycle.sql, which reads as active. */
function eventIsActive(e: EventItem): boolean {
  return e.status == null || e.status === "active";
}

/** Free, or priced at or under the cheap line. An unpriced non-free event is NOT a candidate: a steal needs a price to be a steal. */
export function eventIsFreeOrCheap(e: Pick<EventItem, "is_free" | "price_from">): boolean {
  if (e.is_free) return true;
  return typeof e.price_from === "number" && e.price_from <= CHEAP_EVENT_MAX_GBP;
}

// --- evergreen scoring -------------------------------------------------

/**
 * Score for an `always` (evergreen) genuine deal. hero.ts's
 * `happeningRecommendationScore` is defined only for dated occurrences — it
 * scores "last chance" urgency, which an always-on deal doesn't have — so these
 * rows get the SAME non-urgency factors computed here:
 *   value (free +30 / genuine deal +20, plus up to +15 of saving_amount,
 *   capped at 35), curator priority (±15), image (+8 / -20), stale
 *   verification (-25) and narrow eligibility (-10).
 * No actionability or scarcity term, so an evergreen deal scores lower than the
 * same offer with a deadline this week — right for a weekly "steals" list,
 * where timely beats permanent, while a strong evergreen (free, imaged,
 * verified) still clears the dated mid-pack.
 */
export function evergreenDealScore(h: Happening, now: Date): Scored {
  let value = 0;
  if (h.is_free) value += 30;
  else if (isGenuineDeal(h)) value += 20;
  if (h.saving_amount != null) value += Math.min(h.saving_amount, 15);

  let score = Math.min(value, EVERGREEN_VALUE_CAP);
  score += Math.min(Math.max((h.priority ?? 50) - 50, -15), 15);
  score += h.image_url ? 8 : -20;
  if (isStale(h.verified_at, now)) score -= 25;
  if (h.eligibility !== "anyone" && h.eligibility !== "member" && h.eligibility !== "cardholder") score -= 10;

  const reason = h.is_free ? "Free · any day" : `${savingBadgeLabel(h) ?? "Genuine deal"} · any day`;
  return { score, reason };
}

// --- labels ------------------------------------------------------------

const clockFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: CITY.timezone,
  hour: "numeric",
  minute: "2-digit",
  hourCycle: "h12",
});

function isMidnightUtc(iso: string): boolean {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
}

/** "7:30pm" / "8pm" in the city's zone. */
function clock(iso: string): string {
  return clockFormatter.format(new Date(iso)).replace(/^0/, "").replace(":00", "").toLowerCase().replace(/\s+/g, "");
}

function happeningWhen(occ: Occurrence, recurrenceType: string): string {
  if (recurrenceType === "always") return "Any day";
  const day = shortDayLabel(occ.dayDate);
  // A date-only row is stored at 00:00 UTC, which would read "1am" in BST.
  return occ.exact && occ.startsAt && !isMidnightUtc(occ.startsAt) ? `${day} ${clock(occ.startsAt)}` : day;
}

function eventWhen(e: EventItem): string {
  const day = shortDayLabel(localDayDate(new Date(e.starts_at)));
  return isMidnightUtc(e.starts_at) ? day : `${day} ${clock(e.starts_at)}`;
}

function happeningPrice(h: Happening): string {
  if (h.is_free) return "Free";
  return savingBadgeLabel(h) ?? h.price_text ?? (h.saving_amount != null ? moneyLabel(h.saving_amount, h.currency) : "");
}

function eventPrice(e: EventItem): string {
  if (e.is_free) return "Free";
  return e.price_from != null ? `From ${moneyLabel(e.price_from, e.currency)}` : "";
}

function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Title / when / price for a subject already in `finds`, for `list` — same wording the suggest table uses. */
export function describeSubject(
  type: FindSubjectType,
  subject: Happening | EventItem,
  now: Date
): { title: string; when: string; price: string } {
  if (type === "event") {
    const e = subject as EventItem;
    return { title: e.name, when: eventWhen(e), price: eventPrice(e) };
  }
  const h = subject as Happening;
  const occ = nextOccurrence(h, now, new Date(now.getTime() + 366 * 86_400_000));
  return {
    title: h.title,
    when: occ ? happeningWhen(occ, normalizeRecurrence(h.recurrence).type) : "Ended",
    price: happeningPrice(h),
  };
}

// --- selection ---------------------------------------------------------

export interface SelectOptions {
  happenings: readonly Happening[];
  events: readonly EventItem[];
  now: Date;
  /** Lookahead window in days (default 10). */
  days?: number;
  /** How many candidates to return (default 12). */
  limit?: number;
  /** `findKey(type, id)` of subjects never to suggest — Finds already live or retired. */
  excluded: ReadonlySet<string>;
  scorers: Scorers;
}

/**
 * Every suggestable subject, scored — before the top-N cut. Exported on its
 * own so tests can assert the filters without also caring about the mix.
 *
 * Happenings: status live, applies in the city, passes the wedge gate, not past
 * its season. A dated one needs an occurrence in the next `days`; an `always`
 * row is only taken when it is a genuine deal (a bare "free any time" place
 * listing isn't a steal). Events: active, starting in the next `days`, free or
 * ≤ £15. Events collapse by title (a daily tour is 31 rows, one candidate —
 * the best-scoring one), and an event matching a happening candidate's title
 * on the same day yields to the happening, as weekly-picks does.
 */
export function scoreCandidates(opts: SelectOptions): FindCandidate[] {
  const { now, scorers, excluded } = opts;
  const days = opts.days ?? 10;
  const to = new Date(now.getTime() + days * 86_400_000);
  const today = localDayDate(now);
  const out: FindCandidate[] = [];
  const happeningDayKeys = new Set<string>();

  for (const h of opts.happenings) {
    if (h.status !== "live" || !h.title) continue;
    if (excluded.has(findKey("happening", h.id))) continue;
    if (!happeningAppliesInCity(h) || !passesAudienceGate(h)) continue;
    if (h.season_valid_until && h.season_valid_until < today) continue;

    const recurrenceType = normalizeRecurrence(h.recurrence).type;
    if (recurrenceType === "always" && !isGenuineDeal(h)) continue;
    const occ = nextOccurrence(h, now, to);
    if (!occ) continue;

    const scored =
      recurrenceType === "always" ? evergreenDealScore(h, now) : scorers.happening(h, occ, now);
    const score = scored.score - (h.kind === "festival" ? FESTIVAL_PENALTY : 0);
    happeningDayKeys.add(`${titleKey(h.title)}|${occ.dayDate}`);
    out.push({
      subject_type: "happening",
      subject_id: h.id,
      title: h.title,
      venue: h.venue_name,
      when: happeningWhen(occ, recurrenceType),
      price: happeningPrice(h),
      detail: [h.saving_label, h.price_text, h.includes, h.summary, h.redemption_note]
        .filter((x): x is string => !!x)
        .map((x) => clip(x, 140))
        .join(" | "),
      score,
      reason: scored.reason,
      sortMs: occ.startsAt ? new Date(occ.startsAt).getTime() : new Date(`${occ.dayDate}T00:00:00Z`).getTime(),
    });
  }

  const bestEventByTitle = new Map<string, FindCandidate>();
  for (const e of opts.events) {
    if (!e.name || !e.starts_at || !eventIsActive(e)) continue;
    if (excluded.has(findKey("event", e.id))) continue;
    if (!passesAudienceGate(e) || !eventIsFreeOrCheap(e)) continue;
    const startMs = new Date(e.starts_at).getTime();
    if (Number.isNaN(startMs) || eventHasEnded(e, now) || startMs > to.getTime()) continue;
    // "Starts in the next N days": an event already under way isn't a fresh steal.
    if (startMs < now.getTime()) continue;
    const key = titleKey(e.name);
    if (happeningDayKeys.has(`${key}|${localDayDate(new Date(startMs))}`)) continue;

    const scored = scorers.event(e, now);
    const candidate: FindCandidate = {
      subject_type: "event",
      subject_id: e.id,
      title: e.name,
      venue: e.venue_name,
      when: eventWhen(e),
      price: eventPrice(e),
      detail: clip(e.description, 200),
      score: scored.score,
      reason: scored.reason,
      sortMs: startMs,
    };
    const prior = bestEventByTitle.get(key);
    if (!prior || candidate.score > prior.score || (candidate.score === prior.score && candidate.sortMs < prior.sortMs)) {
      bestEventByTitle.set(key, candidate);
    }
  }
  out.push(...bestEventByTitle.values());
  return out;
}

/** Score desc, then soonest, then id — total order so ranking never flickers between runs. */
function byScore(a: FindCandidate, b: FindCandidate): number {
  return b.score - a.score || a.sortMs - b.sortMs || a.subject_id.localeCompare(b.subject_id);
}

/**
 * The top `limit` candidates with a happening/event mix: events are capped at
 * half the slots (rounded up) on the first pass so a wave of cheap gigs can't
 * crowd out the deals the list exists for. If happenings run out before the
 * list is full, the skipped events backfill the remaining slots rather than
 * leaving it short. Result is in score order.
 */
export function selectCandidates(opts: SelectOptions): FindCandidate[] {
  const limit = opts.limit ?? 12;
  const ranked = scoreCandidates(opts).sort(byScore);
  const eventCap = Math.ceil(limit / 2);
  const picked: FindCandidate[] = [];
  const skippedEvents: FindCandidate[] = [];
  let events = 0;
  for (const c of ranked) {
    if (picked.length >= limit) break;
    if (c.subject_type === "event" && events >= eventCap) {
      skippedEvents.push(c);
      continue;
    }
    if (c.subject_type === "event") events += 1;
    picked.push(c);
  }
  for (const c of skippedEvents) {
    if (picked.length >= limit) break;
    picked.push(c);
  }
  return picked.sort(byScore);
}

// --- copy: Fomo level + why, with and without the AI ---------------------

/** Fomo level from a hero-scale score. Thresholds sit on the typical spread (free + image + this-week ≈ 60-90, a plain priced event ≈ 20-40). */
export function levelFromScore(score: number): number {
  if (score >= 75) return 5;
  if (score >= 60) return 4;
  if (score >= 45) return 3;
  if (score >= 30) return 2;
  return 1;
}

/** Trim to the `why` budget on a word boundary, adding an ellipsis only when something was cut. */
export function clipWhy(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= WHY_MAX_CHARS) return t;
  const cut = t.slice(0, WHY_MAX_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[ ,;:.-]+$/, "")}…`;
}

/**
 * Non-AI `why`: the hero reason ("Free · tomorrow") plus venue, else the price
 * label plus venue, else a neutral line. Only states what's in the data — no
 * price is invented when none is known.
 */
export function fallbackWhy(c: Pick<FindCandidate, "reason" | "price" | "venue">): string {
  const head = c.reason ?? (c.price || "");
  const at = c.venue ? ` at ${c.venue}` : "";
  const base = head ? `${head}${at}` : c.venue ? `On at ${c.venue}` : "Worth a look this week";
  return clipWhy(base.charAt(0).toUpperCase() + base.slice(1));
}

export interface Draft {
  why: string;
  fomo_level: number;
}

/**
 * Validate the model's tool output against the candidate list: `finds` is an
 * array of `{ n, why, fomo_level }` with `n` the 1-based candidate position.
 * Anything malformed (unknown n, empty why, non-numeric level) is skipped so
 * that candidate falls back to the template; levels are clamped to 1-5 and
 * whys clipped to the budget. Returns a map keyed by candidate index (0-based).
 */
export function parseAiDrafts(input: unknown, count: number): Map<number, Draft> {
  const out = new Map<number, Draft>();
  const finds = (input as { finds?: unknown } | null)?.finds;
  if (!Array.isArray(finds)) return out;
  for (const item of finds) {
    const f = item as { n?: unknown; why?: unknown; fomo_level?: unknown } | null;
    const n = Number(f?.n);
    const level = Math.round(Number(f?.fomo_level));
    if (!Number.isInteger(n) || n < 1 || n > count) continue;
    if (typeof f?.why !== "string" || !f.why.trim() || !Number.isFinite(level)) continue;
    out.set(n - 1, { why: clipWhy(f.why), fomo_level: Math.min(5, Math.max(1, level)) });
  }
  return out;
}

/** The Friday (Europe/London) the suggestions are for: today if it is Friday, else the next one — same "coming Friday" rule as weekly-picks. */
export function comingFriday(now: Date): string {
  const today = localDayDate(now);
  return addDays(today, (5 - weekdayOf(today) + 7) % 7);
}

/** Row fields for the upsert; `status` is always 'suggested' here — only `approve` makes a row live. */
export function toSuggestionRow(
  c: FindCandidate,
  draft: Draft,
  weekOf: string
): Pick<FindRow, "subject_type" | "subject_id" | "why" | "fomo_level" | "score" | "status" | "week_of"> {
  return {
    subject_type: c.subject_type,
    subject_id: c.subject_id,
    why: draft.why,
    fomo_level: draft.fomo_level,
    score: Math.round(c.score * 100) / 100,
    status: "suggested",
    week_of: weekOf,
  };
}
