"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import type { Candidate } from "@/lib/cards/types";
import { useInfiniteList } from "@/lib/useInfiniteList";
import { invalidate } from "@/lib/http/clientCache";
import { Icon, Card, Button } from "@/components/ui";
import { FomoCard } from "@/components/fomo/Card";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { subscribeSavedChanges, useSaved } from "@/lib/useSaved";
import { localKey, readLocalSaves } from "@/lib/saved/local-store";
import { signinHref } from "@/lib/auth/send-to-signin";

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
    <Card className="lg:mx-auto lg:w-full lg:max-w-lg">
      <div className="flex flex-col items-center gap-4 py-6 text-center lg:px-6 lg:py-10">
        <FomoSpot mood="wow" pose="cheer" className="h-20 w-20" />
        <h2 className="text-title-sm font-extrabold text-on-surface">Keep track of what you want to do</h2>
        <p className="text-body-md text-on-surface-variant">
          Tap the bookmark on a deal, event or place and it will wait here. Sign in to keep your saves across devices.
        </p>
        <Button fullWidth className="lg:w-auto lg:min-w-[200px] lg:px-8" onClick={() => router.push("/signin?next=%2Fsaved")}>
          Sign in
        </Button>
      </div>
    </Card>
  );
}

/**
 * Signed out, with saves kept on this device (lib/saved/local-store.ts): the
 * same grouped cards as the account list, fetched by id from the public
 * /api/saved/local. A card whose bookmark is untapped drops out straight away.
 */
function LocalSavedList() {
  const { isSaved } = useSaved();
  const [items, setItems] = useState<Candidate[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Only mounted once the session check has resolved, so reading storage here is safe.
    const refs = readLocalSaves().map((s) => localKey(s.type, s.id));
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/saved/local?refs=${encodeURIComponent(refs.slice(0, 60).join(","))}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as SavedApiResponse;
        if (!cancelled) setItems(data.items ?? []);
      } catch (err) {
        console.error("[SavedList] local load failed", err);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => {
    const live = (items ?? []).filter((c) => isSaved(c.subject.type, c.subject.id));
    return SAVED_GROUP_LABELS.map(({ type, label }) => ({
      type,
      label,
      items: live.filter((c) => c.subject.type === type),
    })).filter((g) => g.items.length > 0);
  }, [items, isSaved]);

  return (
    <div className="flex flex-col gap-4 lg:mx-auto lg:max-w-[1200px] lg:px-8">
      <Card>
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-body-sm text-on-surface-variant">
            These are saved on this device. Sign in to keep them across devices and get alerts.
          </p>
          <Link
            href={signinHref("keep_saves", "/saved")}
            className="flex h-11 shrink-0 items-center rounded-full bg-primary px-4 text-label-md font-bold text-on-primary"
          >
            Sign in
          </Link>
        </div>
      </Card>
      {failed ? (
        <Card>
          <p className="py-4 text-center text-body-md text-on-surface-variant">Couldn&apos;t load your saves. Try again in a moment.</p>
        </Card>
      ) : items === null ? (
        <div className="flex justify-center py-8">
          <Icon name="hourglass_top" size={24} className="animate-pulse text-primary" />
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <FomoSpot mood="meh" pose="shrug" className="h-20 w-20" />
            <p className="text-body-md text-on-surface-variant">Tap the bookmark on any deal, event or place to save it here.</p>
          </div>
        </Card>
      ) : (
        groups.map((group) => (
          <div key={group.type}>
            <p className="mb-2 text-label-md font-bold text-on-surface-variant">{group.label}</p>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4 lg:gap-5">
              {group.items.map((item) => (
                <FomoCard key={`${item.subject.type}:${item.subject.id}`} candidate={item} variant="grid" />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
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
        <div className="flex flex-col gap-4 lg:mx-auto lg:max-w-[1200px] lg:px-8">
          {savedGroups.map((group) => (
            <div key={group.type}>
              <p className="mb-2 text-label-md font-bold text-on-surface-variant">{group.label}</p>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4 lg:gap-5">
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
  const { signedIn, localSaveCount } = useSaved();

  if (signedIn === null) {
    return (
      <div className="flex justify-center py-8">
        <Icon name="hourglass_top" size={24} className="animate-pulse text-primary" />
      </div>
    );
  }

  if (signedIn === false) {
    return localSaveCount > 0 ? <LocalSavedList /> : <SignedOutSaved />;
  }

  return <SavedListInner />;
}

export default SavedList;
