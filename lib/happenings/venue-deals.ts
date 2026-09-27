/**
 * Fomo Happenings — venue grouping for an already-ranked deal list.
 *
 * app/api/feed/route.ts's `buildDealsSection` venue-groups the FULL deals
 * catalog once per request (place_id, falling back to normalised
 * venue_name — see that function's own doc comment) for the `/deals` page.
 * Home's "Today's deals" strip (lib/happenings/today-deals.ts) can't just
 * reuse that section's `venueGroups`/`singles` split directly, though: it
 * first RE-RANKS a subset of the catalog (today-only, tiered, topped-up,
 * eligibility-sorted — see `todaysDeals`), and that ranked subset routinely
 * contains only SOME of a venue's deals, or drops a venue's higher-tier
 * offer while keeping a lower one — grouping has to run again, after
 * ranking, over whatever actually made the cut. Reported bug this fixes:
 * `todaysDeals` used to flatten the server's `venueGroups` straight back
 * into individual cards for ranking and never re-grouped the result, so
 * Camera Obscura's deals rendered as 2-3 separate cards on Home despite
 * `/deals` already grouping them.
 *
 * Same venue key as the server-side grouping (place_id, else normalised
 * venue_name via lib/happenings/merge-events.ts's `normalizeText`) and the
 * same "group takes the position of its best/first member" rule as
 * lib/happenings/recurring.ts — this is a stable first-occurrence pass over
 * an already-ranked list, never a re-sort.
 */
import { normalizeText } from "@/lib/happenings/merge-events";
import type { DealCardData } from "@/lib/happenings/feed-types";

export interface DealVenueGroup {
  kind: "group";
  key: string;
  placeId: string | null;
  placeName: string;
  placeImageUrl: string | null;
  district: string | null;
  offers: DealCardData[];
}

export type RankedDealItem = DealVenueGroup | { kind: "single"; card: DealCardData };

/**
 * `place:<id>` when a happening has one; a name-keyed card with NO
 * `place_id` still resolves to the SAME `place:<id>` key when its
 * normalised `venue_name` matches a `place_id`-having card elsewhere in the
 * list (`nameToPlaceId`) — this is what keeps Camera Obscura's third deal
 * (no `place_id`) in the same group as its other two (which do have one),
 * rather than splitting into a 2-card group plus a stray single. Falls back
 * to a plain `venue:<name>` key only when no `place_id` match exists at all.
 */
function venueKeyOf(card: DealCardData, nameToPlaceId: Map<string, string>): string | null {
  const h = card.happening;
  if (h.place_id) return `place:${h.place_id}`;
  if (!h.venue_name) return null;
  const norm = normalizeText(h.venue_name);
  const placeId = nameToPlaceId.get(norm);
  return placeId ? `place:${placeId}` : `venue:${norm}`;
}

/**
 * Groups an already-ranked `cards` list by venue, preserving order: a group
 * lands at its first (best-ranked) member's position, every later member's
 * slot is dropped. A "group" of exactly one member renders as a plain
 * `single` — grouping only matters at 2+.
 */
export function groupDealsByVenue(cards: DealCardData[]): RankedDealItem[] {
  const nameToPlaceId = new Map<string, string>();
  for (const card of cards) {
    const h = card.happening;
    if (h.place_id && h.venue_name) nameToPlaceId.set(normalizeText(h.venue_name), h.place_id);
  }

  const keys = cards.map((card) => venueKeyOf(card, nameToPlaceId));
  const counts = new Map<string, number>();
  for (const key of keys) if (key) counts.set(key, (counts.get(key) ?? 0) + 1);

  const result: RankedDealItem[] = [];
  const firstIndexOfKey = new Map<string, number>();
  const membersByKey = new Map<string, DealCardData[]>();

  cards.forEach((card, i) => {
    const key = keys[i];
    if (!key || (counts.get(key) ?? 0) < 2) {
      result.push({ kind: "single", card });
      return;
    }
    if (!membersByKey.has(key)) {
      membersByKey.set(key, []);
      firstIndexOfKey.set(key, result.length);
      result.push({ kind: "single", card }); // placeholder — replaced below
    }
    membersByKey.get(key)!.push(card);
  });

  for (const [key, offers] of membersByKey) {
    const first = offers[0].happening;
    // The group's FIRST member (best-ranked) might itself be the one
    // `place_id`-less card that only joined via a name match — pull the
    // real `place_id`/name from whichever member actually carries it,
    // never assume `offers[0]` has it.
    const placeId = offers.find((o) => o.happening.place_id)?.happening.place_id ?? null;
    result[firstIndexOfKey.get(key)!] = {
      kind: "group",
      key,
      placeId,
      placeName: first.venue_name ?? "Edinburgh venue",
      placeImageUrl: offers.find((o) => o.happening.image_url)?.happening.image_url ?? null,
      district: first.district ?? null,
      offers,
    };
  }

  return result;
}
