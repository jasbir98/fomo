"use client";

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import type { Candidate } from "@/lib/cards/types";
import { useInfiniteList } from "@/lib/useInfiniteList";
import { invalidate } from "@/lib/http/clientCache";
import { Icon, Card, Button } from "@/components/ui";
import { FomoCard } from "@/components/fomo/Card";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { subscribeSavedChanges, useSignedIn } from "@/lib/useSaved";

const SAVED_PAGE_SIZE = 24;

const SAVED_CACHE_KEY = "saved:page0";

interface SavedApiResponse {
  items: Candidate[];
}

const SAVED_GROUP_LABELS: { type: Candidate["subject"]["type"]; label: string }[] = [
  { type: "happening", label: "Deals & things to do" },
  { type: "place", label: "Places" },
  { type: "event", label: "Events" },
];

function SignedOutSaved() {
  const router = useRouter();
  return (
    <Card>
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <FomoSpot mood="wow" pose="cheer" className="h-20 w-20" />
        <h2 className="text-title-sm font-extrabold text-on-surface">Keep track of what you want to do</h2>
        <p className="text-body-md text-on-surface-variant">
          Sign in to save deals, events and places. They&apos;ll wait here for you.
        </p>
        <Button fullWidth onClick={() => router.push("/signin?next=%2Fsaved")}>
          Sign in
        </Button>
      </div>
    </Card>
  );
}

function SavedListInner() {
  const db = supabaseBrowserAuth();
  const {
    items: savedCandidates,
    loading: savedLoading,
    loadingMore: savedLoadingMore,
    hasMore: savedHasMore,
    sentinelRef: savedSentinelRef,
  } = useInfiniteList<Candidate>(
    {
      pageSize: SAVED_PAGE_SIZE,
      getId: (c) => `${c.subject.type}:${c.subject.id}`,
      onError: (err, phase) =>
        console.error(`[SavedList] ${phase === "initial" ? "load" : "load more"} failed`, err),
      fetchPage: async ({ limit, offset }) => {
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        const res = await fetch(`/api/saved?${params.toString()}`);
        const data = (await res.json()) as SavedApiResponse;
        return data.items ?? [];
      },
      cacheKey: SAVED_CACHE_KEY,
    },
    [db]
  );

  useEffect(() => {
    return subscribeSavedChanges(() => invalidate(SAVED_CACHE_KEY));
  }, []);

  const savedGroups = useMemo(() => {
    return SAVED_GROUP_LABELS.map(({ type, label }) => ({
      type,
      label,
      items: savedCandidates.filter((c) => c.subject.type === type),
    })).filter((g) => g.items.length > 0);
  }, [savedCandidates]);

  return (
    <>
      {savedLoading ? (
        <div className="flex justify-center py-8">
          <Icon name="hourglass_top" size={24} className="animate-pulse text-primary" />
        </div>
      ) : savedCandidates.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <FomoSpot mood="meh" pose="shrug" className="h-20 w-20" />
            <p className="text-body-md text-on-surface-variant">
              Tap the bookmark on any deal, event or place to save it here.
            </p>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {savedGroups.map((group) => (
            <div key={group.type}>
              <p className="mb-2 text-label-md font-bold text-on-surface-variant">{group.label}</p>
              <div className="grid grid-cols-2 gap-3">
                {group.items.map((item) => (
                  <FomoCard
                    key={`${item.subject.type}:${item.subject.id}`}
                    candidate={item}
                    variant="grid"
                  />
                ))}
              </div>
            </div>
          ))}
          {savedHasMore ? (
            <div ref={savedSentinelRef} className="flex justify-center py-2">
              {savedLoadingMore ? (
                <Icon name="hourglass_top" size={20} className="animate-pulse text-primary" />
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

/**
 * Reusable Saved items list — extracted from the Saved section on Profile
 * (app/(shell)/profile/page.tsx). Loads paginated saved items from /api/saved,
 * groups them by subject type, and renders them in a grid with infinite-scroll
 * load-more. Signed-out visitors see a sign-in prompt instead of the list.
 * Used by both the full Saved page (app/(shell)/saved/page.tsx)
 * and (if needed) profile previews.
 */
export function SavedList() {
  const signedIn = useSignedIn();

  if (signedIn === null) {
    return (
      <div className="flex justify-center py-8">
        <Icon name="hourglass_top" size={24} className="animate-pulse text-primary" />
      </div>
    );
  }

  if (signedIn === false) {
    return <SignedOutSaved />;
  }

  return <SavedListInner />;
}

export default SavedList;
