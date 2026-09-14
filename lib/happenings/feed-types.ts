/**
 * Fomo Home feed — shared request/response shapes for GET /api/feed.
 *
 * Client-safe (no `server-only`): both the route handler and the Home page
 * (a client component) need these. Same deliberate exclusion as
 * lib/happenings/types.ts and lib/now/types.ts's non-server-only siblings.
 *
 * RESHAPED for the Home restructure (see the task brief): the feed used to be
 * one hero + date buckets + a flat "standing deals" list + Free Any Time.
 * It's now five independent sections — hero, whatsOn (window-driven),
 * bookEarly, deals (venue-grouped + singles), freeAnyTime — matching the
 * mockup's section-per-concept layout. `hero`, `bookEarly`, `deals` and
 * `freeAnyTime` are all independent of `window`/the old chip filter (which
 * is gone — filtering now lives inside Deals & Offers only); only `whatsOn`
 * respects the window control.
 */
import type { EventItem } from "@/lib/types";
import type { Happening, Occurrence, HappeningCategory } from "@/lib/happenings/types";
import type { FeedBucketKey } from "@/lib/happenings/format";
import type { DealWhatGroup, DealWhoGroup } from "@/lib/happenings/groups";
import type { BookEarlyCardData } from "@/lib/happenings/book-early";

export type FeedWindow = "now" | "month" | "coming_up";

export interface HappeningCardData {
  kind: "happening";
  happening: Happening;
  occurrence: Occurrence;
}

export interface EventCardData {
  kind: "event";
  event: EventItem;
}

/**
 * A collapsed series card — "Parkrun · 3 locations" — replacing every
 * individual member's own card wherever the feed would otherwise have shown
 * them separately (see lib/happenings/series.ts). `lead` is the member
 * whose own soonest occurrence is earliest overall (computed once per
 * request in the feed route, so it stays the same lead across every
 * section); the card borrows its image/category/eligibility for display,
 * and its `/happening/[id]` page is the series' detail view — it lists
 * every member as an "Also at" location (see that page's Locations
 * section). `occurrence` is the soonest occurrence across ALL members
 * within the section's own window, not necessarily the lead's own.
 */
export interface SeriesCardData {
  kind: "series";
  key: string;
  title: string;
  lead: Happening;
  locationCount: number;
  occurrence: Occurrence;
}

export type FeedCardData = HappeningCardData | EventCardData | SeriesCardData;

export interface FeedBucket {
  key: FeedBucketKey;
  title: string;
  /** "3 active" / "Civic Highlight" — null renders no pill at all. */
  meta: string | null;
  cards: FeedCardData[];
}

export interface FreeAnyTimeItem {
  /** "happening" rows are `recurrence: {type:"always"}` catalog rows; "place" rows are live, free (`price_level === 0`) `places` rows — see the route's doc comment for why both feed this zone. */
  kind: "happening" | "place";
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  /** "Chambers St · 10am–5pm Daily" style locality + hours line, already composed — the route owns picking district/hours vs. address as the best available fields. */
  locationLine: string | null;
  /** Category for default-image fallback — `h.category` for happening rows; null for place rows. */
  category: HappeningCategory | null;
  /** Raw district/area (Old Town, Leith, …), separate from `locationLine`'s composed display string — added for the /free page's area filter chips, which need the bare value rather than a "district · hours" sentence. Null when no district could be resolved. */
  district: string | null;
  /** Human type/category label for the /free page's type filter chips — the styled category label (lib/happenings/category-style.ts) for a happening row, or a title-cased `places.category` free-text value for a place row. Null when neither resolved. */
  typeLabel: string | null;
}

/**
 * One `kind: "deal"` happening, decorated with its precomputed WHAT/WHO
 * facets (lib/happenings/groups.ts) so the Deals & Offers filter chips work
 * entirely client-side — no refetch on a chip tap, same principle as the old
 * per-window feed fetch but taken one step further since these facets never
 * change with `window` at all.
 */
export interface DealCardData {
  kind: "happening";
  happening: Happening;
  /** Soonest occurrence for a dated deal; the single "always" pin for a standing deal (recurrence: {type:"always"}) — see lib/happenings/occurrence.ts's `nextOccurrence`. */
  occurrence: Occurrence;
  what: DealWhatGroup;
  who: DealWhoGroup | null;
}

/**
 * One venue's worth of deals, for the "N offers" card that opens
 * `/place/[id]` (task 3). `offers` carries every one of that venue's live
 * deals with its own facets, so the client can recompute the visible count
 * and best-saving badge locally when a filter is applied (task 4's "the
 * count reflects matches").
 */
export interface VenueDealGroup {
  placeId: string;
  placeName: string;
  placeImageUrl: string | null;
  district: string | null;
  offers: DealCardData[];
}

export interface DealsSection {
  venueGroups: VenueDealGroup[];
  /** Deals with no resolvable venue (city/region/national scope, or no `place_id`) — each opens its own `/happening/[id]` rather than a place page. */
  singles: DealCardData[];
}

export interface FeedResponse {
  /** The top-ranked happening for the hero slot, or null when none qualify — the page falls back to rendering the existing /api/now hero via FomoCard. May come from any section (What's on, Book early, or a deal), not just a dated happening. */
  hero: HappeningCardData | null;
  /** Window-driven (Now/This month/Coming up) date-bucketed section — activities, tours, events, festivals, dated free_access, cheap Skiddle/Ticketmaster events, and sports events/happenings regardless of price (lib/now/price.ts's WHATS_ON_PRICE_EXEMPT_CATEGORIES). Excludes every `kind: "deal"` happening — those live in `deals` now, never duplicated here. */
  whatsOn: FeedBucket[];
  /** Always-on, independent of `window` — see lib/happenings/book-early.ts for the ranking/label rules. */
  bookEarly: BookEarlyCardData[];
  /** Always-on, independent of `window`. Replaces the old `standingDeals` — every `kind: "deal"` happening (dated or standing), venue-grouped where a `place_id` resolves. */
  deals: DealsSection;
  freeAnyTime: FreeAnyTimeItem[];
  /** Present only on a hard failure path (no session). Absent — not false — in the normal case, mirroring /api/saved's SavedResponse convention. */
  degraded?: "unauthorized";
}
