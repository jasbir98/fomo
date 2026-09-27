/**
 * RFC 5545 (iCalendar) VEVENT building — the .ics download behind every
 * "Add to calendar" button (app/api/happenings/[id]/ics/route.ts and
 * app/api/events/[id]/ics/route.ts), which iOS/Android read natively (opens
 * the device's own Add Event sheet) unlike the pages' own `googleCalendarUrl`
 * links, which only ever open Google Calendar specifically.
 *
 * `buildIcsCalendar` is the generic builder (plain uid/title/start/end/
 * location/description/url fields) — lives here rather than a shape-neutral
 * `lib/ics.ts` because it was born for `buildHappeningIcs` and the provider
 * events route (task: "extend Add to calendar to /event/[id]") reuses it
 * from here rather than duplicating it. `buildHappeningIcs` (happening +
 * occurrence) and `buildEventIcs` (a provider `EventItem`) are both thin
 * adapters onto it — same occurrence-shape reasoning as the happening
 * page's own `googleCalendarUrl`: a timed occurrence (a real `startsAt`, not
 * midnight-UTC) gets a real DTSTART/DTEND; anything else becomes an all-day
 * `VALUE=DATE` event spanning `dayDate`..`lastDayDate` inclusive (DTEND is
 * exclusive in iCalendar, so it's `lastDayDate + 1 day`, same as that
 * function's `nextDay`). A provider event always has a real `starts_at`
 * timestamp (the `events` table column is non-nullable), so `buildEventIcs`
 * never has an all-day case to handle.
 *
 * NOT `server-only` — pure string formatting, no DB/env access — but only
 * ever called from an ics route (a server context) in practice.
 */

import type { Happening, Occurrence } from "./types";
import type { EventItem } from "@/lib/types";
import { isDateOnlyStart } from "@/lib/events/format";

const CRLF = "\r\n";
const FOLD_LIMIT_OCTETS = 75;

/** RFC 5545 §3.3.11 TEXT escaping — backslash first, so the escapes added
 *  for the other three characters don't themselves get re-escaped. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** RFC 5545 §3.1 line folding: no content line may exceed 75 octets
 *  (UTF-8 bytes, not characters); continuation lines start with a single
 *  space. Splits on byte length via TextEncoder so a multi-byte character
 *  never gets cut in half across a fold. */
function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= FOLD_LIMIT_OCTETS) return line;

  const chunks: string[] = [];
  let chunkBytes: number[] = [];
  let limit = FOLD_LIMIT_OCTETS;
  for (const char of line) {
    const charBytes = Array.from(new TextEncoder().encode(char));
    if (chunkBytes.length + charBytes.length > limit) {
      chunks.push(new TextDecoder().decode(new Uint8Array(chunkBytes)));
      chunkBytes = [];
      limit = FOLD_LIMIT_OCTETS - 1; // continuation lines lose one octet to their leading space
    }
    chunkBytes.push(...charBytes);
  }
  if (chunkBytes.length > 0) chunks.push(new TextDecoder().decode(new Uint8Array(chunkBytes)));

  return chunks.map((chunk, i) => (i === 0 ? chunk : ` ${chunk}`)).join(CRLF);
}

/** `YYYYMMDDTHHMMSSZ`, UTC — DTSTAMP and a timed DTSTART/DTEND. */
function formatDateTimeUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** `YYYYMMDD`, UTC calendar date — an all-day DTSTART/DTEND. */
function formatDateOnlyUtc(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** `dayDate + 1 calendar day`, same math as the detail page's `nextDay` —
 *  all-day iCalendar events need an EXCLUSIVE end (a one-day event's DTEND
 *  is the next day, not the same day). */
function nextDay(dayDate: string): string {
  const [y, m, d] = dayDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export const ICS_CONTENT_TYPE = "text/calendar; charset=utf-8";

export interface IcsEventInput {
  /** Globally-unique, stable id — this app's convention is `<row id>@askfomo.com`. */
  uid: string;
  title: string;
  /** Timed: the real start instant. All-day: UTC-midnight of the first day. */
  start: Date;
  /** Timed: the real end instant, defaulting to `start + 2h` when null.
   *  All-day: UTC-midnight of the EXCLUSIVE end day, defaulting to
   *  `start + 1 day` when null (a one-day all-day event). */
  end: Date | null;
  allDay: boolean;
  location: string | null;
  description: string;
  url: string;
}

/** Generic builder — see this file's own doc comment for why the two
 *  domain-specific builders below (`buildHappeningIcs`/`buildEventIcs`)
 *  both funnel through this rather than each building `VCALENDAR` text
 *  themselves. */
export function buildIcsCalendar(input: IcsEventInput, now: Date = new Date()): string {
  const { uid, title, allDay, location, description, url } = input;

  let dtStart: string;
  let dtEnd: string;
  if (allDay) {
    const end = input.end ?? new Date(input.start.getTime() + 86_400_000);
    dtStart = `DTSTART;VALUE=DATE:${formatDateOnlyUtc(input.start)}`;
    dtEnd = `DTEND;VALUE=DATE:${formatDateOnlyUtc(end)}`;
  } else {
    const end = input.end ?? new Date(input.start.getTime() + 2 * 3_600_000);
    dtStart = `DTSTART:${formatDateTimeUtc(input.start)}`;
    dtEnd = `DTEND:${formatDateTimeUtc(end)}`;
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Fomo//Happenings//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${formatDateTimeUtc(now)}`,
    dtStart,
    dtEnd,
    `SUMMARY:${escapeText(title)}`,
    location ? `LOCATION:${escapeText(location)}` : null,
    `DESCRIPTION:${escapeText(description)}`,
    `URL:${url}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((line): line is string => line != null);

  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** Builds a complete `VCALENDAR` (one `VEVENT`) for `happening`'s next
 *  `occurrence` — the same event the "Add to calendar" button's Google
 *  Calendar link describes, just in a format iOS/Android open natively. */
export function buildHappeningIcs(happening: Happening, occurrence: Occurrence, now: Date = new Date()): string {
  const start = occurrence.startsAt ? new Date(occurrence.startsAt) : null;
  const timed = start != null && occurrence.exact && (start.getUTCHours() !== 0 || start.getUTCMinutes() !== 0);

  const detailUrl = `https://askfomo.com/happening/${happening.id}`;
  const location = [happening.venue_name, happening.address].filter(Boolean).join(", ") || null;
  const description = [happening.summary, detailUrl].filter(Boolean).join("\n\n");
  const uid = `${happening.id}@askfomo.com`;

  if (timed && start) {
    const end = occurrence.endsAt ? new Date(occurrence.endsAt) : null;
    return buildIcsCalendar({ uid, title: happening.title, start, end, allDay: false, location, description, url: detailUrl }, now);
  }

  const dayStart = new Date(`${occurrence.dayDate}T00:00:00.000Z`);
  const dayEnd = new Date(`${nextDay(occurrence.lastDayDate)}T00:00:00.000Z`);
  return buildIcsCalendar({ uid, title: happening.title, start: dayStart, end: dayEnd, allDay: true, location, description, url: detailUrl }, now);
}

/** Builds a complete `VCALENDAR` (one `VEVENT`) for a provider event
 *  (Skiddle/Ticketmaster, the `events` table). Date-only events (starts_at
 *  at exactly midnight UTC) become all-day entries; timed events stay timed. */
export function buildEventIcs(event: EventItem, now: Date = new Date()): string {
  const isDateOnly = isDateOnlyStart(event.starts_at);
  const start = new Date(event.starts_at);
  const detailUrl = `https://askfomo.com/event/${event.id}`;
  const location = [event.venue_name, event.address].filter(Boolean).join(", ") || null;
  const description = [event.description, detailUrl].filter(Boolean).join("\n\n");

  if (isDateOnly) {
    // Date-only: convert to all-day event (ends next day)
    const dayEnd = new Date(start.getTime() + 86_400_000);
    return buildIcsCalendar(
      { uid: `${event.id}@askfomo.com`, title: event.name, start, end: dayEnd, allDay: true, location, description, url: detailUrl },
      now
    );
  }

  const end = event.ends_at ? new Date(event.ends_at) : null;
  return buildIcsCalendar(
    { uid: `${event.id}@askfomo.com`, title: event.name, start, end, allDay: false, location, description, url: detailUrl },
    now
  );
}
