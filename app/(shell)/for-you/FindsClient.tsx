"use client";

import { useEffect, useMemo, useState } from "react";
import { AppHeader } from "@/components/shell/AppHeader";
import { FindCard } from "@/components/finds/FindCard";
import { ForYouPrompt } from "@/components/finds/ForYouPrompt";
import { FeedListCard, SubscribeCard } from "@/components/happenings";
import { Icon } from "@/components/ui";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { track } from "@/lib/analytics/track";
import type { FindsResponse, FindItem } from "@/lib/finds/types";
import { forYouCards, type ForYouCard } from "@/lib/finds/for-you-cards";
import type { FeedResponse, FeedWindow } from "@/lib/happenings/feed-types";
import { useCachedJson } from "@/lib/http/clientCache";
import { readAffinity, type AffinityMap } from "@/lib/personalise/affinity";
import { buildForYou, type ForYouEntry } from "@/lib/personalise/for-you";
import type { BoostPrefs } from "@/lib/personalise/score";
import { useEffectiveWho } from "@/lib/personalise/useEffectiveWho";
import { usePrefs } from "@/lib/personalise/usePrefs";

/** Matches Home's, What's on's and This weekend's `FEED_STALE_MS`, so all share the same cache entries. */
const FEED_STALE_MS = 60_000;

async function fetchFeed(window: Exclude<FeedWindow, "book_early">, signal?: AbortSignal): Promise<FeedResponse> {
  const res = await fetch(`/api/feed?window=${window}`, { signal });
  if (!res.ok) throw new Error(`GET /api/feed ${res.status}`);
  return (await res.json()) as FeedResponse;
}

async function fetchFinds(signal?: AbortSignal): Promise<FindsResponse> {
  const res = await fetch("/api/finds", { signal });
  if (!res.ok) throw new Error(`GET /api/finds ${res.status}`);
  return (await res.json()) as FindsResponse;
}

/** What a visitor with no taste looks like to the engine; used for the server-matching first render. */
const NO_PREFS: BoostPrefs = { interests: [], budget: "any", who: [] };
const NO_AFFINITY: AffinityMap = {};

export interface FindsClientProps {
  /** Live Finds loaded on the server (page.tsx), so the first HTML already lists them. */
  initialFinds: FindItem[];
  /** Feed cards for the next week loaded on the server (page.tsx); the fallback until the client's own two feed fetches land. */
  initialCards: ForYouCard[];
}

/** Id and kind of the thing a recommendation opens, for analytics. */
function entrySubject(card: ForYouCard): { kind: string; id: string } {
  if (card.kind === "event") return { kind: "event", id: card.event.id };
  if (card.kind === "series") return { kind: "happening", id: card.lead.id };
  if (card.kind === "recurring") {
    return card.lead.kind === "event" ? { kind: "event", id: card.lead.event.id } : { kind: "happening", id: card.lead.happening.id };
  }
  return { kind: "happening", id: card.happening.id };
}

/**
 * "For you" (nav label "For you", route /for-you; internally still the Finds
 * feature, and the same picks run on Instagram as "Fomo Finds"). Two lists:
 *
 *  1. "Picked for you": this week's hand-approved steals (lib/finds), each with
 *     its "why" line and Fomo level, re-ranked for the visitor.
 *  2. "More for you" / "Popular this week": up to ten feed cards from the next
 *     week, chosen by the engine in lib/personalise/for-you.ts from the
 *     visitor's prefs and save history, each with a one-line reason.
 *
 * HYDRATION: prefs and save history only exist in the browser (localStorage /
 * the Supabase session). `usePrefs`/`useEffectiveWho` read through
 * useSyncExternalStore with a default server snapshot, and the save history is
 * read in an effect after mount, so the server HTML and the first client render
 * both show the generic result: the Finds in the engine's neutral order, no
 * reasons, and a skeleton where the second list goes (it depends on today's
 * date and on taste, so it is built only after mount). It then recomputes with
 * the real values. The save-history read is deferred a microtask, the pattern
 * WeekendClient uses for its `?free=1` read, to satisfy
 * react-hooks/set-state-in-effect.
 *
 * Data: Finds from /api/finds, cards from `feed:now` / `feed:coming_up`, the
 * same cache keys Home and This weekend use, so a visit after Home costs no
 * extra feed requests.
 */
export function FindsClient({ initialFinds, initialCards }: FindsClientProps) {
  const finds = useCachedJson<FindsResponse>("finds", fetchFinds, { staleMs: FEED_STALE_MS });
  const now = useCachedJson<FeedResponse>("feed:now", (s) => fetchFeed("now", s), { staleMs: FEED_STALE_MS });
  const later = useCachedJson<FeedResponse>("feed:coming_up", (s) => fetchFeed("coming_up", s), { staleMs: FEED_STALE_MS });

  const findItems = finds.data?.items ?? initialFinds;
  const cards = useMemo(
    () => (now.data && later.data ? forYouCards([now.data, later.data]) : initialCards),
    [now.data, later.data, initialCards]
  );

  const prefs = usePrefs();
  const who = useEffectiveWho();
  const boostPrefs: BoostPrefs = useMemo(
    () => ({ interests: prefs.interests, budget: prefs.budget, who }),
    [prefs.interests, prefs.budget, who]
  );

  // Answering "I'm a…" makes an empty `who` mean "none of these groups", so
  // a "Working" visitor isn't recommended student-only offers.
  const whoKnown = prefs.status !== null || who.length > 0;

  // null until mounted; see HYDRATION above.
  const [affinity, setAffinity] = useState<AffinityMap | null>(null);
  useEffect(() => {
    queueMicrotask(() => setAffinity(readAffinity()));
  }, []);
  const mounted = affinity !== null;

  const result = useMemo(
    () =>
      mounted
        ? buildForYou({ finds: findItems, cards, prefs: boostPrefs, affinity, whoKnown })
        : buildForYou({ finds: findItems, cards: [], prefs: NO_PREFS, affinity: NO_AFFINITY }),
    [mounted, findItems, cards, boostPrefs, affinity, whoKnown]
  );
  const { picks, more, moreTitle, personalised } = result;

  const feedPending = cards.length === 0 && (now.data == null || later.data == null) && now.error == null && later.error == null;
  const moreLoading = !mounted || feedPending;

  const hasPicks = picks.length > 0;
  const nothingAtAll = mounted && !feedPending && !hasPicks && more.length === 0;

  function trackRecOpened(entry: ForYouEntry) {
    const { kind, id } = entrySubject(entry.card);
    track("for_you_rec_opened", { kind, id, reason: entry.reason, personalised });
  }

  return (
    <div className="flex flex-col pb-6">
      <AppHeader title="For you" />

      <div className="flex flex-col gap-4 px-4 pt-1 lg:mx-auto lg:w-full lg:max-w-[1200px] lg:px-8 lg:pt-2">
        <p className="text-body-md text-on-surface-variant">
          Edinburgh&rsquo;s best steals, hand-picked every Friday, plus things matched to your taste.
        </p>

        {nothingAtAll ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong p-8 text-center">
            <FomoSpot mood="meh" pose="shrug" className="h-20 w-20" />
            <p className="text-headline-sm font-bold text-on-surface">Nothing here yet</p>
            <p className="text-body-md text-on-surface-variant">Sign up below to get the picks by email.</p>
          </div>
        ) : null}

        {hasPicks ? (
          <section aria-labelledby="picked-heading" className="flex flex-col gap-3">
            <h2 id="picked-heading" className="px-1 text-headline-sm font-extrabold tracking-tight text-on-surface">
              Picked for you
            </h2>
            <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 xl:grid-cols-3">
              {picks.map((entry, i) =>
                entry.find ? <FindCard key={entry.key} item={entry.find} reason={entry.reason} position={i} /> : null
              )}
            </div>
          </section>
        ) : null}

        {mounted && !personalised ? <ForYouPrompt /> : null}

        {moreLoading ? (
          <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4 xl:grid-cols-3" role="status" aria-live="polite">
            <span className="sr-only">Loading recommendations…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className={`h-24 animate-pulse rounded-lg bg-surface-container ${i === 2 ? "hidden xl:block" : ""}`} />
            ))}
          </div>
        ) : more.length > 0 ? (
          <section aria-labelledby="more-heading" className="flex flex-col gap-3">
            <h2 id="more-heading" className="px-1 text-headline-sm font-extrabold tracking-tight text-on-surface">
              {moreTitle}
            </h2>
            <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 xl:grid-cols-3">
              {more.map((entry, i) => (
                <div key={entry.key} className="flex flex-col gap-1.5">
                  {entry.reason ? (
                    <span className="inline-flex w-fit max-w-full items-center gap-1 px-1 text-label-sm font-bold text-primary">
                      <Icon name="auto_awesome" filled size={12} className="shrink-0" />
                      <span className="truncate">{entry.reason}</span>
                    </span>
                  ) : null}
                  <FeedListCard card={entry.card} surface="for_you" position={i} onOpen={() => trackRecOpened(entry)} />
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <SubscribeCard source="finds" />
      </div>
    </div>
  );
}
