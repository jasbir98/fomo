/**
 * Europe/London time helpers shared by the JSON-LD mapper, the Skiddle
 * mapper, the cross-source dedupe key and the description backfill.
 */

// Europe/London's UTC offset (0 in GMT, 60 in BST) for the given instant,
// computed via Intl rather than a hardcoded date range so it's correct
// across DST transitions in any year, and independent of the *host*
// machine's own timezone (unlike `new Date("YYYY-MM-DDTHH:mm:ss")`, which
// silently parses as host-local time — fine on a UTC CI runner most of the
// year, wrong by up to several hours run anywhere else, e.g. this repo's
// dev machines).
export function londonOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUtc - date.getTime()) / 60_000;
}

// en-CA gives YYYY-MM-DD directly — used to key on the event's Europe/London
// calendar date rather than the raw (often UTC) starts_at timestamp, so an
// 11pm-local gig doesn't key onto the next UTC day.
const LONDON_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function londonDateKey(iso) {
  try {
    return LONDON_DATE_FMT.format(new Date(iso));
  } catch {
    return String(iso).slice(0, 10);
  }
}

const LONDON_HOUR_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hourCycle: "h23",
  hour: "2-digit",
});
// Coarse (3h) time-of-day bucket, Europe/London local hour. Tolerates the
// few-minutes showtime discrepancies different sources report for the same
// real event, while still telling apart a same-day matinee (e.g. 13:30) from
// an evening show (e.g. 18:30) of a touring production at the same venue —
// title+date+venue alone can't distinguish those.
export function londonHourBucket(iso) {
  try {
    const hour = Number(LONDON_HOUR_FMT.format(new Date(iso)));
    return Math.floor(hour / 3);
  } catch {
    return "?";
  }
}
