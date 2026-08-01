// Client-safe event formatting helpers — imported by both the /api/events
// route (indirectly, via shared logic) and Phase 2's UI components. This
// file deliberately has NO `import "server-only"`, unlike everything else in
// lib/events/: it runs in client components (EventCard, the /event/[id] and
// /events pages, the Home carousel).
import type { EventItem } from "@/lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "7:30 PM" */
export function formatEventTime(starts_at: string): string {
  const d = new Date(starts_at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * "Tonight · 7:30 PM" for today, "Sat 8 Aug · 8:00 PM" otherwise. `ends_at`
 * is accepted for signature symmetry with the rest of the module (a future
 * "Tonight · 7:30–10 PM" span format could use it) but isn't rendered yet.
 */
export function formatEventWhen(
  starts_at: string,
  ends_at?: string | null
): string {
  void ends_at;
  const d = new Date(starts_at);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const time = formatEventTime(starts_at);

  if (isSameCalendarDay(d, now)) return `Tonight · ${time}`;

  const tomorrow = new Date(now.getTime() + DAY_MS);
  if (isSameCalendarDay(d, tomorrow)) return `Tomorrow · ${time}`;

  const datePart = d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return `${datePart} · ${time}`;
}

/** "YYYY-MM-DD" in the event's local calendar day — for itinerary day_date. */
export function eventDayDate(starts_at: string): string {
  const d = new Date(starts_at);
  if (Number.isNaN(d.getTime())) return "";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** "Free", "From £12", or "" when price is unknown. */
export function formatEventPrice(
  row: Pick<EventItem, "is_free" | "price_from" | "currency">
): string {
  if (row.is_free) return "Free";
  if (row.price_from == null) return "";
  const currency = row.currency ?? "GBP";
  const symbol =
    currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : `${currency} `;
  const amount = Number.isInteger(row.price_from)
    ? String(row.price_from)
    : row.price_from.toFixed(2);
  return `From ${symbol}${amount}`;
}
