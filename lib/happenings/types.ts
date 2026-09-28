/**
 * Fomo Happenings — types.
 *
 * Module-local rather than in lib/types.ts: the recurrence union and its
 * occurrence output are only meaningful alongside the expansion logic next
 * door.
 *
 * Deliberately NOT `server-only` — the feed and every card need these, and they
 * are client components. Same exclusion as lib/events/format.ts.
 */

/** `deal | free_access | festival | activity | tour | event` — the original three
 *  (`seasonal`/`one_off` would duplicate what `recurrence` already encodes, and
 *  `free_entry` would duplicate `is_free`) plus three added for the "What's on" /
 *  "Book early" Home sections: `activity` (parkruns, free guided walks — recurring,
 *  usually free, not framed as a discount), `tour` (walking tours, tip-based or
 *  ticketed), `event` (dated one-offs/festivals that are neither a deal nor
 *  free-access — gigs, Murrayfield fixtures, ticketed festival strands). See
 *  supabase/archive/add_happenings_booking.sql for the DB-side note — still no CHECK
 *  constraint, this union is the only enforcement. */
export type HappeningKind =
  | "deal"
  | "free_access"
  | "festival"
  | "activity"
  | "tour"
  | "event";

/** Load-bearing. National Cinema Weekend (UK-wide) and Doors Open Days
 *  (Scotland-wide) both legitimately have `city = null`; without `scope` a
 *  city-keyed read matches neither and they never render. */
export type HappeningScope = "venue" | "city" | "region" | "national";

export type HappeningEligibility =
  | "anyone"
  | "local_resident"
  | "student"
  | "under_26"
  | "over_60"
  | "member"
  | "cardholder";

/** Lifecycle only. Staleness is DERIVED from `verified_at` at read time and
 *  never stored — there is no cron in this app, so a stored staleness flag
 *  would be wrong on every day the sweep didn't run.
 *  `dormant` = a dated window passed but the row recurs (it's next year's row).
 *  `retired` = the offer genuinely no longer exists. */
export type HappeningStatus = "live" | "dormant" | "retired";

/** Reuses the events chip vocabulary, plus three added for "What's on" /
 *  "Book early" coverage: `wellness` (spa/fitness-adjacent free or cheap
 *  access), `outdoors` (parkruns, guided nature walks), `tours` (walking
 *  tours). The UI agent derives the Deals "WHAT" filter group from this
 *  column — see the Home rebuild contract; this file only owns the union. */
export type HappeningCategory =
  | "music" | "nightlife" | "festival" | "arts" | "comedy"
  | "sports" | "food" | "family" | "museum" | "cinema" | "other"
  | "wellness" | "outdoors" | "tours";

export type HappeningConfidence = "low" | "medium" | "high";

/** How likely/fast a bookable happening (mostly `kind: "event"` / `"tour"` /
 *  `"festival"`) sells out. Null means no sell-out evidence was found — NOT
 *  low risk; never inferred, only ever set alongside a sourced `sellout_note`.
 *  See supabase/archive/add_happenings_booking.sql. */
export type SelloutRisk = "high" | "medium" | "low";

/** 0 = Sunday, matching `Date.prototype.getUTCDay()`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * How a happening repeats.
 *
 * `dates` is the variant an obvious design misses, and Forever Edinburgh's
 * Resident Rewards Days needs exactly: four fixed dates a year, announced
 * individually, with no formula behind them. Without it those become four
 * fake-`annual` rows or one wrong row.
 *
 * `until` bounds a rule — no offer really runs forever. It lives inside the
 * jsonb rather than as a fourth date column so `starts_at`/`ends_at` keep one
 * unambiguous meaning.
 */
export type Recurrence =
  | { type: "once" }
  | { type: "always" }
  | { type: "weekly"; days: Weekday[]; until?: string }
  | { type: "annual"; month: number; day: number; endDay?: number; until?: string }
  | { type: "dates"; dates: string[] };

/** Mirrors the `happenings` table in supabase/archive/add_happenings.sql. */
export interface Happening {
  id: string;
  slug: string;
  title: string;
  summary: string | null;

  kind: HappeningKind;
  category: HappeningCategory | null;
  scope: HappeningScope;
  editorial_tag: string | null;

  saving_label: string | null;
  saving_amount: number | null;
  currency: string | null;
  is_free: boolean | null;
  promo_code: string | null;
  redemption_note: string | null;

  eligibility: HappeningEligibility;
  eligibility_note: string | null;
  allowance_note: string | null;

  starts_at: string | null;
  ends_at: string | null;
  recurrence: Recurrence;
  time_note: string | null;

  /** Null = already on sale / no booking needed. Only set when a source
   *  states a specific release moment for tickets not yet on general sale. */
  booking_opens_at: string | null;
  sellout_risk: SelloutRisk | null;
  sellout_note: string | null;

  venue_name: string | null;
  address: string | null;
  district: string | null;
  city: string | null;
  region: string | null;
  country_code: string;
  lat: number | null;
  lng: number | null;
  place_id: string | null;

  image_url: string | null;
  image_quality: string | null;
  booking_url: string | null;
  cta_label: string | null;

  source_name: string;
  source_url: string;
  verified_at: string;
  confidence: HappeningConfidence | null;
  status: HappeningStatus;
  priority: number | null;
  season_valid_until?: string | null;

  created_at: string | null;
  updated_at: string | null;
}

/**
 * One concrete dated instance of a happening.
 *
 * `dayDate` is a local calendar day, not an instant, and it is the feed's
 * primary sort key. Recurring happenings have no clock time — synthesising one
 * ("every Monday at 00:00") is where the bugs live and buys nothing, because
 * the feed buckets by day.
 */
export interface Occurrence {
  happeningId: string;
  /** "YYYY-MM-DD" in the city's timezone. */
  dayDate: string;
  /** Only set when the row carries a real `starts_at`. Secondary sort key. */
  startsAt: string | null;
  endsAt: string | null;
  /** Last calendar day of THIS occurrence's own span; equals `dayDate` when
   *  single-day. For a recurring rule (weekly/annual/dates) this is still
   *  just the one instance's day(s) — e.g. today's slot of a daily walk —
   *  NEVER the rule's overall end. Use `seriesEndDayDate` (below) for
   *  "when does this stop happening at all", which is what a "last chance"
   *  countdown must be measured against. */
  lastDayDate: string;
  /** The day the happening's RULE stops producing occurrences at all — the
   *  overall recurrence end (`min` of the row's `ends_at` and the rule's own
   *  `until`, in whichever are set), or `null` when it's open-ended. For a
   *  one-off (`once`) this equals `lastDayDate` (there's no "rule" separate
   *  from the single occurrence). A recurring rule with no end has no last
   *  chance — see `daysUntilLastChance`. */
  seriesEndDayDate: string | null;
  /** True when derived from a concrete timestamp, false when generated from a rule. */
  exact: boolean;
}
