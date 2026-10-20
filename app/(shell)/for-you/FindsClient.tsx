"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/shell/AppHeader";
import { FindCard } from "@/components/finds/FindCard";
import { ForYouLocked } from "@/components/finds/ForYouLocked";
import { ForYouPrompt } from "@/components/finds/ForYouPrompt";
import { FeedListCard, SubscribeCard } from "@/components/happenings";
import { Icon, SegmentedControl, StickyFilterBar, type SegmentOption } from "@/components/ui";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { track } from "@/lib/analytics/track";
import type { FindsResponse, FindItem } from "@/lib/finds/types";
import { forYouCards, type ForYouCard } from "@/lib/finds/for-you-cards";
import type { FeedResponse, FeedWindow } from "@/lib/happenings/feed-types";
import { useCachedJson } from "@/lib/http/clientCache";
import type { AffinityMap } from "@/lib/personalise/affinity";
import { buildForYou, type ForYouEntry, type ForYouGroupKey } from "@/lib/personalise/for-you";
import type { BoostPrefs } from "@/lib/personalise/score";
import { useEffectiveWho } from "@/lib/personalise/useEffectiveWho";
import { useAffinity } from "@/lib/personalise/useAffinity";
import { usePrefs } from "@/lib/personalise/usePrefs";
import { useSignedIn } from "@/lib/useSaved";

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
  /** The teaser: the first couple of live Finds, loaded on the server (page.tsx), so the first HTML already lists them. Never the full list. */
  initialFinds: FindItem[];
  /** How many live Finds there are in all, for the locked card's "N more picks". */
  initialTotal: number;
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

/** Header and intro line shared by the teaser and the full page. */
function ForYouFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col pb-6">
      <AppHeader title="For you" />

      <div className="flex flex-col gap-4 px-4 pt-1 lg:mx-auto lg:w-full lg:max-w-[1200px] lg:px-8 lg:pt-2">
        <p className="text-body-md text-on-surface-variant">
          Edinburgh&rsquo;s best steals, hand-picked every Friday, plus things matched to your taste.
        </p>
        {children}
      </div>
    </div>
  );
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
 * ACCOUNT-ONLY, with a public teaser. `FindsClient` switches on `useSignedIn()`:
 *  - signed in: `ForYouFull`, the page described above, fetching the full
 *    list from /api/finds (which checks the session);
 *  - signed out, or still checking (`null`): `ForYouTeaser`, the 2 teaser picks
 *    the server rendered, then (once signed-out is known) `ForYouLocked` and the
 *    email digest card. No Deals/Events switch, no recommendations, no "Make
 *    this yours" prompt. The server HTML never holds more than the teaser.
 *
 * HYDRATION: prefs and save history only exist in the browser (localStorage /
 * the Supabase session). `usePrefs`/`useEffectiveWho` read through
 * useSyncExternalStore with a default server snapshot, and the save history
 * comes from useAffinity (signed-in only, also through useSyncExternalStore).
 * The second list waits for a `mounted` flag set in an effect, so the server
 * HTML and the first client render both show the generic result: the Finds in the engine's neutral order, no
 * reasons, and a skeleton where the second list goes (it depends on today's
 * date and on taste, so it is built only after mount). It then recomputes with
 * the real values. The `mounted` flag is set a microtask after mount, the pattern
 * WeekendClient uses for its `?free=1` read, to satisfy
 * react-hooks/set-state-in-effect.
 *
 * Data: Finds from /api/finds, cards from `feed:now` / `feed:coming_up`, the
 * same cache keys Home and This weekend use, so a visit after Home costs no
 * extra feed requests.
 */
export function FindsClient(props: FindsClientProps) {
  const signedIn = useSignedIn();
  return signedIn === true ? (
    <ForYouFull initialFinds={props.initialFinds} initialCards={props.initialCards} />
  ) : (
    <ForYouTeaser initialFinds={props.initialFinds} total={props.initialTotal} signedIn={signedIn} />
  );
}

/**
 * What a visitor who isn't signed in gets: the teaser picks in the server's
 * order (no taste to rank by), then the sign-in card and the email digest. While
 * the session check is still running (`signedIn === null`, which is also what
 * the server HTML and the first client render are) the card slot is a skeleton,
 * so nothing here depends on who the visitor is until the check lands and the
 * page can't hydrate differently from the server.
 */
function ForYouTeaser({ initialFinds, total, signedIn }: { initialFinds: FindItem[]; total: number; signedIn: boolean | null }) {
  return (
    <ForYouFrame>
      {initialFinds.length > 0 ? (
        <section aria-label="Picked for you" className="flex flex-col gap-3">
          <h2 className="px-1 text-label-lg font-bold uppercase tracking-wide text-on-surface-variant">Picked for you</h2>
          <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4 xl:grid-cols-3">
            {initialFinds.map((item, i) => (
              <FindCard key={item.id} item={item} position={i} />
            ))}
          </div>
        </section>
      ) : null}

      {signedIn === false ? (
        <>
          <ForYouLocked total={total} shown={initialFinds.length} />
          <SubscribeCard source="finds" />
        </>
      ) : (
        <div className="h-32 animate-pulse rounded-2xl bg-surface-container" role="status" aria-live="polite">
          <span className="sr-only">Loading</span>
        </div>
      )}
    </ForYouFrame>
  );
}

/** The signed-in page: the full list of picks plus recommendations (see the doc comment above). */
function ForYouFull({ initialFinds, initialCards }: { initialFinds: FindItem[]; initialCards: ForYouCard[] }) {
  // Own cache key: the signed-in response is the full list, and no other key can hold a signed-out teaser.
  // `initialFinds` (the 2-pick teaser) is only the paint-while-loading fallback; the full list replaces it.
  const finds = useCachedJson<FindsResponse>("finds:account", fetchFinds, { staleMs: FEED_STALE_MS });
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
    () => ({ interests: prefs.interests, budget: prefs.budget, who, kids: prefs.kids }),
    [prefs.interests, prefs.budget, who, prefs.kids]
  );

  // Answering "I'm a…" makes an empty `who` mean "none of these groups", so
  // a "Working" visitor isn't recommended student-only offers.
  const whoKnown = prefs.status !== null || who.length > 0;

  // The stored save history (signed-in only; `{}` otherwise, see useAffinity). It is read
  // through useSyncExternalStore, so it is safe on the first render, but the second list
  // still waits for `mounted` (false until after mount); see HYDRATION above.
  const affinity = useAffinity();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  const result = useMemo(
    () =>
      mounted
        ? buildForYou({ finds: findItems, cards, prefs: boostPrefs, affinity, whoKnown })
        : buildForYou({ finds: findItems, cards: [], prefs: NO_PREFS, affinity: NO_AFFINITY }),
    [mounted, findItems, cards, boostPrefs, affinity, whoKnown]
  );
  const { groups, picks, more, moreTitle, personalised } = result;
  // Analytics positions stay page-wide (0..n across both groups), as before the split.
  const pickPosition = useMemo(() => new Map(picks.map((e, i) => [e.key, i])), [picks]);
  const morePosition = useMemo(() => new Map(more.map((e, i) => [e.key, i])), [more]);

  const feedPending = cards.length === 0 && (now.data == null || later.data == null) && now.error == null && later.error == null;

  // Deals & offers | Events switch at the top, so Events isn't a long scroll
  // away. Kept in the URL (`?tab=events`) so an IG link can land on Events;
  // the page is statically rendered, so the URL is read once after mount
  // (same pattern as /weekend's `?free=1`).
  const router = useRouter();
  const [tab, setTabState] = useState<ForYouGroupKey>("deals");
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") === "events") queueMicrotask(() => setTabState("events"));
  }, []);
  function setTab(next: ForYouGroupKey) {
    setTabState(next);
    track("filter_used", { filter: "for_you_tab", value: next, page: "for_you" });
    const params = new URLSearchParams(window.location.search);
    if (next === "events") params.set("tab", "events");
    else params.delete("tab");
    router.replace(`/for-you${params.toString() ? `?${params.toString()}` : ""}`, { scroll: false });
  }
  const groupCount = (key: ForYouGroupKey) => {
    const g = groups.find((x) => x.key === key);
    return g ? g.picks.length + g.more.length : 0;
  };
  const tabOptions: SegmentOption<ForYouGroupKey>[] = [
    { value: "deals", label: "Deals & offers", icon: "sell", ...(mounted && !feedPending ? { count: groupCount("deals") } : {}) },
    { value: "events", label: "Events", icon: "event", ...(mounted && !feedPending ? { count: groupCount("events") } : {}) },
  ];
  const group = groups.find((g) => g.key === tab) ?? null;

  const moreLoading = !mounted || feedPending;

  const hasPicks = picks.length > 0;
  const nothingAtAll = mounted && !feedPending && !hasPicks && more.length === 0;

  function trackRecOpened(entry: ForYouEntry) {
    const { kind, id } = entrySubject(entry.card);
    track("for_you_rec_opened", { kind, id, reason: entry.reason, personalised });
  }

  return (
    <ForYouFrame>
      {nothingAtAll ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong p-8 text-center">
          <FomoSpot mood="meh" pose="shrug" className="h-20 w-20" />
          <p className="text-headline-sm font-bold text-on-surface">Nothing here yet</p>
          <p className="text-body-md text-on-surface-variant">Sign up below to get the picks by email.</p>
        </div>
      ) : null}

      <StickyFilterBar className="-mx-4 px-4 lg:-mx-8 lg:px-8">
        <SegmentedControl value={tab} options={tabOptions} onChange={setTab} className="flex w-full lg:max-w-md" />
      </StickyFilterBar>

      {mounted && !personalised ? <ForYouPrompt /> : null}

      {/* One group at a time, Deals & offers or Events (lib/personalise/for-you.ts
          `groupOf`): its hand-picked Finds, then its recommendations. */}
      {group ? (
        <section aria-label={group.title} className="flex flex-col gap-3">
          {group.picks.length > 0 ? (
            <>
              <h2 className="px-1 text-label-lg font-bold uppercase tracking-wide text-on-surface-variant">Picked for you</h2>
              <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4 xl:grid-cols-3">
                {group.picks.map((entry) =>
                  entry.find ? (
                    <FindCard key={entry.key} item={entry.find} reason={entry.reason} position={pickPosition.get(entry.key) ?? 0} />
                  ) : null
                )}
              </div>
            </>
          ) : null}

          {group.more.length > 0 ? (
            <>
              <h2 className="px-1 pt-1 text-label-lg font-bold uppercase tracking-wide text-on-surface-variant">{moreTitle}</h2>
              <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4 xl:grid-cols-3">
                {group.more.map((entry) => (
                  // Grid rows stretch, and the card (last child) grows to fill, so
                  // every card in a row ends at the same line. A missing reason
                  // still takes its line on desktop, keeping the cards' tops level.
                  <div key={entry.key} className="flex flex-col gap-1.5 [&>*:last-child]:flex-1">
                    {entry.reason ? (
                      <span className="inline-flex w-fit max-w-full items-center gap-1 px-1 text-label-sm font-bold text-primary">
                        <Icon name="auto_awesome" filled size={12} className="shrink-0" />
                        <span className="truncate">{entry.reason}</span>
                      </span>
                    ) : (
                      <span aria-hidden="true" className="hidden h-4 lg:block" />
                    )}
                    <FeedListCard
                      card={entry.card}
                      surface="for_you"
                      position={morePosition.get(entry.key) ?? 0}
                      onOpen={() => trackRecOpened(entry)}
                    />
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </section>
      ) : mounted && !feedPending && !nothingAtAll ? (
        <p className="px-1 py-6 text-center text-body-md text-on-surface-variant">
          {tab === "deals" ? "No deals for you this week yet." : "No events for you this week yet."}{" "}
          <button type="button" onClick={() => setTab(tab === "deals" ? "events" : "deals")} className="font-semibold text-primary underline">
            See {tab === "deals" ? "events" : "deals & offers"}
          </button>
        </p>
      ) : null}

      {moreLoading ? (
        <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4 xl:grid-cols-3" role="status" aria-live="polite">
          <span className="sr-only">Loading recommendations…</span>
          {[0, 1, 2].map((i) => (
            <div key={i} className={`h-24 animate-pulse rounded-lg bg-surface-container ${i === 2 ? "hidden xl:block" : ""}`} />
          ))}
        </div>
      ) : null}

      <SubscribeCard source="finds" />
    </ForYouFrame>
  );
}
