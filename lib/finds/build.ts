/**
 * Finds ("Fomo Finds" on Instagram, "For you" in the app) — join live `finds` rows to their subjects and decide which are
 * still worth showing.
 *
 * Pure and deterministic (no fetch, no `server-only`, `now` is a parameter),
 * same testability rationale as lib/happenings/hero.ts: lib/finds/load.ts and
 * scripts/finds.ts feed it real rows, lib/finds/build.test.ts feeds it
 * fixtures. scripts/finds.ts also reuses `findIsStale` to retire live rows
 * whose subject has ended, so "hidden from /finds" and "retired by the next
 * `suggest`" are always the same decision.
 *
 * Expiry happens at read time, not by cron (there is none): an ended Find just
 * stops being returned, and the next `scripts/finds.ts suggest` flips its row
 * to `retired`. Unlike Saved, which keeps an ended item with an "Ended" pill,
 * Finds drops it — a steal that's over isn't a steal.
 */
import { eventHasEnded } from "@/lib/events/format";
import { happeningHasEnded, nextOccurrence } from "@/lib/happenings/occurrence";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";
import type { FindItem, FindRow } from "@/lib/finds/types";

/** How far ahead "soonest next occurrence" looks when ordering — a year, same horizon happeningHasEnded uses, so any not-ended row yields one. */
const ORDER_LOOKAHEAD_MS = 366 * 86_400_000;

/** Event statuses (supabase/add_event_lifecycle.sql) that mean the event is off. A missing status is "active". */
function eventIsOff(e: EventItem): boolean {
  return e.status === "cancelled" || e.status === "gone" || e.status === "expired";
}

/**
 * True when a Find's subject should no longer be shown: the subject row is
 * gone, a happening is dormant/retired or has run its course, or an event has
 * ended or been cancelled/withdrawn by its source. `undefined` means the
 * lookup found no row (deleted since the Find was made).
 */
export function findIsStale(
  row: Pick<FindRow, "subject_type">,
  subject: Happening | EventItem | undefined,
  now: Date
): boolean {
  if (!subject) return true;
  if (row.subject_type === "happening") {
    const h = subject as Happening;
    return h.status !== "live" || happeningHasEnded(h, now);
  }
  const e = subject as EventItem;
  return eventIsOff(e) || eventHasEnded(e, now);
}

/** Epoch ms of the subject's next start, used only to order ties on Fomo level; no date sorts last. */
function nextStartMs(item: FindItem, now: Date): number {
  if (item.kind === "event") {
    const t = new Date(item.event.starts_at).getTime();
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  }
  const h = item.happening;
  const occ = nextOccurrence(h, now, new Date(now.getTime() + ORDER_LOOKAHEAD_MS));
  if (!occ) return Number.POSITIVE_INFINITY;
  // Real instant when the row has one; otherwise the start of the occurrence's
  // calendar day (an unparsable dayDate sorts last rather than throwing).
  const t = occ.startsAt ? new Date(occ.startsAt).getTime() : new Date(`${occ.dayDate}T00:00:00Z`).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Live Find rows -> renderable items. Drops rows whose subject is missing,
 * ended, dormant or cancelled (see `findIsStale`). Orders by Fomo level
 * (highest first), then soonest next occurrence/start, then id so equal rows
 * never reshuffle between renders.
 *
 * An event that has started but not ended (a multi-day exhibition) keeps its
 * original, past `starts_at` and so sorts ahead of upcoming ties; that's
 * fine — it's "on now", and the level still dominates.
 */
export function buildFindItems(
  rows: readonly FindRow[],
  eventById: ReadonlyMap<string, EventItem>,
  happeningById: ReadonlyMap<string, Happening>,
  now: Date
): FindItem[] {
  const items: FindItem[] = [];
  for (const row of rows) {
    const base = { id: row.id, why: row.why, fomoLevel: row.fomo_level };
    if (row.subject_type === "happening") {
      const happening = happeningById.get(row.subject_id);
      if (!happening || findIsStale(row, happening, now)) continue;
      items.push({ ...base, kind: "happening", happening });
    } else {
      const event = eventById.get(row.subject_id);
      if (!event || findIsStale(row, event, now)) continue;
      items.push({ ...base, kind: "event", event });
    }
  }

  // Compute each sort key once: nextStartMs expands recurrence.
  const startMs = new Map(items.map((it) => [it.id, nextStartMs(it, now)]));
  return items.sort(
    (a, b) =>
      b.fomoLevel - a.fomoLevel ||
      (startMs.get(a.id)! - startMs.get(b.id)! || 0) ||
      a.id.localeCompare(b.id)
  );
}
