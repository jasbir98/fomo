/**
 * scripts/lib/weekly-picks.mjs — the "DB is the content" shared selection
 * logic for Fomo Friday (scripts/fomo-friday.mjs) and the IG carousel
 * (scripts/ig-carousel.mjs). One module so both outputs are always built
 * from the exact same picks, ranked the exact same way.
 *
 * SELECTION (PM review 2026-09-26 rewrite — the first pass surfaced three
 * bugs: an all-evergreen picks list, "any time" printed for rows with a
 * real clock time, and expired one-off deals slipping through because
 * nothing checked whether a deal actually falls in the send window):
 *
 *   "Things this weekend" (`picks`) is DATED-FIRST:
 *     (a) dated one-offs — happenings with recurrence once/dates/annual
 *         landing in the window, plus `events` rows — ranked free → cheap
 *         (≤£15) → excluded unless sports (a real price signal only exists
 *         for `events.price_from`; a dated happening with no price data of
 *         its own is kept at the "cheap" tier rather than guessed at, see
 *         DATED_HAPPENING_UNKNOWN_PRICE_TIER below).
 *     (b) recurring/evergreen — weekly happenings whose weekday falls in
 *         the window ONLY (never `always` — an "any day" deal doesn't read
 *         as "this weekend"), capped at 2 total, used to top up (a) rather
 *         than lead it. If (a) alone is short of 8, the total is capped at
 *         8 rather than padded further with evergreen to hit 10.
 *   `deals` requires the row to have a real occurrence inside the SAME
 *   weekend window (not just "not yet fully ended") — see `occursInWindow`
 *   — and prefers student/under_26 eligibility, then anyone, capped at 5.
 *   Both pools exclude family-only (`category: 'family'`) and over-60-only
 *   (`eligibility: 'over_60'`) rows — the wedge is students + young
 *   professionals — and down-rank `kind: 'festival'` programme rows.
 *
 * DB ACCESS. Plain `fetch` against `${NEXT_PUBLIC_SUPABASE_URL}/rest/v1`
 * with the service-role key — NOT `@supabase/supabase-js`, whose mandatory
 * Realtime/WebSocket init throws under plain Node 20. Same house pattern as
 * scripts/sweep-happenings.mjs and scripts/daily-sources.mjs. Read-only:
 * this module never writes.
 *
 * RECURRENCE / ENDED. Happenings have no single date column when
 * recurring — a happening is turned into concrete dated occurrences by
 * lib/happenings/occurrence.ts's `nextOccurrences`, and "has this happening
 * ended" is that file's `happeningHasEnded` (search the next 366 days for
 * any occurrence at all). Both are TS files this plain `.mjs` (run via
 * `node --env-file`) can't import, so the calendar-day expansion they need
 * is reimplemented below, deliberately kept in lock-step with the source
 * file's day-string approach (calendar days, not instants — see that
 * file's own module doc for why) so a maintainer reading both side by side
 * sees the same algorithm twice, not two diverging ones. `season_valid_until`
 * is checked here too (that column may not exist yet — see the source
 * file's own note that it's "filtered at the query layer", not inside
 * `nextOccurrences` itself); this module's `select=*` simply omits it if
 * absent, so every read of it is optional-chained/undefined-tolerant.
 *
 * GENUINE DEAL. `isGenuineDeal` below is a direct line-for-line port of
 * lib/happenings/groups.ts's `isGenuineDeal` (same three signals, same
 * order, same DISCOUNT_SHAPE_PATTERN) — ported rather than imported for the
 * same TS-from-.mjs reason as the recurrence expansion above. If that
 * predicate ever changes, this copy must change with it.
 *
 * TIME LABELS. Ported from lib/happenings/format.ts's `happeningTimeLabel`
 * (the date-only-row-is-midnight-UTC handling) and `shortStartTimeFromNote`
 * (pulling a clock time out of free-text `time_note` for rows with no real
 * `starts_at` clock component) — same reasoning, never guess a time that
 * isn't in the data, and never print a vague "any time" filler.
 */

const TIMEZONE = "Europe/London";
const CURRENCY_SYMBOL = { GBP: "£", USD: "$", EUR: "€" };
const CHEAP_THRESHOLD_GBP = 15;
const EXCLUDED_ELIGIBILITY = new Set(["over_60"]);
const EXCLUDED_CATEGORY = new Set(["family"]);
const EVENT_PROVIDER_ALLOWLIST = new Set(["luma", "eventbrite", "songkick", "allevents", "skiddle", "ticketmaster"]);

// --- Supabase REST (house pattern: scripts/sweep-happenings.mjs) -----------

function makeRest(supabaseUrl, serviceRoleKey) {
  const base = supabaseUrl.replace(/\/$/, "");
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
  return async function rest(path) {
    const res = await fetch(`${base}/rest/v1/${path}`, { headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GET ${path} -> ${res.status}: ${body}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  };
}

// --- local-day <-> instant (port of lib/happenings/occurrence.ts) ----------

function pad(n) {
  return n < 10 ? `0${n}` : String(n);
}

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function localDayDate(at) {
  const parts = dayFormatter.formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(dayDate, n) {
  const [y, m, d] = dayDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function weekdayOf(dayDate) {
  const [y, m, d] = dayDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const offsetFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function zoneOffsetMs(at) {
  const parts = offsetFormatter.formatToParts(at);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asIfUtc - at.getTime();
}

/** The exact instant a local calendar day begins, Europe/London. Two-pass
 *  offset resolution — see lib/happenings/occurrence.ts's startOfLocalDay
 *  doc comment for why a single pass is wrong on a DST-shift day. */
function startOfLocalDay(dayDate) {
  const [y, m, d] = dayDate.split("-").map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  const firstPass = utcMidnight - zoneOffsetMs(new Date(utcMidnight));
  return new Date(utcMidnight - zoneOffsetMs(new Date(firstPass)));
}

/** A specific local wall-clock instant (hour:minute) on a given day, in
 *  Europe/London — used for the Friday-17:00 window start. */
function localInstant(dayDate, hour, minute, second = 0) {
  const dayStart = startOfLocalDay(dayDate);
  const guess = new Date(dayStart.getTime() + (hour * 3600 + minute * 60 + second) * 1000);
  const corrected = new Date(guess.getTime() - (zoneOffsetMs(guess) - zoneOffsetMs(dayStart)));
  return corrected;
}

/** True for an instant at exactly 00:00:00 UTC — how the pipeline stores a
 *  date with no time (lib/happenings/occurrence.ts's own `isMidnightUtc`,
 *  and the same check lib/happenings/format.ts's `happeningTimeLabel` uses
 *  to avoid reading a date-only row's stored midnight as a real 1am BST). */
function isMidnightUtc(iso) {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
}

// --- recurrence (port of lib/happenings/occurrence.ts) ---------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeRecurrence(value) {
  const fallback = { type: "once" };
  if (!value || typeof value !== "object") return fallback;
  switch (value.type) {
    case "always":
      return { type: "always" };
    case "weekly": {
      const days = Array.isArray(value.days)
        ? value.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [];
      if (days.length === 0) return fallback;
      return { type: "weekly", days, until: typeof value.until === "string" ? value.until : undefined };
    }
    case "annual": {
      const month = Number(value.month);
      const day = Number(value.day);
      if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return fallback;
      const endDay = Number(value.endDay);
      return {
        type: "annual",
        month,
        day,
        endDay: endDay >= day && endDay <= 31 ? endDay : undefined,
        until: typeof value.until === "string" ? value.until : undefined,
      };
    }
    case "dates": {
      const dates = Array.isArray(value.dates)
        ? value.dates.filter((d) => typeof d === "string" && DAY_RE.test(d)).sort()
        : [];
      if (dates.length === 0) return fallback;
      return { type: "dates", dates };
    }
    default:
      return fallback;
  }
}

/**
 * The soonest occurrence of `h` inside `[windowFrom, windowTo]` (inclusive
 * day strings), or `null`. Trimmed port of lib/happenings/occurrence.ts's
 * `nextOccurrences` — deliberately generic over the window size: called
 * with the 3-day weekend window for "does this land this weekend", and
 * with a 366-day lookahead (matching that file's own
 * `ENDED_CHECK_LOOKAHEAD_DAYS`) for "has this ended at all".
 */
function occurrenceInWindow(h, windowFrom, windowTo) {
  if (h.status !== "live") return null;
  const rec = normalizeRecurrence(h.recurrence);
  const validFrom = h.starts_at ? localDayDate(new Date(h.starts_at)) : null;
  const validTo = h.ends_at ? localDayDate(new Date(h.ends_at)) : null;

  switch (rec.type) {
    case "once": {
      if (!h.starts_at) return null;
      const start = validFrom;
      const end = validTo ?? start;
      if (end < windowFrom || start > windowTo) return null;
      return { dayDate: start, startsAt: h.starts_at, exact: true, type: "once" };
    }
    case "always": {
      if (validTo && validTo < windowFrom) return null;
      return { dayDate: windowFrom, startsAt: null, exact: false, type: "always" };
    }
    case "weekly": {
      const days = new Set(rec.days);
      let cursor = validFrom && validFrom > windowFrom ? validFrom : windowFrom;
      let limit = windowTo;
      if (rec.until && rec.until < limit) limit = rec.until;
      if (validTo && validTo < limit) limit = validTo;
      while (cursor <= limit) {
        if (days.has(weekdayOf(cursor))) return { dayDate: cursor, startsAt: null, exact: false, type: "weekly" };
        cursor = addDays(cursor, 1);
      }
      return null;
    }
    case "annual": {
      const y0 = Number(windowFrom.slice(0, 4));
      const y1 = Number(windowTo.slice(0, 4));
      const mk = (year) => {
        const dt = new Date(Date.UTC(year, rec.month - 1, rec.day));
        if (dt.getUTCMonth() !== rec.month - 1) return null;
        return `${year}-${pad(rec.month)}-${pad(rec.day)}`;
      };
      for (let year = y0; year <= y1 + 1; year++) {
        const start = mk(year);
        if (!start) continue;
        const end = rec.endDay ? (mk(year) && `${year}-${pad(rec.month)}-${pad(rec.endDay)}`) || start : start;
        if (rec.until && start > rec.until) continue;
        if (validTo && start > validTo) continue;
        if (end >= windowFrom && start <= windowTo) return { dayDate: start, startsAt: null, exact: false, type: "annual" };
      }
      return null;
    }
    case "dates": {
      let limit = windowTo;
      if (validTo && validTo < limit) limit = validTo;
      const d = rec.dates.find((x) => x >= windowFrom && x <= limit);
      return d ? { dayDate: d, startsAt: null, exact: false, type: "dates" } : null;
    }
    default:
      return null;
  }
}

/**
 * Why `h` is excluded as ENDED (a whole-series check — does it produce zero
 * occurrences anywhere in the next year, mirroring lib/happenings/
 * occurrence.ts's `happeningHasEnded`), or `null` when it isn't. Distinct
 * from "not occurring THIS weekend" (occurrenceInWindow returning null for
 * just the 3-day window) — a Tuesday-only weekly deal isn't ended, it's
 * just not for this email; only this function's non-null return means the
 * row itself is stale data worth fixing at the source.
 */
function endedReason(h, todayDayDate) {
  if (typeof h.season_valid_until === "string" && h.season_valid_until < todayDayDate) {
    return `past season (season_valid_until ${h.season_valid_until})`;
  }
  const lookaheadTo = addDays(todayDayDate, 366);
  const occ = occurrenceInWindow(h, todayDayDate, lookaheadTo);
  if (occ) return null;

  const rec = normalizeRecurrence(h.recurrence);
  if (rec.type === "once") {
    const d = h.ends_at ?? h.starts_at;
    return `ended ${d ? localDayDate(new Date(d)) : "unknown date"} (one-off)`;
  }
  if ((rec.type === "weekly" || rec.type === "annual") && rec.until) {
    return `series ended ${rec.until} (recurrence.until)`;
  }
  if (h.ends_at) return `series ended ${localDayDate(new Date(h.ends_at))} (ends_at)`;
  return "no future occurrence in the next year";
}

// --- genuine-deal predicate (port of lib/happenings/groups.ts) -------------

const DISCOUNT_SHAPE_PATTERN =
  /\d+(\.\d+)?%|\boff\b|\bdiscount\b|\bconcession\b|half[- ]price|\bfree\b|\bsav(e|es|ing|ings)\b|\d+[- ]?for[- ]?\d+|\d+(\.\d+)?\s*tickets?\b/i;

function isGenuineDeal(h) {
  if (h.promo_code) return true;
  if (DISCOUNT_SHAPE_PATTERN.test(h.saving_label ?? "") || DISCOUNT_SHAPE_PATTERN.test(h.title)) return true;
  if (h.eligibility !== "anyone" && typeof h.saving_amount === "number" && h.saving_amount > 0) return true;
  return false;
}

// --- audience / category gates ---------------------------------------------

function passesAudienceGate(item) {
  if (item.eligibility && EXCLUDED_ELIGIBILITY.has(item.eligibility)) return false;
  if (item.category && EXCLUDED_CATEGORY.has(item.category)) return false;
  return true;
}

/** student/under_26 first, then anyone, then everything else (local_resident,
 *  member, cardholder) — over_60 is already dropped by passesAudienceGate. */
function dealEligibilityTier(eligibility) {
  if (eligibility === "student" || eligibility === "under_26") return 0;
  if (eligibility === "anyone") return 1;
  return 2;
}

// --- money / label helpers ---------------------------------------------

function moneyLabel(amount, currency) {
  const symbol = CURRENCY_SYMBOL[currency ?? "GBP"] ?? `${currency ?? "GBP"} `;
  const value = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${symbol}${value}`;
}

const dayNameFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short" });
const timeFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "numeric", minute: "2-digit", hourCycle: "h12" });

function dayNameFromDayDate(dayDate) {
  const [y, m, d] = dayDate.split("-").map(Number);
  return dayNameFormatter.format(new Date(Date.UTC(y, m - 1, d, 12)));
}

function formatClock(iso) {
  return timeFormatter.format(new Date(iso)).replace(/^0/, "").replace(":00", "").toLowerCase().replace(/\s+/g, "");
}

/**
 * Port of lib/happenings/format.ts's `shortStartTimeFromNote` — the ONLY
 * source of a clock time for a row with no real `starts_at` component
 * (weekly/annual/dates rows, or a date-only `once`). Never fabricates a
 * time: returns null (the caller then prints just the weekday, never "any
 * time") when nothing in the free text looks like one.
 */
function shortStartTimeFromNote(timeNote) {
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

/**
 * "Sat 9:30am" for a row with a real clock time, "Sat" for a date-only row
 * or one whose only time signal is unparseable prose — NEVER "any time".
 */
function whenLabelForHappening(h, occurrence) {
  const day = dayNameFromDayDate(occurrence.dayDate);
  if (occurrence.exact && occurrence.startsAt && !isMidnightUtc(occurrence.startsAt)) {
    return `${day} ${formatClock(occurrence.startsAt)}`;
  }
  const noteTime = shortStartTimeFromNote(h.time_note);
  return noteTime ? `${day} ${noteTime}` : day;
}

function whenLabelForEvent(startsAt) {
  const d = new Date(startsAt);
  if (isMidnightUtc(startsAt)) return dayNameFormatter.format(d);
  return `${dayNameFormatter.format(d)} ${formatClock(startsAt)}`;
}

function priceLabelForHappening(h) {
  if (h.is_free) return "FREE";
  if (h.saving_label) return h.saving_label;
  if (typeof h.saving_amount === "number") return moneyLabel(h.saving_amount, h.currency);
  // Unknown price renders no pill at all -- never a placeholder (same rule as
  // lib/happenings/price-label.ts in the app).
  return null;
}

function priceLabelForEvent(e) {
  if (e.is_free) return "FREE";
  if (e.price_from == null) return null;
  return `From ${moneyLabel(e.price_from, e.currency)}`;
}

/**
 * Price/sports tier for a dated pick — lower sorts first. `happening`
 * (unknown-price) rows land at the same tier as a verified ≤£15 price: a
 * dated happening has no `price_from`-equivalent column of its own (that
 * signal only exists on `events`), so treating "no price data" as
 * automatically excluded would gut the list of legitimately free/cheap
 * curated one-offs that just weren't priced by the research pipeline.
 * `kind: 'festival'` rows get a flat +10 penalty (down-ranked, not
 * excluded — PM note: festival programme/ticket-release rows read as
 * noise when they outrank a concrete free/cheap thing).
 */
const TIER_FREE = 0;
const TIER_CHEAP = 1;
const DATED_HAPPENING_UNKNOWN_PRICE_TIER = TIER_CHEAP;
const TIER_SPORTS = 2;
const FESTIVAL_PENALTY = 10;

function tierForHappening(h) {
  let tier;
  if (h.is_free) tier = TIER_FREE;
  else if (typeof h.saving_amount === "number" && h.saving_amount <= CHEAP_THRESHOLD_GBP) tier = TIER_CHEAP;
  else if (h.category === "sports") tier = TIER_SPORTS;
  else tier = DATED_HAPPENING_UNKNOWN_PRICE_TIER;
  if (h.kind === "festival") tier += FESTIVAL_PENALTY;
  return tier;
}

/** Returns `null` (excluded) for a priced, non-sports event over £15 — the
 *  one case with real, comparable price data where "others excluded unless
 *  sports" actually bites. */
function tierForEvent(e) {
  if (e.is_free) return TIER_FREE;
  if (typeof e.price_from === "number") {
    if (e.price_from <= CHEAP_THRESHOLD_GBP) return TIER_CHEAP;
    if (e.category === "sports") return TIER_SPORTS;
    return null;
  }
  // No price data at all — same reasoning as DATED_HAPPENING_UNKNOWN_PRICE_TIER.
  if (e.category === "sports") return TIER_SPORTS;
  return DATED_HAPPENING_UNKNOWN_PRICE_TIER;
}

function normalizedTitleKey(title, dayDate) {
  return `${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${dayDate}`;
}

/**
 * The coming Fri 17:00 -> Sun 23:59:59 Europe/London window, as local day
 * strings plus their UTC instants (the latter needed for the `events`
 * REST query, which filters on real timestamps, not calendar days). "Coming
 * Friday" includes TODAY when `now` already falls on a Friday — the Friday
 * 8am send targets that same-day evening's start.
 */
export function weekendWindow(now = new Date()) {
  const todayDayDate = localDayDate(now);
  const weekday = weekdayOf(todayDayDate); // 0 = Sunday
  const daysUntilFriday = (5 - weekday + 7) % 7;
  const friday = addDays(todayDayDate, daysUntilFriday);
  const saturday = addDays(friday, 1);
  const sunday = addDays(friday, 2);

  const fromInstant = localInstant(friday, 17, 0, 0);
  const toInstant = localInstant(sunday, 23, 59, 59);

  return {
    fridayDayDate: friday,
    saturdayDayDate: saturday,
    sundayDayDate: sunday,
    windowFromDayDate: friday,
    windowToDayDate: sunday,
    todayDayDate,
    fromIso: fromInstant.toISOString(),
    toIso: toInstant.toISOString(),
  };
}

/**
 * Fetches live happenings + upcoming events and returns the weekly
 * selection. `maxPicks`/`maxDeals` default to the spec's ~10 / up to 5.
 * See the module doc above for the full selection algorithm.
 */
export async function getWeeklyPicks({ supabaseUrl, serviceRoleKey, now = new Date(), maxPicks = 10, maxDeals = 5 }) {
  const rest = makeRest(supabaseUrl, serviceRoleKey);
  const window = weekendWindow(now);

  const [happenings, events] = await Promise.all([
    rest(`happenings?status=eq.live&select=*&limit=1000`),
    rest(
      `events?starts_at=gte.${encodeURIComponent(window.fromIso)}&starts_at=lte.${encodeURIComponent(window.toIso)}` +
        `&or=(city.ilike.%25Edinburgh%25,destination.ilike.%25Edinburgh%25,address.ilike.%25Edinburgh%25)` +
        `&order=starts_at.asc&limit=200`
    ),
  ]);

  // --- deals: live happenings, kind='deal', genuine, NOT ended, occurring
  // this specific weekend, passing the audience gate ----------------------
  const excludedEndedDeals = [];
  const dealCandidates = [];
  for (const h of happenings) {
    if (h.kind !== "deal" || !h.title || !isGenuineDeal(h)) continue;
    const reason = endedReason(h, window.todayDayDate);
    if (reason) {
      excludedEndedDeals.push({ title: h.title, reason });
      continue;
    }
    const occ = occurrenceInWindow(h, window.windowFromDayDate, window.windowToDayDate);
    if (!occ) continue; // not ended, just doesn't land in THIS weekend
    if (!passesAudienceGate(h)) continue;
    dealCandidates.push({
      title: h.title,
      when: null,
      price: priceLabelForHappening(h),
      venue: h.venue_name,
      url: `https://askfomo.com/happening/${h.id}`,
      image_url: h.image_url,
      category: h.category ?? "other",
      eligibilityTier: dealEligibilityTier(h.eligibility),
      sortPrice: h.is_free ? 0 : typeof h.saving_amount === "number" ? h.saving_amount : Infinity,
    });
  }
  const deals = dealCandidates
    .sort((a, b) => a.eligibilityTier - b.eligibilityTier || a.sortPrice - b.sortPrice)
    .slice(0, maxDeals);

  // --- "things this weekend" ------------------------------------------
  // (a) dated one-offs: happenings recurrence once/dates/annual, + events.
  const datedCandidates = [];
  const seenKeys = new Set();
  for (const h of happenings) {
    // Deals have their own section below -- never both.
    if (!h.title || h.kind === "deal" || !passesAudienceGate(h)) continue;
    const occ = occurrenceInWindow(h, window.windowFromDayDate, window.windowToDayDate);
    if (!occ || (occ.type !== "once" && occ.type !== "dates" && occ.type !== "annual")) continue;
    const key = normalizedTitleKey(h.title, occ.dayDate);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    datedCandidates.push({
      title: h.title,
      when: whenLabelForHappening(h, occ),
      price: priceLabelForHappening(h),
      venue: h.venue_name,
      url: `https://askfomo.com/happening/${h.id}`,
      image_url: h.image_url,
      category: h.category ?? "other",
      source: "happening",
      tier: tierForHappening(h),
      sortPrice: h.is_free ? 0 : typeof h.saving_amount === "number" ? h.saving_amount : Infinity,
    });
  }
  for (const e of events) {
    if (!e.name || !e.starts_at) continue;
    if (e.provider && !EVENT_PROVIDER_ALLOWLIST.has(e.provider)) continue;
    if (e.category && EXCLUDED_CATEGORY.has(e.category)) continue;
    const tier = tierForEvent(e);
    if (tier === null) continue; // priced >£15, not sports — excluded per spec
    const dayDate = localDayDate(new Date(e.starts_at));
    const key = normalizedTitleKey(e.name, dayDate);
    if (seenKeys.has(key)) continue; // de-dup vs a happening already picked for the same day
    seenKeys.add(key);
    datedCandidates.push({
      title: e.name,
      when: whenLabelForEvent(e.starts_at),
      price: priceLabelForEvent(e),
      venue: e.venue_name,
      url: `https://askfomo.com/event/${e.id}`,
      image_url: e.image_url,
      category: e.category ?? "other",
      source: "event",
      tier,
      sortPrice: e.is_free ? 0 : typeof e.price_from === "number" ? e.price_from : Infinity,
    });
  }
  datedCandidates.sort((a, b) => a.tier - b.tier || a.sortPrice - b.sortPrice);

  // (b) recurring/evergreen: weekly ONLY, weekday-in-window, capped at 2.
  const evergreenCandidates = [];
  for (const h of happenings) {
    if (!h.title || h.kind === "deal" || !passesAudienceGate(h)) continue;
    const rec = normalizeRecurrence(h.recurrence);
    if (rec.type !== "weekly") continue;
    const occ = occurrenceInWindow(h, window.windowFromDayDate, window.windowToDayDate);
    if (!occ) continue;
    const key = normalizedTitleKey(h.title, occ.dayDate);
    if (seenKeys.has(key)) continue;
    evergreenCandidates.push({
      title: h.title,
      when: whenLabelForHappening(h, occ),
      price: priceLabelForHappening(h),
      venue: h.venue_name,
      url: `https://askfomo.com/happening/${h.id}`,
      image_url: h.image_url,
      category: h.category ?? "other",
      source: "happening",
      key,
      tier: tierForHappening(h),
      sortPrice: h.is_free ? 0 : typeof h.saving_amount === "number" ? h.saving_amount : Infinity,
    });
  }
  evergreenCandidates.sort((a, b) => a.tier - b.tier || a.sortPrice - b.sortPrice);

  // --- combine: dated first (up to 8 slots, category-capped), then top up
  // with at most 2 evergreen. If dated alone can't fill 8, cap the TOTAL at
  // 8 rather than padding further with evergreen to reach 10 (PM spec). ---
  const MAX_PER_CATEGORY = 2;
  const MAX_EVERGREEN = 2;
  const categoryCounts = new Map();

  function takeCategoryCapped(pool, limit, picks) {
    for (const candidate of pool) {
      if (picks.length >= limit) break;
      const count = categoryCounts.get(candidate.category) ?? 0;
      if (count >= MAX_PER_CATEGORY) continue;
      picks.push(candidate);
      categoryCounts.set(candidate.category, count + 1);
    }
  }

  const datedPicks = [];
  takeCategoryCapped(datedCandidates, Math.max(0, maxPicks - MAX_EVERGREEN), datedPicks);

  const totalCap = datedPicks.length >= maxPicks - MAX_EVERGREEN ? maxPicks : Math.min(8, maxPicks);
  const evergreenBudget = Math.max(0, Math.min(MAX_EVERGREEN, totalCap - datedPicks.length));
  const evergreenPicks = [];
  if (evergreenBudget > 0) takeCategoryCapped(evergreenCandidates, evergreenBudget, evergreenPicks);

  const picks = [...datedPicks, ...evergreenPicks];
  const datedFromHappenings = datedPicks.filter((p) => p.source === "happening").length;
  const datedFromEvents = datedPicks.filter((p) => p.source === "event").length;

  return {
    picks,
    deals,
    window,
    excludedEndedDeals,
    counts: {
      datedFromHappenings,
      datedFromEvents,
      evergreen: evergreenPicks.length,
      totalPicks: picks.length,
    },
  };
}
