// Client-safe. Builds the "Ask Fomo" deep-link (plan-v1-home-pivot.md §7):
// every card's Ask Fomo action opens chat pre-seeded with what the card was
// about, plus a `returnTo` path so closing chat lands back where you tapped
// from, not on the bare Fomo tab.
import type { CardSubjectType } from "@/lib/types";
import { safeNext } from "@/lib/auth/safe-next";

export interface ChatSeed {
  type: CardSubjectType;
  id: string;
  name: string;
  city?: string | null;
  coords?: { lat: number; lng: number } | null;
  returnTo: string;
}

const PARAM_PREFIX = "seed";

export function buildAskFomoHref(seed: ChatSeed): string {
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
  return `/fomo?${params.toString()}`;
}

/** Reads a ChatSeed back out of the Fomo page's own search params. Null when the page was opened without a seed (the plain FAB entry). */
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
    returnTo: safeNext(searchParams.get("returnTo")),
  };
}

const QUESTIONS_BY_TYPE: Record<CardSubjectType, string[]> = {
  place: ["Is it worth the wait?", "What do I order?", "How do I get there?"],
  event: ["What's it actually like?", "Do I need to book?", "What do people wear?"],
  happening: ["How do I claim this?", "Is it worth it?", "What else is on nearby?"],
};

/** Suggested-question chips for a seeded chat — never an empty input on open (plan-v1-home-pivot.md §7). */
export function suggestedQuestionsFor(type: CardSubjectType): string[] {
  return QUESTIONS_BY_TYPE[type] ?? QUESTIONS_BY_TYPE.place;
}

/**
 * Which detail route a seed's own item resolves to, for the chat page's seed
 * card (pending divider or attached-to-message chip) to link to.
 */
export function hrefForSeed(seed: Pick<ChatSeed, "type" | "id">): string | null {
  switch (seed.type) {
    case "place":
      return `/place/${seed.id}`;
    case "event":
      return `/event/${seed.id}`;
    case "happening":
      return `/happening/${seed.id}`;
    default:
      return null;
  }
}
