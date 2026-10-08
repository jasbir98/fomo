/** Europe/London wall-clock helpers shared by the scraped-page adapters. */

import { londonOffsetMinutes } from "./time.mjs";

/** Wall-clock Europe/London date ("YYYY-MM-DD") + time ("HH:MM") -> UTC ISO string. */
export function londonWallToIso(dateStr, hhmm) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  return new Date(guess - londonOffsetMinutes(new Date(guess)) * 60_000).toISOString();
}

/** "YYYY-MM-DD" plus n days. */
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
