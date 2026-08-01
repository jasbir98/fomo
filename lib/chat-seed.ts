// Client-safe. Builds the "Ask Roameo" deep-link (plan-v1-home-pivot.md §7):
// every card's Ask Roameo action opens chat pre-seeded with what the card was
// about, plus a `returnTo` path so closing chat lands back where you tapped
// from, not on the bare Roameo tab.
import type { CardSubjectType } from "@/lib/types";

export interface ChatSeed {
  type: CardSubjectType;
  id: string;
  name: string;
  city?: string | null;
  coords?: { lat: number; lng: number } | null;
  returnTo: string;
}

const PARAM_PREFIX = "seed";

export function buildAskRoameoHref(seed: ChatSeed): string {
  const params = new URLSearchParams();
  params.set(`${PARAM_PREFIX}Type`, seed.type);
  params.set(`${PARAM_PREFIX}Id`, seed.id);
  params.set(`${PARAM_PREFIX}Name`, seed.name);
  if (seed.city) params.set(`${PARAM_PREFIX}City`, seed.city);
  if (seed.coords) {
    params.set(`${PARAM_PREFIX}Lat`, String(seed.coords.lat));
    params.set(`${PARAM_PREFIX}Lng`, String(seed.coords.lng));
  }
  params.set("returnTo", seed.returnTo);
  return `/roameo?${params.toString()}`;
}

/** Reads a ChatSeed back out of the Roameo page's own search params. Null when the page was opened without a seed (the plain FAB entry). */
export function readChatSeed(searchParams: URLSearchParams): ChatSeed | null {
  const type = searchParams.get(`${PARAM_PREFIX}Type`) as CardSubjectType | null;
  const id = searchParams.get(`${PARAM_PREFIX}Id`);
  const name = searchParams.get(`${PARAM_PREFIX}Name`);
  if (!type || !id || !name) return null;
  const lat = Number(searchParams.get(`${PARAM_PREFIX}Lat`));
  const lng = Number(searchParams.get(`${PARAM_PREFIX}Lng`));
  return {
    type,
    id,
    name,
    city: searchParams.get(`${PARAM_PREFIX}City`),
    coords: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
    returnTo: searchParams.get("returnTo") || "/",
  };
}

const QUESTIONS_BY_TYPE: Record<CardSubjectType, string[]> = {
  place: ["Is it worth the wait?", "What do I order?", "How do I get there?"],
  event: ["What's it actually like?", "Do I need to book?", "What do people wear?"],
  experience: ["Is it worth the price?", "What should I bring?", "How do I get there?"],
  itinerary_item: ["Any tips for this?", "What's nearby after?", "How long should I plan for it?"],
  reel: ["Where exactly is this?", "Is it worth visiting?", "How do I get there?"],
};

/** Suggested-question chips for a seeded chat — never an empty input on open (plan-v1-home-pivot.md §7). */
export function suggestedQuestionsFor(type: CardSubjectType): string[] {
  return QUESTIONS_BY_TYPE[type] ?? QUESTIONS_BY_TYPE.place;
}
