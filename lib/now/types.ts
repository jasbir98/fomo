import "server-only";
import type {
  CardSignal,
  CardSubjectType,
  EventItem,
  Experience,
  ItineraryItem,
  Place,
  SavedItem,
  Trip,
  TravelPreferences,
} from "@/lib/types";
import type { Coordinates } from "@/lib/geo";
import type { DayForecast } from "@/lib/weather";

export type PlanDensity = "none" | "light" | "full";
export type TripPhase = "arrival" | "early" | "mid" | "last-day";

export interface Gap {
  startsAt: Date;
  endsAt: Date;
  minutes: number;
}

/** Everything a generator needs to decide whether/how strongly it fires. */
export interface RankContext {
  deviceId: string;
  trip: Trip;
  at: Date;
  coords: Coordinates | null;
  /** True only when `coords` came from a fresh browser reading this request, vs. the device_location fallback. */
  coordsAreLive: boolean;
  todaysItems: ItineraryItem[];
  planDensity: PlanDensity;
  currentItem: ItineraryItem | null;
  nextAnchor: ItineraryItem | null;
  gaps: Gap[];
  tripDay: number;
  tripPhase: TripPhase;
  weather: DayForecast | null;
  /** Curated-first, city/proximity-scoped candidate pool — the ranker's whole place universe for this request. */
  candidatePlaces: Place[];
  candidateEvents: EventItem[];
  candidateExperiences: Experience[];
  prefs: TravelPreferences | null;
  recentSignals: CardSignal[];
  /**
   * Coordinates of `nextAnchor`'s underlying place, when it has one — distinct
   * from `coords` (the traveller's own live/cached location). Nothing in the
   * ranker measured proximity to the next planned stop before v1.1 W2; this
   * is what the `near_next` generator (lib/now/generators.ts) anchors on
   * instead of `coords`. Null whenever there's no next anchor, or its place
   * has no resolvable lat/lng.
   */
  nextAnchorCoords: { lat: number; lng: number } | null;
  /** This device's saved_items rows (any trip) — backs the `saved` rail (lib/now/rails.ts) and its `saved_pick` generator. */
  savedItems: SavedItem[];
}

export type CardKind =
  | "add"
  | "directions"
  | "swap"
  | "book"
  | "tell"
  | "location"
  | "watch";

export interface CardAction {
  label: string;
  kind: CardKind;
}

export type Urgency = "low" | "medium" | "high";

export interface CardImage {
  url: string | null;
  quality: "ok" | "thin" | "none";
}

/** One ranked recommendation, before or after scoring. */
export interface Candidate {
  generator: string;
  baseScore: number;
  score: number;
  subject: { type: CardSubjectType; id: string };
  pill: string;
  why: string;
  headline: string;
  detail: string;
  primaryAction: CardAction;
  image: CardImage;
  urgency: Urgency;
  validFrom: string;
  validUntil: string;
  distanceKm: number | null;
  /** Raw subject name (place/event/experience/item title) — distinct from `headline`, which can carry extra framing ("X, now or not today"). Used by the card's Directions/Save/Ask Roameo actions, which need the plain name, not the copy. */
  subjectName: string;
  /** Lat/lng for the Directions action, when the subject has coordinates. */
  coords: { lat: number; lng: number } | null;
  railTitle: string;
  railMeta: string;
}

export interface NextCard {
  kind: "anchor" | "empty";
  itemId: string | null;
  title: string;
  subtitle: string;
  image: CardImage;
}

export interface DiscoverChip {
  intent: "tonight" | "book" | "eat" | "gap" | "indoors";
  label: string;
}

/**
 * One resolved, situational Home section (v1.1 W2) — a `RailSpec` from
 * lib/now/rails.ts whose `condition` passed and whose generated items met
 * `minItems`, with title/reason/items/seeAll already computed server-side.
 */
export interface Rail {
  id: string;
  title: string;
  /** One causal line — "why this rail, why now" (SectionHeader's `meta`). */
  meta: string;
  items: Candidate[];
  seeAllHref: string;
}

export interface NowResponse {
  mode: "planner" | "drifter";
  hero: Candidate | null;
  next: NextCard | null;
  /** Ordered, conditional Home sections — replaces the old single `rail` (v1.1 W2). Empty array is a valid, common state (e.g. a fully-booked morning). */
  rails: Rail[];
  degraded: "no-location" | "no-coverage" | "no-trip" | null;
}

// ---------------------------------------------------------------------------
// Plan's per-day view (plan-v1-home-pivot.md §5) — a different shape from
// NowResponse because Plan isn't anchored to "right now": it shows the whole
// day, past and future, for whichever day is selected.
// ---------------------------------------------------------------------------
export interface DisruptionBlock {
  itemId: string;
  itemTitle: string;
  why: string;
  headline: string;
  detail: string;
  alternativeTitle: string;
  alternativeCategory: string;
  alternativeLocation: string;
  alternativeImage: CardImage;
}

export interface GapBlock {
  /** Item this gap follows, or null when the gap is before the day's first anchor. */
  afterItemId: string | null;
  startsAt: string;
  endsAt: string;
  minutes: number;
  label: string;
  candidates: Candidate[];
}

export interface DayPlanResponse {
  disruption: DisruptionBlock | null;
  gaps: GapBlock[];
  degraded: "no-trip" | null;
}

// ---------------------------------------------------------------------------
// Chip discover surface (plan-v1-home-pivot.md §6) — the picture-grid a
// Home chip opens into. Always pre-filtered, never a blank search.
// ---------------------------------------------------------------------------
export type DiscoverIntentSlug =
  | "tonight"
  | "book"
  | "eat"
  | "gap"
  | "indoors"
  // v1.1 W2 additions — backing the fixed quick-action row's "Nearby" slot and
  // the `near_next`/`closing` rails' See-all links (app/(shell)/page.tsx,
  // lib/now/rails.ts). See app/(shell)/discover/[intent]/page.tsx's
  // VALID_INTENTS for the client-side allowlist.
  | "nearby"
  | "near-next"
  | "closing";

export interface DiscoverResponse {
  title: string;
  meta: string;
  items: Candidate[];
  degraded: "no-trip" | "empty" | null;
}
