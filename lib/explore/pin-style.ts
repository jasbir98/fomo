/**
 * Fomo Explore — per-pin-type visual + action-capability mapping.
 *
 * `ExplorePin` (lib/explore/types.ts) is deliberately the lightweight shape
 * GET /api/explore returns — no `CardSubjectType`, no full Place/Happening
 * row. Two things in this module bridge that gap for the client:
 *
 *  - `PIN_TYPE_STYLE`: a literal hex colour (Mapbox markers, unlike DOM
 *    elements, don't take a Tailwind class) + Material Symbols icon + label
 *    per `ExplorePinType`, shared by the map markers, the layer-switch
 *    legend, and the results-list type badge — one palette, not three.
 *  - `subjectTypeForPin`: which of Save / Ask Fomo a pin can actually use.
 *    Those helpers (lib/db/saved.ts, lib/chat-seed.ts) are typed on
 *    `CardSubjectType`, which has no "happening" member — so a deal/free/
 *    event pin backed by a `happenings` row (href `/happening/<id>`) can't
 *    call them today. Derived from the pin's own `href` prefix rather than
 *    carrying a redundant field on the wire: `/place/<id>` → "place",
 *    `/event/<id>` → "event" (a provider EventItem, which IS a
 *    CardSubjectType), `/happening/<id>` → null. A null-returning pin still
 *    gets Directions (works off raw lat/lng, no CardSubjectType needed) and
 *    "View details", which lands on a page that has its own Save action —
 *    it just doesn't get the inline one-tap Save/Ask Fomo this sheet offers
 *    for the other two.
 */
import type { ExploreLayer, ExplorePin, ExplorePinType } from "@/lib/explore/types";
import type { CardSubjectType } from "@/lib/types";

export interface PinTypeStyle {
  label: string;
  /** Marker fill — literal hex, not a Tailwind token (mapbox-gl markers set `color` directly). */
  color: string;
  /** Material Symbols Outlined ligature name. */
  icon: string;
}

export const PIN_TYPE_STYLE: Record<ExplorePinType, PinTypeStyle> = {
  place: { label: "Place", color: "#031632", icon: "location_on" },
  deal: { label: "Deal", color: "#b91c1c", icon: "sell" },
  event: { label: "Event", color: "#7e22ce", icon: "event" },
  free: { label: "Free", color: "#15803d", icon: "redeem" },
};

export const PIN_TYPE_ORDER: ExplorePinType[] = ["place", "deal", "event", "free"];

/** Which pin type(s) the layer-switch legend should show swatches for. */
export const LAYER_PIN_TYPES: Record<ExploreLayer, ExplorePinType[]> = {
  everything: PIN_TYPE_ORDER,
  places: ["place"],
  deals: ["deal"],
  events: ["event"],
  free: ["free"],
};

/** Which `CardSubjectType` (if any) a pin's own detail route corresponds to — see this file's header. */
export function subjectTypeForPin(pin: Pick<ExplorePin, "href">): CardSubjectType | null {
  if (pin.href.startsWith("/place/")) return "place";
  if (pin.href.startsWith("/event/")) return "event";
  return null;
}

/**
 * Google Maps directions link built straight off a pin's own lat/lng —
 * every `ExplorePin` has coordinates (that's the whole point of a map pin),
 * so unlike `subjectTypeForPin` this works for all four types, including the
 * `/happening/<id>` pins Save/Ask Fomo can't touch. Deliberately not
 * `lib/maps/links.ts`'s `buildDirectionsUrl` — that helper takes a full
 * `Place` (for its `google_place_id` disambiguation and address/name
 * fallback), which a pin doesn't have; same URL shape, just fed straight
 * from the pin's coordinates.
 */
export function directionsUrlForPin(pin: Pick<ExplorePin, "lat" | "lng">): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${pin.lat},${pin.lng}`;
}
