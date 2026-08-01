"use client";

import { useEffect, useMemo, useState } from "react";
import { useDeviceId } from "@/lib/device";
import { getCurrentTrip } from "@/lib/db";
import type { Trip } from "@/lib/types";
import type { Candidate } from "@/lib/now/types";
import { useInfiniteList } from "@/lib/useInfiniteList";
import { Icon, PageHeader, SectionHeader } from "@/components/ui";
import { RoameoCard } from "@/components/roameo/Card";

// One /api/saved page's worth of rows — matches /api/discover's own default
// page size (app/api/discover/route.ts) so a "load more" scroll fetches the
// same shape of chunk other paginated surfaces do.
const PAGE_SIZE = 24;

interface SavedApiResponse {
  items: Candidate[];
}

const GROUP_LABELS: { type: Candidate["subject"]["type"]; label: string }[] = [
  { type: "place", label: "Places" },
  { type: "event", label: "Events" },
  { type: "experience", label: "Experiences" },
];

/**
 * The shortlist (v1.1 W5) — recall for anything saved via the bookmark on a
 * card anywhere in the app (Home rails, Plan gaps, chip discover grids,
 * Reels; the map pin sheet and reel viewer save straight to this same
 * saved_items table). Reads through GET /api/saved, which resolves each
 * saved_items row into the same Candidate shape the Home `saved` rail's
 * savedPick generator builds, then groups by subject type for display —
 * pagination itself stays flat (lib/useInfiniteList.ts over the underlying
 * saved_items page), with grouping applied client-side to whatever has
 * loaded so far.
 */
export default function SavedPage() {
  const deviceId = useDeviceId();
  const [trip, setTrip] = useState<Trip | null>(null);

  // Best-effort — only used to give RoameoCard's bookmark/"Add to today"
  // signals a trip_id when one exists. Saved items themselves are NOT
  // trip-scoped (lib/db/saved.ts's listSavedItemsPage), so this page never
  // gates on having an active trip the way /experiences and /events do.
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const t = await getCurrentTrip(deviceId);
        if (!cancelled) setTrip(t);
      } catch (err) {
        console.error("[saved] trip load failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  const {
    items: candidates,
    loading,
    loadingMore,
    hasMore,
    sentinelRef,
  } = useInfiniteList<Candidate>(
    {
      enabled: !!deviceId,
      pageSize: PAGE_SIZE,
      getId: (c) => `${c.subject.type}:${c.subject.id}`,
      onError: (err, phase) =>
        console.error(`[saved] ${phase === "initial" ? "load" : "load more"} failed`, err),
      fetchPage: async ({ limit, offset }) => {
        if (!deviceId) return [];
        const params = new URLSearchParams({ deviceId, limit: String(limit), offset: String(offset) });
        const res = await fetch(`/api/saved?${params.toString()}`);
        const data = (await res.json()) as SavedApiResponse;
        return data.items ?? [];
      },
    },
    [deviceId]
  );

  const groups = useMemo(() => {
    return GROUP_LABELS.map(({ type, label }) => ({
      type,
      label,
      items: candidates.filter((c) => c.subject.type === type),
    })).filter((g) => g.items.length > 0);
  }, [candidates]);

  return (
    <div className="flex flex-col gap-4 pb-6">
      <PageHeader title="Saved" showBack />

      <div className="flex-1 px-5">
        {loading ? (
          <div className="flex justify-center py-16">
            <Icon name="hourglass_top" size={28} className="animate-pulse text-primary" />
          </div>
        ) : candidates.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary-fixed text-primary">
              <Icon name="bookmark" size={40} filled />
            </div>
            <div className="flex flex-col gap-1">
              <h2 className="text-headline-md text-primary">Nothing saved yet</h2>
              <p className="text-body-lg text-on-surface-variant">
                Tap the bookmark on any place, event, or experience to save it here.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section key={group.type}>
                <SectionHeader title={group.label} />
                <div className="grid grid-cols-2 gap-3">
                  {group.items.map((item) => (
                    <RoameoCard
                      key={`${item.subject.type}:${item.subject.id}`}
                      candidate={item}
                      variant="grid"
                      deviceId={deviceId}
                      tripId={trip?.id ?? null}
                    />
                  ))}
                </div>
              </section>
            ))}
            {hasMore ? (
              <div ref={sentinelRef} className="flex justify-center py-4">
                {loadingMore ? (
                  <Icon name="hourglass_top" size={22} className="animate-pulse text-primary" />
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
