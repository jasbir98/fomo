/**
 * Pure lifecycle rules for sweep-happenings.mjs (unit-tested in sweep-rules.test.mjs).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** First 10 chars of a YYYY-MM-DD[...] string, else null. */
function dayOf(value) {
  return typeof value === "string" && DATE_RE.test(value.trim()) ? value.trim().slice(0, 10) : null;
}

/** Today's date in Europe/London as YYYY-MM-DD. */
export function londonToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(now);
}

/**
 * Why a recurring happening has finished, or null when it has not.
 *
 *  - weekly with `until` strictly before today: the series ended.
 *  - dates whose LAST listed date is strictly before today: every date has passed.
 *
 * A weekly row with no `until` and a `dates` row with no parseable dates are
 * never "ended" (nothing says so). The day of the last date itself still counts
 * as live (<, not <=).
 */
export function endedRecurrence(recurrence, today) {
  if (!recurrence || typeof recurrence !== "object") return null;
  if (recurrence.type === "weekly") {
    const until = dayOf(recurrence.until);
    return until && until < today ? `weekly until ${until}` : null;
  }
  if (recurrence.type === "dates") {
    const days = (Array.isArray(recurrence.dates) ? recurrence.dates : []).map(dayOf).filter(Boolean).sort();
    const last = days[days.length - 1];
    return last && last < today ? `last date ${last}` : null;
  }
  return null;
}

/**
 * Rows (live deals fetched by the sweep) whose weekly/dates recurrence has
 * ended. Only `kind: "deal"` rows are considered, and only `live` ones.
 * Returns [{ ...row, ends_at: <human label> }] so the sweep's existing log
 * line ("ended <label>") reads naturally.
 */
export function findEndedRecurringDeals(rows, today) {
  const out = [];
  for (const row of rows ?? []) {
    if (row?.status !== "live" || row?.kind !== "deal") continue;
    const why = endedRecurrence(row.recurrence, today);
    if (why) out.push({ ...row, ends_at: why });
  }
  return out;
}
