/**
 * Fomo Happenings — pure display formatting.
 *
 * Everything here is a deterministic function of its arguments: no fetch, no
 * `server-only`, no dependency on lib/db/*. That is what lets it be unit
 * tested with a plain node/tsx script and fixture data (see the throwaway
 * check used to build this file) instead of a running Supabase instance.
 *
 * Companion to lib/happenings/occurrence.ts, which turns a happening into
 * concrete dated `Occurrence`s — this module turns a `Happening` (+ its
 * occurrence, where relevant) into the strings and buckets the feed renders:
 * saving/price badges, the type tag, "Checked Nd ago" staleness, and the
 * date-bucket a card belongs in.
 */

import { CITY } from "@/lib/city";
import { addDays, daysUntilLastChance, localDayDate, weekdayOf } from "@/lib/happenings/occurrence";
import type { Happening, HappeningEligibility, Occurrence, Recurrence } from "@/lib/happenings/types";

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOL: Record<string, string> = {
  GBP: "£",
  USD: "$",
  EUR: "€",
};

/** "£21", "£4.50" — mirrors lib/events/format.ts's formatEventPrice symbol table. */
export function moneyLabel(amount: number, currency: string | null): string {
  const symbol = CURRENCY_SYMBOL[currency ?? "GBP"] ?? `${currency ?? "GBP"} `;
  const value = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${symbol}${value}`;
}

// ---------------------------------------------------------------------------
// Saving / price badge (top-right pill on the hero and every card)
// ---------------------------------------------------------------------------

/**
 * The top-right badge: "£4 tickets", "2-for-1", "20% off", "Kids free", or
 * "Free". MUST stay short — this sits in a fixed-width pill beside the
 * title on the list card, and a long `saving_label` verbatim ("One free
 * child ticket with each full-paying adult") used to crush the title into a
 * narrow column and truncate the venue line. `saving_label` is the source's
 * own, often-long, phrasing — great as body copy, wrong as a pill — so this
 * extracts a short signal from it (a %, a "£N off", a 2-for-1, a kids-free
 * mention) rather than passing it through. The full `saving_label` still
 * renders verbatim as its own line under the title (see FeedListCard's
 * HappeningRow) — nothing here is lossy, it's just not in the pill.
 */
export function savingBadgeLabel(
  h: Pick<Happening, "saving_label" | "is_free" | "saving_amount" | "currency">
): string | null {
  const label = h.saving_label ?? "";

  const percent = label.match(/(\d+)\s*%/);
  if (percent) return `${percent[1]}% off`;

  const poundsOff = label.match(/£\s*(\d+(?:\.\d+)?)\s*off/i);
  if (poundsOff) return `£${poundsOff[1]} off`;

  if (/\b(kids?|child(?:ren)?)\b.*\bfree\b|\bfree\b.*\b(kids?|child(?:ren)?)\b/i.test(label)) {
    return "Kids free";
  }
  if (/\b2[\s-]?for[\s-]?1\b/i.test(label)) return "2-for-1";

  // A label that's already short enough for the pill and didn't match any
  // of the patterns above is shown as-is — e.g. "£4 tickets" (National
  // Cinema Weekend): it isn't an "off" amount (that deal's `saving_amount`
  // is the discounted PRICE, £4, not a saving), so blindly formatting it as
  // "£4 off" below would misstate the offer. Checking the label's own
  // length first, before falling back to the is_free/saving_amount guesses,
  // avoids that class of mistake for any short label already in good shape.
  if (label && label.length <= 14) return label;

  if (h.is_free) return "Free";

  // No recognizable short form and the label (if any) was too long to show
  // verbatim — fall back to the raw saving_amount, which for a genuine
  // money-off deal is a pounds figure ("£5 off Mary King's Close"). Best
  // -effort: a handful of rows use `saving_amount` for something other than
  // an "off" amount (see the length-gated branch above for the one
  // observed case), so this is a last resort, not a fully general parser.
  if (h.saving_amount != null) return `${moneyLabel(h.saving_amount, h.currency)} off`;

  // Nothing short to show — the caller renders no pill at all rather than
  // squeezing the layout for one, and the full `saving_label` (if any)
  // still shows as body text.
  return null;
}

// ---------------------------------------------------------------------------
// Type tag ("NATIONAL EVENT" / "EVENT" / "DEAL" / "FESTIVAL")
// ---------------------------------------------------------------------------

/**
 * The small uppercase tag on every card. Derived, not stored — `kind` alone
 * only has three values (deal | free_access | festival) and can't
 * distinguish "National Cinema Weekend" (a UK-wide deal) from "The Stand ·
 * Red Raw" (a venue deal with a real showtime) from "Brass Monkey 2-for-1"
 * (an ongoing, timeless deal), but the mockup tags all three differently.
 *
 * Priority: a festival kind always reads FESTIVAL regardless of scope; a
 * national/region-scoped row reads as a wider "event" than a plain deal;
 * `activity`/`tour`/`event` kinds (added for the What's on / Book early
 * sections — see lib/happenings/types.ts) read as their own plain labels;
 * a venue/city `deal` row with a concrete showtime (`occurrenceExact`) reads
 * EVENT; anything else — an ongoing, timeless discount — reads DEAL.
 */
export function happeningTypeTag(
  h: Pick<Happening, "kind" | "scope">,
  occurrenceExact: boolean
): string {
  if (h.kind === "festival") return "FESTIVAL";
  if (h.scope === "national") return "NATIONAL EVENT";
  if (h.scope === "region") return "REGIONAL EVENT";
  if (h.kind === "activity") return "ACTIVITY";
  if (h.kind === "tour") return "TOUR";
  if (h.kind === "event") return "EVENT";
  if (occurrenceExact) return "EVENT";
  return "DEAL";
}

// ---------------------------------------------------------------------------
// Staleness ("Checked 2d ago")
// ---------------------------------------------------------------------------

/** A happening not re-verified in this many days is flagged stale (used to de-prioritize hero ranking, never to hide the card — see happeningHeroScore). */
export const STALE_AFTER_DAYS = 21;

function wholeDaysBetween(fromIso: string, now: Date, timeZone: string): number {
  const fromDay = localDayDate(new Date(fromIso), timeZone);
  const nowDay = localDayDate(now, timeZone);
  const [fy, fm, fd] = fromDay.split("-").map(Number);
  const [ny, nm, nd] = nowDay.split("-").map(Number);
  return Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** "Checked today" / "Checked yesterday" / "Checked Nd ago". Negative/garbage input (a clock-skewed `verified_at` in the future) clamps to "Checked today" rather than printing a negative day count. */
export function checkedLabel(verifiedAt: string, now: Date = new Date(), timeZone: string = CITY.timezone): string {
  const days = Math.max(0, wholeDaysBetween(verifiedAt, now, timeZone));
  if (days === 0) return "Checked today";
  if (days === 1) return "Checked yesterday";
  return `Checked ${days}d ago`;
}

export function isStale(
  verifiedAt: string,
  now: Date = new Date(),
  timeZone: string = CITY.timezone,
  afterDays: number = STALE_AFTER_DAYS
): boolean {
  return wholeDaysBetween(verifiedAt, now, timeZone) >= afterDays;
}

/** "Forever Edinburgh · Checked 2d ago" — every card's provenance line. */
export function provenanceLine(
  h: Pick<Happening, "source_name" | "verified_at">,
  now: Date = new Date(),
  timeZone: string = CITY.timezone
): string {
  return `${h.source_name} · ${checkedLabel(h.verified_at, now, timeZone)}`;
}

// ---------------------------------------------------------------------------
// Eligibility line ("EH Postcodes only · Proof of address required",
// "Student / Anyone before 7pm")
// ---------------------------------------------------------------------------

/** Plain enum label ("Local residents") — exported for the happening detail
 *  page's eligibility header, which shows this ABOVE `eligibility_note`/
 *  `allowance_note` rather than merged into one line (see `eligibilityLine`,
 *  which stays the feed card's single-line convenience). */
export const ELIGIBILITY_FALLBACK: Record<HappeningEligibility, string | null> = {
  anyone: null,
  local_resident: "Local residents",
  student: "Students",
  under_26: "Under 26s",
  over_60: "Over 60s",
  member: "Members",
  cardholder: "Cardholders",
};

/** Material Symbols icon for the eligibility line — "badge" default, a couple of more specific glyphs where they read better. */
export const ELIGIBILITY_ICON: Record<HappeningEligibility, string> = {
  anyone: "badge",
  local_resident: "badge",
  student: "school",
  under_26: "cake",
  over_60: "cake",
  member: "card_membership",
  cardholder: "card_membership",
};

/**
 * Card-facing eligibility badge — the plain enum label ONLY ("Students",
 * "Local residents"), never the free-text `eligibility_note`/`allowance_note`
 * sentence a curator may have written ("EH Postcodes only · Proof of address
 * required", "Young Scot card holders and Universal/Pension Credit benefit
 * holders pay £1; children under 15 free."). Those sentences are real,
 * useful copy — they still render in full on the happening detail page's own
 * Eligibility section — but a full sentence is exactly the kind of "too much
 * outside the card" text the feed cards/hero must not carry. Returns null
 * for `eligibility: "anyone"` — nothing to show, matching the mockup's cards
 * without a restriction, which omit the badge entirely.
 */
export function eligibilityLine(h: Pick<Happening, "eligibility">): string | null {
  return ELIGIBILITY_FALLBACK[h.eligibility];
}

// ---------------------------------------------------------------------------
// Card one-liners — a short derived summary/location, never the raw
// multi-sentence copy. See the Home card-density pass: cards must show "a
// one-liner about the thing", full detail lives on the subject's own page.
// ---------------------------------------------------------------------------

const ONE_LINER_MAX_CHARS = 90;

/**
 * A single short clause from a (possibly multi-sentence) `summary` — the
 * happenings schema has no separate short/long description field, `summary`
 * IS the full copy, so the card's "one-liner" has to be derived from it
 * rather than read from its own column. Takes the first sentence (split on
 * `.`/`!`/`?`), then hard-truncates to `ONE_LINER_MAX_CHARS` if that first
 * sentence is itself still too long for a card row. The full `summary`
 * still renders verbatim on the detail page — this is display-only, never
 * mutates or drops the underlying field.
 */
export function oneLinerSummary(summary: string | null): string | null {
  if (!summary) return null;
  const trimmed = summary.trim();
  if (trimmed.length === 0) return null;
  // A sentence ends at .!? followed by whitespace or end of text — so "2.5-hour",
  // "£7.50" and "parkrun.org.uk" don't cut the one-liner short.
  const firstSentence = trimmed.match(/^.+?[.!?](?=\s|$)/)?.[0]?.trim() ?? trimmed;
  if (firstSentence.length <= ONE_LINER_MAX_CHARS) return firstSentence;
  return `${firstSentence.slice(0, ONE_LINER_MAX_CHARS - 1).trimEnd()}…`;
}

/** True for a short, structured-looking value ("10am–5pm", "Daily 9–6") —
 *  false for research-note prose ("Tours run daily; page-listed times
 *  include 10:00 AM… Times are dynamically rendered and not stated as
 *  fixed."). Gated on length + word count rather than parsing actual time
 *  formats, since the source data is free text with no fixed shape — this
 *  just keeps an obviously long sentence off a card row; a genuinely short
 *  structured value always passes. */
function isShortStructuredValue(value: string | null): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 24) return false;
  return trimmed.split(/\s+/).length <= 5;
}

/**
 * Card-facing "where" line — a place name (district/venue) alone, or that
 * plus a short structured hours value. NEVER includes free-text research
 * notes (`time_note`/a place's `hours` can run to a full sentence) — those
 * stay on the detail page only. Shared by every card that composes its own
 * location line server-side (see app/api/feed/route.ts's `buildFreeAnyTime`).
 */
export function shortLocationLine(place: string | null, hours: string | null): string | null {
  const parts = [place, isShortStructuredValue(hours) ? hours : null].filter(
    (p): p is string => !!p
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * "Museum" / "Outdoor space" from a `places.category` free-text value
 * ("museum", "outdoor_space") — used only where a live `places` row (not a
 * curated `Happening`, which already has an enum `category` styled via
 * lib/happenings/category-style.ts) needs a human label, e.g. the Free Any
 * Time page's type filter chips (app/api/feed/route.ts's `buildFreeAnyTime`).
 * Null in, null out.
 */
export function formatPlaceCategoryLabel(category: string | null): string | null {
  if (!category) return null;
  const words = category.replace(/[_-]+/g, " ").trim().split(/\s+/);
  if (words.length === 0 || !words[0]) return null;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ---------------------------------------------------------------------------
// Time / venue line ("Tonight 8:30pm", "Sat 8:30pm")
// ---------------------------------------------------------------------------

function formatClockTime(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "";
  const dayPeriod = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toLowerCase().replace(/\./g, "");
  return minute === "00" ? `${hour}${dayPeriod}` : `${hour}:${minute}${dayPeriod}`;
}

/**
 * "Tonight 8:30pm" / "Tomorrow 8:30pm" / "Sat 8:30pm" for an occurrence with
 * a real clock time; null for a dateless/recurring occurrence (weekly deals
 * with no fixed hour, "always" rows) — the card shows only its venue line
 * then, matching the Brass Monkey card in the mockup.
 */
export function happeningTimeLabel(
  occurrence: Pick<Occurrence, "exact" | "startsAt" | "dayDate">,
  now: Date = new Date(),
  timeZone: string = CITY.timezone
): string | null {
  if (!occurrence.exact || !occurrence.startsAt) return null;
  const today = localDayDate(now, timeZone);
  const tomorrow = addDays(today, 1);
  const clock = formatClockTime(occurrence.startsAt, timeZone);
  if (occurrence.dayDate === today) return `Tonight ${clock}`;
  if (occurrence.dayDate === tomorrow) return `Tomorrow ${clock}`;
  const [y, m, d] = occurrence.dayDate.split("-").map(Number);
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
  return `${weekday} ${clock}`;
}

/**
 * "Sat 26 Sep 2026" — a full, unambiguous date for one calendar day, used by
 * the happening detail page's "When" section (the feed cards only ever need
 * the terser `happeningTimeLabel`/bucket titles, which drop the year and
 * abbreviate "today"/"tomorrow"; the detail page has room to be explicit and
 * shouldn't presume the reader remembers what day "today" was).
 */
export function occurrenceDateLabel(dayDate: string): string {
  const [y, m, d] = dayDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(date);
  return `${weekday} ${d} ${monthShort(dayDate)} ${y}`;
}

/**
 * "Sat 26 – Sun 27 Sep 2026" for a multi-day occurrence (Doors Open Days);
 * plain `occurrenceDateLabel` when it's a single day.
 */
export function occurrenceRangeLabel(occurrence: Pick<Occurrence, "dayDate" | "lastDayDate">): string {
  if (occurrence.dayDate === occurrence.lastDayDate) return occurrenceDateLabel(occurrence.dayDate);
  const weekdayShort = (dayDate: string) => {
    const [y, m, d] = dayDate.split("-").map(Number);
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(
      new Date(Date.UTC(y, m - 1, d))
    );
  };
  const [ly] = occurrence.lastDayDate.split("-").map(Number);
  return `${weekdayShort(occurrence.dayDate)} ${dayOfMonth(occurrence.dayDate)} – ${weekdayShort(
    occurrence.lastDayDate
  )} ${dayOfMonth(occurrence.lastDayDate)} ${monthShort(occurrence.lastDayDate)} ${ly}`;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The ONE-LINE recurrence pattern — "Every Saturday", "Every Mon & Fri",
 * "Every 30 Nov", "On selected dates" — for the happening detail page's
 * When section. Shown ONCE above a compact list of the actual upcoming
 * dates, replacing the old behaviour of repeating `time_note` on every
 * single date row (see the task brief: "don't repeat the description in
 * each occurrence"). Returns null for `once`/`always`, which have no
 * "pattern" of their own — a single dated item just shows its one date, and
 * an always-open item already says "Every day" as its own row.
 */
export function recurrencePatternLabel(recurrence: Recurrence): string | null {
  switch (recurrence.type) {
    case "weekly": {
      // `days` is whatever order the source data listed — sort to calendar
      // order (Sun..Sat) so "Every Fri & Mon" never prints out of sequence.
      const names = [...recurrence.days].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d]);
      if (names.length === 7) return "Every day";
      if (names.length === 1) return `Every ${names[0]}`;
      return `Every ${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
    }
    case "annual": {
      const start = `${recurrence.day} ${monthAbbr(recurrence.month)}`;
      if (recurrence.endDay && recurrence.endDay !== recurrence.day) {
        return `Every ${recurrence.day}–${recurrence.endDay} ${monthAbbr(recurrence.month)}`;
      }
      return `Every ${start}`;
    }
    case "dates":
      return "On selected dates";
    case "once":
    case "always":
      return null;
  }
}

/**
 * Strips a leading restatement of `pattern` from `timeNote` when the note
 * begins by echoing it verbatim — a common research-note habit ("Every
 * Saturday, 09:30 start on the promenade…" right under a "Every Saturday"
 * pattern line already shown above it). Case-insensitive on the pattern's
 * own text; tolerant of the comma/space that typically follows it. Returns
 * `timeNote` unchanged when it doesn't start with `pattern` (or either is
 * null), and null (not "") when stripping the echo leaves nothing behind.
 */
export function stripLeadingPatternEcho(pattern: string | null, timeNote: string | null): string | null {
  if (!timeNote || !pattern) return timeNote;
  const trimmed = timeNote.trim();
  if (!trimmed.toLowerCase().startsWith(pattern.toLowerCase())) return timeNote;
  const rest = trimmed.slice(pattern.length).replace(/^[\s,;:.-]+/, "");
  return rest.length > 0 ? rest : null;
}

/**
 * A short, clean start time pulled out of a free-text `time_note`, or null
 * when nothing in it looks like a real clock time (most notes are pure prose
 * with none at all). Used ONLY for a compact schedule line — e.g. a series
 * Locations row (see the happening detail page) — which must never carry the
 * note's full sentence; the note itself stays intact on that member's own
 * detail page.
 *
 * Handles the two shapes these research notes actually use: an explicit
 * "9:30am"/"9pm" (trusted verbatim), and a bare 24-hour "09:30"/"19:00" — the
 * more common shape, since UK research notes default to the 24-hour clock
 * with no am/pm marker at all. A bare 24-hour value is converted on the
 * ordinary assumption that 00:00–11:59 is am and 12:00–23:59 is pm — right
 * for every real case observed (a 09:30 parkrun, a 19:00 gig) and there's no
 * more reliable signal to extract from free text. Only the FIRST time-shaped
 * match counts, so an aside later in the note (a caveat, a second time for a
 * different day) never wins over the one at the start of the sentence.
 */
export function shortStartTimeFromNote(timeNote: string | null): string | null {
  if (!timeNote) return null;

  const explicit = timeNote.match(/\b(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s*(am|pm)\b/i);
  if (explicit) {
    const hour = explicit[1];
    const minute = explicit[2];
    const meridiem = explicit[3].toLowerCase();
    return minute && minute !== "00" ? `${hour}:${minute}${meridiem}` : `${hour}${meridiem}`;
  }

  const bare = timeNote.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!bare) return null;
  const hour24 = Number(bare[1]);
  const minute = bare[2];
  const meridiem = hour24 < 12 ? "am" : "pm";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return minute !== "00" ? `${hour12}:${minute}${meridiem}` : `${hour12}${meridiem}`;
}

// ---------------------------------------------------------------------------
// Date buckets ("Happening Today & Tomorrow", "This Weekend (26–27 Sep)")
// ---------------------------------------------------------------------------

export type FeedBucketKey = "today_tomorrow" | "this_weekend" | "coming_up";

/**
 * The Saturday/Sunday of the CURRENT (already-started, if today is itself a
 * weekend day) or NEXT weekend — never a weekend that has already fully
 * passed. Mirrors the day-arithmetic app/(shell)/events/page.tsx's
 * `windowRange("weekend")` already uses for the same "what counts as this
 * weekend" question, just expressed over calendar-day strings instead of
 * `Date`.
 */
export function weekendDates(
  now: Date = new Date(),
  timeZone: string = CITY.timezone
): { saturday: string; sunday: string } {
  const today = localDayDate(now, timeZone);
  const dow = weekdayOf(today); // 0 Sun .. 6 Sat
  const daysUntilSaturday = dow === 6 ? 0 : dow === 0 ? -1 : 6 - dow;
  const saturday = addDays(today, daysUntilSaturday);
  return { saturday, sunday: addDays(saturday, 1) };
}

// Hand-rolled rather than Intl.DateTimeFormat(..., { month: "short" }): the
// en-GB locale abbreviates September as "Sept" (4 letters), not "Sep" — a
// real ICU behavior, caught by this file's own throwaway fixture check —
// and the mockup's "This Weekend (26–27 Sep)" needs the 3-letter form.
// Fixed English abbreviations sidestep both that locale quirk and any
// difference between ICU data versions across Node runtimes.
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 1-indexed month (matches `Recurrence`'s own `month` field) -> "Sep". */
function monthAbbr(month: number): string {
  return MONTH_ABBR[month - 1];
}

/** 1-indexed "YYYY-MM-DD" -> "Sep" — exported for callers composing their own
 *  compact date pills (Home's Coming up date filter row) that need the same
 *  fixed English abbreviation this file uses, not the locale-dependent (and
 *  in en-GB's case, wrong — "Sept") `Intl.DateTimeFormat` output. */
export function monthShort(dayDate: string): string {
  return monthAbbr(Number(dayDate.slice(5, 7)));
}

function dayOfMonth(dayDate: string): number {
  return Number(dayDate.slice(8, 10));
}

/** "This Weekend (26–27 Sep)" — a shared month is printed once, at the end. */
export function weekendBucketTitle(saturday: string, sunday: string): string {
  const startMonth = monthShort(saturday);
  const endMonth = monthShort(sunday);
  const range =
    startMonth === endMonth
      ? `${dayOfMonth(saturday)}–${dayOfMonth(sunday)} ${endMonth}`
      : `${dayOfMonth(saturday)} ${startMonth} – ${dayOfMonth(sunday)} ${endMonth}`;
  return `This Weekend (${range})`;
}

/**
 * Which section a calendar day falls into. "always"-recurrence happenings
 * are never passed in here — they never compete for a dated bucket, they
 * live in the trailing Free Any Time zone instead (see the feed route).
 */
export function bucketForDayDate(
  dayDate: string,
  now: Date = new Date(),
  timeZone: string = CITY.timezone
): FeedBucketKey {
  const today = localDayDate(now, timeZone);
  const tomorrow = addDays(today, 1);
  if (dayDate === today || dayDate === tomorrow) return "today_tomorrow";
  const { saturday, sunday } = weekendDates(now, timeZone);
  if (dayDate === saturday || dayDate === sunday) return "this_weekend";
  return "coming_up";
}

// ---------------------------------------------------------------------------
// Hero ranking
// ---------------------------------------------------------------------------

/**
 * Scores a happening occurrence for the single top hero slot. Higher wins.
 * Prefers, in rough order: curator `priority`, imminent last-chance urgency,
 * free-or-big-saving offers, and penalizes a row that hasn't been
 * re-verified in a while (`isStale`) rather than hiding it outright — a
 * stale-but-still-live offer can still legitimately be the best thing on
 * the page, just not by much.
 *
 * Callers are expected to have already excluded `recurrence: "always"` rows
 * (they have no "last chance" and belong in Free Any Time, not the hero
 * slot) and computed `occurrence` via lib/happenings/occurrence.ts.
 */
/**
 * The hero's headline. The mockup's own copy ("Free entry at Mary King's
 * Close on Saturday — and it won't come round again this year.") is
 * hand-authored editorial flair with no equivalent field in the happenings
 * schema (`title` is capped at ~8 words) and no LLM pipeline in this build
 * to generate it — so this produces a plainer, still causal, sentence
 * algorithmically from `title` + how urgent the last-chance window is.
 */
export function heroHeadline(
  h: Pick<Happening, "title">,
  occurrence: Occurrence,
  now: Date = new Date(),
  timeZone: string = CITY.timezone
): string {
  const daysLeft = daysUntilLastChance(occurrence, now, timeZone);
  if (daysLeft <= 0) return `${h.title} — today only.`;
  if (daysLeft === 1) return `${h.title} — last chance tomorrow.`;
  if (daysLeft <= 3) return `${h.title} — won't last the week.`;
  return h.title;
}

/** `daysLeft` — pass `daysUntilLastChance(occurrence, now, timeZone)` (lib/happenings/occurrence.ts); taken as a plain number rather than an `Occurrence` so callers that already computed it (the feed route, ranking every candidate in a loop) don't redo the work. */
export function happeningHeroScore(
  h: Pick<Happening, "priority" | "is_free" | "saving_amount" | "verified_at">,
  daysLeft: number,
  now: Date = new Date(),
  timeZone: string = CITY.timezone
): number {
  let score = h.priority ?? 50;
  if (daysLeft <= 0) score += 40;
  else if (daysLeft <= 2) score += 30;
  else if (daysLeft <= 7) score += 15;
  if (h.is_free) score += 15;
  if (h.saving_amount != null) score += Math.min(h.saving_amount, 30);
  if (isStale(h.verified_at, now, timeZone)) score -= 25;
  return score;
}
