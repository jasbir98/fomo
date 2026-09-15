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
