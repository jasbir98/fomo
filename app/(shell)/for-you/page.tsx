import { loadLiveFinds } from "@/lib/finds/load";
import { forYouCards, trimForYouCards } from "@/lib/finds/for-you-cards";
import { loadFeedForPage } from "@/lib/happenings/server-feed";
import { FindsClient } from "./FindsClient";

/** Re-built at most every two minutes, in line with the catalogue cache (lib/db/cached.ts) and /weekend. */
export const revalidate = 120;

/**
 * For you: the hand-picked weekly Finds plus recommendations from the feed. A
 * server component so the HTML already lists this week's picks (see
 * FindsClient for the interactive, personalised page).
 *
 * Loads the Finds and both feed windows exactly as app/(shell)/weekend/page.tsx
 * loads its feed. Both loaders never throw: a failure just means fewer cards,
 * and the client fetches its own copy on mount. The cards are trimmed to the
 * next week before they are handed to the client component, since that is all
 * the recommendations look at and the `coming_up` window runs about 90 days.
 */
export default async function ForYouPage() {
  const [finds, now, later] = await Promise.all([loadLiveFinds(), loadFeedForPage("now"), loadFeedForPage("coming_up")]);
  const initialCards = trimForYouCards(forYouCards([now, later]));
  return <FindsClient initialFinds={finds} initialCards={initialCards} />;
}
