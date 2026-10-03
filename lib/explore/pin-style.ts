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
import { directionsUrlFor } from "@/lib/maps/links";

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
  if (pin.href.startsWith("/happening/")) return "happening";
  return null;
}

/**
 * Google Maps directions link built straight off a pin's own lat/lng —
 * every `ExplorePin` has coordinates (that's the whole point of a map pin),
 * so this always returns a valid URL (pins always have coordinates). Delegates
 * to the shared directionsUrlFor helper.
 */
export function directionsUrlForPin(pin: Pick<ExplorePin, "lat" | "lng">): string {
  return directionsUrlFor({ lat: pin.lat, lng: pin.lng })!;
}

/** Brand navy — fill of the numbered "Fomo's pick" markers. */
export const PICK_MARKER_COLOR = "#1b365d";
/** Accent ring around a highlighted pick/pin marker (hover or selection). */
export const MARKER_HIGHLIGHT_RING = "#fc8a40";

const PICK_MARKER_SIZE = 32;

/**
 * Builds the DOM for one numbered pick marker: an outer 32px box that Mapbox
 * positions (it owns that element's `transform`, so nothing visual lives on
 * it) and an inner circle that carries the look and scales when highlighted.
 */
export function createPickMarkerElement(rank: number, title: string): { el: HTMLDivElement; inner: HTMLDivElement } {
  const el = document.createElement("div");
  el.style.width = `${PICK_MARKER_SIZE}px`;
  el.style.height = `${PICK_MARKER_SIZE}px`;
  el.style.cursor = "pointer";
  el.style.zIndex = "10";
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", `${rank}. ${title}`);

  const inner = document.createElement("div");
  inner.textContent = String(rank);
  inner.style.width = "100%";
  inner.style.height = "100%";
  inner.style.display = "flex";
  inner.style.alignItems = "center";
  inner.style.justifyContent = "center";
  inner.style.boxSizing = "border-box";
  inner.style.borderRadius = "50%";
  inner.style.background = PICK_MARKER_COLOR;
  inner.style.color = "#ffffff";
  inner.style.font = "700 14px/1 system-ui, sans-serif";
  inner.style.border = "2px solid #ffffff";
  inner.style.transition = "transform 120ms ease-out, box-shadow 120ms ease-out";
  el.appendChild(inner);
  stylePickMarker(el, inner, false);
  return { el, inner };
}

/** Normal vs highlighted look (scale 1.25 + accent ring) for a marker built by `createPickMarkerElement`. */
export function stylePickMarker(el: HTMLElement, inner: HTMLElement, highlighted: boolean): void {
  inner.style.transform = highlighted ? "scale(1.25)" : "scale(1)";
  inner.style.boxShadow = highlighted
    ? `0 0 0 3px ${MARKER_HIGHLIGHT_RING}, 0 3px 10px rgba(3,22,50,0.5)`
    : "0 2px 6px rgba(3,22,50,0.45)";
  // Above every other pick while highlighted so overlapping numbers stay readable.
  el.style.zIndex = highlighted ? "20" : "10";
}
