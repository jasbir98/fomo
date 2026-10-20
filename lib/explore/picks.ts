import type { ChatItem, ChatPlace } from "@/lib/fomo-ai";
import { itemResultKey, placeResultKey } from "@/components/fomo/chat/ResultCards";
import type { MapPick } from "@/lib/explore/types";

function finiteCoords(lat: number | null | undefined, lng: number | null | undefined): { lat: number; lng: number } | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/** True when at least one item/place in the reply has usable coordinates (so it can be drawn on the map). */
export function hasMappableResults(results: { items: ChatItem[]; places: ChatPlace[] } | null): boolean {
  if (!results) return false;
  return (
    results.items.some((i) => finiteCoords(i.lat, i.lng)) || results.places.some((p) => finiteCoords(p.lat, p.lng))
  );
}

/** How many distinct results (cards) a reply showed, mappable or not — the picks chip's "3 of 4". */
export function countResults(results: { items: ChatItem[]; places: ChatPlace[] } | null): number {
  if (!results) return 0;
  return new Set([...results.items.map(itemResultKey), ...results.places.map(placeResultKey)]).size;
}

/**
 * The numbered map markers for one assistant reply: its catalogue items first,
 * then its Google places, in the order the reply showed them, each numbered
 * from 1 over the results that actually have coordinates. Keys match the chat
 * cards' `data-result-key`, so a marker and its card can find each other.
 */
export function buildPicks(results: { items: ChatItem[]; places: ChatPlace[] } | null): MapPick[] {
  if (!results) return [];
  const picks: MapPick[] = [];
  const seen = new Set<string>();
  for (const item of results.items) {
    const c = finiteCoords(item.lat, item.lng);
    const key = itemResultKey(item);
    if (!c || seen.has(key)) continue;
    seen.add(key);
    picks.push({ key, ...c, rank: picks.length + 1, title: item.title });
  }
  for (const place of results.places) {
    const c = finiteCoords(place.lat, place.lng);
    const key = placeResultKey(place);
    if (!c || seen.has(key)) continue;
    seen.add(key);
    picks.push({ key, ...c, rank: picks.length + 1, title: place.name });
  }
  return picks;
}
