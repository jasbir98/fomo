/**
 * Ask Fomo — chat types shared by app/api/chat/route.ts and the chat screen
 * (app/(shell)/fomo/page.tsx).
 *
 * Replies are grounded in Fomo's own catalogue: the model can only point at
 * live happenings and events by id (`items` blocks), which the route resolves
 * into real cards — it never supplies a venue, price, photo or rating itself.
 */

/** A real catalogue item surfaced in a reply, resolved server-side from its id. */
export interface ChatItem {
  kind: "happening" | "event";
  id: string;
  title: string;
  /** When and where, already formatted — e.g. "Tonight 7pm · Sneaky Pete's". */
  subtitle: string | null;
  /** "Free", "20% off", "From £12". */
  badge: string | null;
  image_url: string | null;
  href: string;
  /** Map position (WGS84). Optional: chat history saved before coordinates existed lacks them; null when unknown. */
  lat?: number | null;
  lng?: number | null;
}

/**
 * A venue from Google Places (New), shown when the catalogue has nothing
 * fitting. Compact on purpose: no photos (too costly per chat turn). Every
 * fact here comes straight from Google's response, never the model.
 */
export interface ChatPlace {
  id: string;
  name: string;
  address: string | null;
  rating: number | null;
  ratingCount: number | null;
  /** 0-4, Google's price level. */
  priceLevel: number | null;
  /** "£10-20" from Google's price range, else "£"/"££" from the level, else null. */
  priceText: string | null;
  openNow: boolean | null;
  /** Google's display type, e.g. "Indian restaurant". */
  type: string | null;
  /** Google's review/generative summary, trimmed. */
  summary: string | null;
  /** Google's required disclosure for `summary`, e.g. "Summarized with Gemini". */
  summaryDisclosure: string | null;
  /** https Google Maps link. */
  mapsUrl: string | null;
  /** Map position (WGS84). Optional: chat history saved before coordinates existed lacks them; null when unknown. */
  lat?: number | null;
  lng?: number | null;
}

/** Tappable reply options, optionally with a short lead-in question. */
export interface QuickReplies {
  prompt?: string;
  options: string[];
}

/**
 * `rich_card` and `action_proposal` are trip-era blocks that can still sit in
 * a user's saved chat history; the screen renders them read-only and the
 * route never produces them any more.
 */
export type AiReplyBlock =
  | { kind: "text"; text: string }
  | { kind: "items"; reason?: string; items: ChatItem[] }
  | { kind: "places"; reason?: string; places: ChatPlace[]; attribution: "Google Maps" }
  | { kind: "quick_replies"; quick_replies: QuickReplies }
  | { kind: "rich_card"; card: { name: string; description?: string } }
  | { kind: "action_proposal"; proposal: { title: string; summary?: string } };

/** Starter chips for a fresh chat opened from the Fomo button. */
export const ASK_FOMO_PROMPTS = [
  "Free things to do tonight",
  "Student deals this week",
  "Rainy day ideas under £10",
  "What's worth booking early?",
];
