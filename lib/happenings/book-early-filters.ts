/**
 * Fomo Happenings — Book Early page filter taxonomy.
 *
 * Pure, deterministic mapping from a `BookEarlyCardData` (lib/happenings/
 * book-early.ts) to the three independent filter facets the /book-early page
 * shows (timing, category, month). Kept separate from book-early.ts for the
 * same reason lib/happenings/groups.ts is kept separate from format.ts: that
 * module ranks/labels every card, this one is specifically the filter
 * taxonomy for one page, computed client-side against the already-ranked
 * list GET /api/feed returns (no refetch on a chip tap).
 */
import type { HappeningCategory } from "@/lib/happenings/types";
import type { BookEarlyCardData } from "@/lib/happenings/book-early";

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export type BookEarlyTiming = "just_on_sale" | "on_sale_soon";

export const TIMING_LABEL: Record<BookEarlyTiming, string> = {
  just_on_sale: "Just on sale",
  on_sale_soon: "On sale soon",
};

export const TIMING_ORDER: BookEarlyTiming[] = ["just_on_sale", "on_sale_soon"];

/** Maps a card's `bookEarlyTier` (0-3) onto the two timing chips the page
 *  offers — tiers 2/3 ("On sale now" / everything else) only ever show under
 *  the "All" chip, matching the task brief's own three-chip spec
 *  (Just on sale / On sale soon / All) rather than inventing a fourth. */
export function timingForCard(card: BookEarlyCardData): BookEarlyTiming | null {
  if (card.tier === 0) return "just_on_sale";
  if (card.tier === 1) return "on_sale_soon";
  return null;
}

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

/** Null for a fallback Skiddle/Ticketmaster event card (no category column) — it only ever shows under the "All" chip. */
export function categoryForCard(card: BookEarlyCardData): HappeningCategory | null {
  return card.kind === "happening" ? card.happening.category : null;
}

// ---------------------------------------------------------------------------
// Month
// ---------------------------------------------------------------------------

export interface MonthFacet {
  /** "2026-10" — zero-padded numeric year-month, so plain string sort is chronological order across the Book Early section's ~1-year lookahead (which can cross a Dec→Jan boundary, where the month *name* alone would sort wrong). */
  key: string;
  /** "Oct", or "Oct '27" when the occurrence falls outside `now`'s calendar year (disambiguates that same year boundary for display). */
  label: string;
}

function cardOccurrenceDate(card: BookEarlyCardData): Date {
  if (card.kind === "happening") {
    return card.occurrence.startsAt
      ? new Date(card.occurrence.startsAt)
      : new Date(`${card.occurrence.dayDate}T00:00:00Z`);
  }
  return new Date(card.event.starts_at);
}

export function monthForCard(
  card: BookEarlyCardData,
  now: Date = new Date(),
  timeZone: string = "Europe/London"
): MonthFacet {
  const d = cardOccurrenceDate(card);
  const shortParts = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone }).formatToParts(d);
  const month = shortParts.find((p) => p.type === "month")?.value ?? "";
  const year = shortParts.find((p) => p.type === "year")?.value ?? "";
  const monthNum =
    new Intl.DateTimeFormat("en-GB", { month: "2-digit", timeZone }).formatToParts(d).find((p) => p.type === "month")
      ?.value ?? "00";
  const currentYear = new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone }).format(now);
  const label = year === currentYear ? month : `${month} '${year.slice(2)}`;
  return { key: `${year}-${monthNum}`, label };
}

// ---------------------------------------------------------------------------
// Combined match
// ---------------------------------------------------------------------------

export function matchesBookEarlyFilters(
  card: BookEarlyCardData,
  timing: BookEarlyTiming | null,
  category: HappeningCategory | null,
  monthKey: string | null,
  now: Date = new Date(),
  timeZone: string = "Europe/London"
): boolean {
  if (timing != null && timingForCard(card) !== timing) return false;
  if (category != null && categoryForCard(card) !== category) return false;
  if (monthKey != null && monthForCard(card, now, timeZone).key !== monthKey) return false;
  return true;
}
