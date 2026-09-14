import "server-only";
import type {
  CardSignal,
  CardSubjectType,
  EventItem,
  Experience,
  Place,
  SavedItem,
  TravelPreferences,
} from "@/lib/types";
import type { CityConfig } from "@/lib/city";
import type { Coordinates } from "@/lib/geo";
import type { DayForecast } from "@/lib/weather";
import type { Persona } from "@/lib/now/persona";

/** Everything a generator needs to decide whether/how strongly it fires. */
export interface FeedContext {
  at: Date;
  coords: Coordinates | null;
  /** True only when `coords` came from a fresh browser reading this request, vs. the device_location fallback. */
  coordsAreLive: boolean;
  city: CityConfig;
  weather: DayForecast | null;
  prefs: TravelPreferences | null;
  /**
   * Resolved persona view (`resolvePersona(prefs)`, lib/now/persona.ts) —
   * not in the brief's literal FeedContext field list, but every kept
   * generator (closingSoon/eventTonight/localPick/reelEcho/indoorPick/
   * familyPick) and lib/now/rank.ts's scoring reads `ctx.persona.*`
   * pervasively; dropping it would mean recomputing `resolvePersona(prefs)`
   * from scratch in half a dozen call sites instead of once in
   * buildFeedContext. Kept as a deliberate deviation — see the v0 report.
   */
  persona: Persona;
  signals: CardSignal[];
  savedItems: SavedItem[];
  /** Curated-first, proximity-scoped candidate pool — the ranker's whole place universe for this request. */
  candidatePlaces: Place[];
  candidateEvents: EventItem[];
  candidateExperiences: Experience[];
  // TODO(happenings): a merged happenings+events candidate pool lands here
  // once the `happenings` table and its read path exist.
}

export type CardKind = "add" | "directions" | "swap" | "book" | "tell" | "location" | "watch";

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
  /** Raw subject name (place/event/experience/item title) — distinct from `headline`, which can carry extra framing ("X, now or not today"). Used by the card's Directions/Save/Ask Fomo actions, which need the plain name, not the copy. */
  subjectName: string;
  /** Lat/lng for the Directions action, when the subject has coordinates. */
  coords: { lat: number; lng: number } | null;
  railTitle: string;
  railMeta: string;
}

export interface NowResponse {
  mode: "planner" | "drifter";
  hero: Candidate | null;
  degraded: "no-location" | "no-coverage" | "unauthorized" | null;
}

// ---------------------------------------------------------------------------
// Chip discover surface (plan-v1-home-pivot.md §6) — the picture-grid a
// Home chip opens into. Always pre-filtered, never a blank search.
// ---------------------------------------------------------------------------
export type DiscoverIntentSlug = "eat" | "nearby" | "indoors" | "tonight" | "book";

export interface DiscoverResponse {
  title: string;
  meta: string;
  items: Candidate[];
  degraded: "empty" | "unauthorized" | null;
}
