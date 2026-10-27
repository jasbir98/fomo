/**
 * Turns the refs a visitor picked into the frozen `PlanItem`s a plan row
 * stores. Every title, time, price and image comes from the happenings/events
 * rows read here, never from the request body, so a plan link can't put
 * arbitrary text or images on an askfomo.com receipt.
 */
import "server-only";
import { createHash } from "node:crypto";
import { listEventsByIds } from "@/lib/db/events";
import { listHappeningsByIds } from "@/lib/db/happenings";
import { eventDayDate, eventHasEnded, formatEventTime } from "@/lib/events/format";
import { eventImageFor } from "@/lib/events/image";
import { defaultImageFor } from "@/lib/happenings/category-style";
import { addDays, endOfLocalDay, localDayDate, nextOccurrence, nextOccurrences, startOfLocalDay } from "@/lib/happenings/occurrence";
import type { Happening } from "@/lib/happenings/types";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { EventItem } from "@/lib/types";
import { priceForEvent, priceForHappening } from "./price";
import type { PlanItem, PlanRef } from "./types";

/** How far ahead a happening with no picked day looks for its next date. */
const LOOKAHEAD_DAYS = 60;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function happeningItem(h: Happening, wantedDay: string | null | undefined, now: Date): PlanItem | null {
  if (h.status !== "live") return null;
  const today = localDayDate(now);
  let occ = null;
  let day: string | null = null;
  if (wantedDay && DAY_RE.test(wantedDay) && wantedDay >= today && wantedDay <= addDays(today, LOOKAHEAD_DAYS)) {
    occ = nextOccurrences(h, startOfLocalDay(wantedDay), endOfLocalDay(wantedDay))[0] ?? null;
    if (occ) day = wantedDay;
  }
  if (!occ) {
    occ = nextOccurrence(h, now, endOfLocalDay(addDays(today, LOOKAHEAD_DAYS)));
    // A multi-day run (an exhibition since June) is on today, not on its first day.
    if (occ) day = occ.dayDate < today ? today : occ.dayDate;
  }
  if (!occ || !day) return null;
  return {
    kind: "happening",
    id: h.id,
    title: h.title,
    venue: h.venue_name,
    day,
    time: occ.startsAt && localDayDate(new Date(occ.startsAt)) === day ? formatEventTime(occ.startsAt) || null : null,
    image: h.image_url || defaultImageFor(h),
    price: priceForHappening(h),
  };
}

function eventItem(e: EventItem, now: Date): PlanItem | null {
  if ((e.status ?? "active") !== "active" || eventHasEnded(e, now)) return null;
  const startDay = eventDayDate(e.starts_at);
  const today = localDayDate(now);
  return {
    kind: "event",
    id: e.id,
    title: e.name,
    venue: e.venue_name,
    // An exhibition that started last week is on today.
    day: startDay && startDay > today ? startDay : today,
    time: startDay >= today ? formatEventTime(e.starts_at) || null : null,
    image: eventImageFor(e),
    price: priceForEvent(e),
  };
}

/**
 * Resolves refs to plan lines, sorted by day then time. Refs whose row is
 * missing, retired or over are dropped; the caller decides whether what is
 * left is still a plan.
 */
export async function buildPlanItems(refs: PlanRef[], now: Date = new Date()): Promise<PlanItem[]> {
  // Service role so a pick that has since gone dormant or ended is still found
  // and then dropped by happeningItem/eventItem below (status + ended checks),
  // rather than depending on what the public policy exposes. Rows are only
  // ever turned into PlanItems (title, venue, day, price, image).
  const db = supabaseAdmin();
  const happeningIds = refs.filter((r) => r.kind === "happening").map((r) => r.id);
  const eventIds = refs.filter((r) => r.kind === "event").map((r) => r.id);
  const [happenings, events] = await Promise.all([listHappeningsByIds(db, happeningIds), listEventsByIds(db, eventIds)]);
  const happeningById = new Map(happenings.map((h) => [h.id, h]));
  const eventById = new Map(events.map((e) => [e.id, e]));

  const items: PlanItem[] = [];
  for (const ref of refs) {
    if (ref.kind === "happening") {
      const h = happeningById.get(ref.id);
      const item = h ? happeningItem(h, ref.day, now) : null;
      if (item) items.push(item);
    } else {
      const e = eventById.get(ref.id);
      const item = e ? eventItem(e, now) : null;
      if (item) items.push(item);
    }
  }
  return items.sort((a, b) => a.day.localeCompare(b.day) || (a.time ?? "99").localeCompare(b.time ?? "99"));
}

/** Same picks on the same days → same hash → same link. */
export function planItemsHash(items: Pick<PlanItem, "kind" | "id" | "day">[]): string {
  const key = items
    .map((i) => `${i.kind}:${i.id}:${i.day}`)
    .sort()
    .join("|");
  return createHash("sha256").update(key).digest("hex");
}
