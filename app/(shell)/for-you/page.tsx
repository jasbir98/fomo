import { loadLiveFindsWithTotal } from "@/lib/finds/load";
import { forYouCards, trimForYouCards } from "@/lib/finds/for-you-cards";
import { TEASER_COUNT } from "@/lib/finds/types";
import { loadFeedForPage } from "@/lib/happenings/server-feed";
import { FindsClient } from "./FindsClient";

/** Re-built at most every two minutes, in line with the catalogue cache (lib/db/cached.ts) and /weekend. */
export const revalidate = 120;

/**
 * For you: the hand-picked weekly Finds plus recommendations from the feed. A
 * server component (see FindsClient for the interactive, personalised page).
 *
 * The page is account-only, with a public teaser. This is statically rendered
 * and shared, so the HTML is the same for everyone and must never hold the
 * full list: it carries only the first TEASER_COUNT picks and the total, and a
 * signed-in visitor's client fetches the full list from /api/finds (which
 * checks the session). The `finds` table itself is not readable with the anon
 * key (supabase/add_finds.sql), so this teaser is read with the service role.
 *
 * Loads the teaser and both feed windows exactly as app/(shell)/weekend/page.tsx
 * loads its feed. All loaders never throw: a failure just means fewer cards,
 * and the client fetches its own copy on mount. The feed cards are public (the
 * same ones Home and This weekend show) and are trimmed to the next week before
 * they are handed to the client component, since that is all the
 * recommendations look at and the `coming_up` window runs about 90 days.
 */
export default async function ForYouPage() {
  const [teaser, now, later] = await Promise.all([
    loadLiveFindsWithTotal({ limit: TEASER_COUNT }),
    loadFeedForPage("now"),
    loadFeedForPage("coming_up"),
  ]);
  const initialCards = trimForYouCards(forYouCards([now, later]));
  return <FindsClient initialFinds={teaser.items} initialTotal={teaser.total} initialCards={initialCards} />;
}
