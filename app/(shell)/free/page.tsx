"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { FeedResponse, FreeAnyTimeItem } from "@/lib/happenings/feed-types";
import { distinctTypeBuckets, distinctDistricts, matchesFreeAnyTimeFilters } from "@/lib/happenings/free-any-time-filters";
import { useCachedJson } from "@/lib/http/clientCache";
import { useProgressiveReveal } from "@/lib/useProgressiveReveal";
import { ErrorState, Icon, PageHeader, StickyFilterBar } from "@/components/ui";
import { FreeAnyTimeFilters, FreeAnyTimeRow } from "@/components/happenings";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { track } from "@/lib/analytics/track";

/** Matches Home's feed staleness (app/(shell)/page.tsx's `FEED_STALE_MS`) — duplicated as a plain number rather than imported across route boundaries. */
const FREE_ANY_TIME_STALE_MS = 60_000;

/** GET /api/feed's `freeAnyTime` is already the FULL list (Home only ever
 *  slices its first few) — reused here rather than a parallel /api/free
 *  route that would duplicate app/api/feed/route.ts's `buildFreeAnyTime`.
 *  Same principle as app/(shell)/deals/page.tsx's `fetchDeals` and
 *  app/(shell)/book-early/page.tsx's `fetchBookEarly`.
 *
 *  Throws (rather than swallowing to `null`) on a network error or non-2xx
 *  status — same "let the caller (now `useCachedJson`) tell failure from
 *  empty" contract as those two. */
async function fetchFreeAnyTime(signal?: AbortSignal): Promise<FreeAnyTimeItem[]> {
  const res = await fetch("/api/feed?window=now", { signal });
  if (!res.ok) throw new Error(`GET /api/feed ${res.status}`);
  const json = (await res.json()) as FeedResponse;
  return json.freeAnyTime;
}

/** Ask Fomo deep-link — plain `?q=` prefill (see app/(shell)/fomo/page.tsx's
 *  own doc comment on that param), not the `seed` mechanism, which pins a
 *  specific subject card and needs a type/id/name this page-level button has
 *  none of. */
const ASK_FOMO_HREF = `/fomo?q=${encodeURIComponent("What free things can I do in Edinburgh today?")}`;

/**
 * Free any time — its own full page (moved out of Home's in-place "Show all
 * N" expander per the task brief, same pattern as /book-early). Same rows as
 * the Home section (components/happenings/FreeAnyTimeList.tsx's
 * `FreeAnyTimeRow`, reused as-is) — this page adds two client-side filters
 * (type / area, see lib/happenings/free-any-time-filters.ts) over the
 * identical full list.
 */
export default function FreeAnyTimePage() {
  // Cached under a fixed key — a return visit paints instantly from
  // whatever's already there; `error` only means "nothing cached and the
  // last attempt failed" (see fetchFreeAnyTime's throw contract).
  const itemsResult = useCachedJson<FreeAnyTimeItem[]>("free-any-time", fetchFreeAnyTime, {
    staleMs: FREE_ANY_TIME_STALE_MS,
  });
  const items = itemsResult.data ?? null;
  const error = itemsResult.error != null && items === null;
  const [typeBucket, setTypeBucket] = useState<string | null>(null);
  const [district, setDistrict] = useState<string | null>(null);

  function handleTypeChange(value: string | null) {
    setTypeBucket(value);
    track("filter_used", { filter: "type", value, page: "free" });
  }

  function handleDistrictChange(value: string | null) {
    setDistrict(value);
    track("filter_used", { filter: "district", value, page: "free" });
  }

  const typeOptions = useMemo(() => (items ? distinctTypeBuckets(items) : []), [items]);
  const districtOptions = useMemo(() => (items ? distinctDistricts(items) : []), [items]);

  const filteredItems = useMemo(() => {
    if (!items) return [];
    return items.filter((i) => matchesFreeAnyTimeFilters(i, typeBucket, district));
  }, [items, typeBucket, district]);

  // Renders in chunks of 20 rather than mounting the whole (potentially
  // 100+ row) list at once — no pagination on this endpoint (see the
  // pagination audit in the caller's report), so this is where the actual
  // render cost gets capped instead.
  const revealSentinelRef = useRef<HTMLDivElement>(null);
  const visibleCount = useProgressiveReveal(filteredItems.length, null, revealSentinelRef, {
    vertical: true,
    step: 20,
  });

  return (
    <div className="flex flex-col pb-6">
      <PageHeader title="Free any time" showBack />

      <div className="flex flex-col gap-3 px-4 pt-1">
        <p className="text-body-md text-on-surface-variant">Edinburgh classics with £0 admission</p>

        <StickyFilterBar className="-mx-4 px-4">
          <div className="flex items-start justify-between gap-2">
            <span className="px-1 pt-1.5 text-label-lg font-semibold text-on-surface-variant">
              {items ? `${filteredItems.length} ${filteredItems.length === 1 ? "place" : "places"}` : ""}
            </span>
            <div className="flex items-start gap-2">
              <FreeAnyTimeFilters
                typeLabel={typeBucket}
                district={district}
                typeOptions={typeOptions}
                districtOptions={districtOptions}
                onTypeChange={handleTypeChange}
                onDistrictChange={handleDistrictChange}
                resultCount={filteredItems.length}
              />
              <Link
                href={ASK_FOMO_HREF}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-surface px-3.5 py-1.5 text-label-sm font-semibold text-primary shadow-sm transition-colors hover:bg-surface-container"
              >
                <Icon name="chat" size={16} />
                Ask Fomo
              </Link>
            </div>
          </div>
        </StickyFilterBar>

        {error ? (
          <ErrorState title="Couldn't load Free any time" onRetry={() => itemsResult.revalidate()} />
        ) : items === null ? (
          <div className="flex flex-col gap-3" role="status" aria-live="polite">
            <span className="sr-only">Loading Free any time…</span>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-container" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong p-8 text-center">
            <FomoSpot mood="meh" pose="shrug" className="h-20 w-20" />
            <p className="text-body-md text-on-surface-variant">Nothing free to show right now. Check back soon.</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong py-6 text-center">
            <FomoSpot mood="hmm" pose="shrug" className="h-16 w-16" />
            <p className="text-body-sm text-on-surface-variant">Nothing matches. Clear filters</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {filteredItems.slice(0, visibleCount).map((item) => (
              <FreeAnyTimeRow key={`${item.kind}-${item.id}`} item={item} />
            ))}
            {visibleCount < filteredItems.length ? <div ref={revealSentinelRef} className="h-1" /> : null}
          </div>
        )}
      </div>
    </div>
  );
}
