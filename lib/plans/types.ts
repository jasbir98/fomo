/**
 * Shareable weekend plans (askfomo.com/plan/<id>) — shapes shared by the
 * client basket, POST /api/plans, the landing page and its OG image.
 * Client-safe: no `server-only`.
 */

/** Most picks one plan holds; the receipt and the OG collage are laid out for this many. */
export const PLAN_MAX_ITEMS = 4;
/** Fewest picks that make a plan worth a link. */
export const PLAN_MIN_ITEMS = 2;

export type PlanItemKind = "happening" | "event";

/** What the client sends: just a reference. The server resolves everything else. */
export interface PlanRef {
  kind: PlanItemKind;
  id: string;
  /** "YYYY-MM-DD" the visitor picked it for (a recurring happening's card day). Optional; the server falls back to the next occurrence. */
  day?: string | null;
}

export interface PlanPrice {
  /** "FREE", "£5", "From £12", "20% off", or null when unknown. */
  label: string | null;
  /** Pounds, when a number can honestly be stated; null for a discount or an unknown price. */
  amount: number | null;
  /** True when `amount` is a floor (an event's `price_from`), not an exact price. */
  from: boolean;
}

/** One frozen line of a plan, built server-side by lib/plans/snapshot.ts. */
export interface PlanItem {
  kind: PlanItemKind;
  id: string;
  title: string;
  venue: string | null;
  /** "YYYY-MM-DD" in Edinburgh time. */
  day: string;
  /** "7:30pm" when the row carries a real start time, else null. */
  time: string | null;
  /** A real photo URL or a bundled default under /defaults. Never null. */
  image: string;
  price: PlanPrice;
}

export interface Plan {
  id: string;
  items: PlanItem[];
  createdAt: string;
}

/** Detail page for a plan line. */
export function planItemHref(item: Pick<PlanItem, "kind" | "id">): string {
  return `/${item.kind}/${item.id}`;
}
