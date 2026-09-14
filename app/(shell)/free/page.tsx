"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { FeedResponse, FreeAnyTimeItem } from "@/lib/happenings/feed-types";
import { distinctTypeBuckets, distinctDistricts, matchesFreeAnyTimeFilters } from "@/lib/happenings/free-any-time-filters";
import { Icon, PageHeader, StickyFilterBar } from "@/components/ui";
import { FreeAnyTimeFilters, FreeAnyTimeRow } from "@/components/happenings";

/** GET /api/feed's `freeAnyTime` is already the FULL list (Home only ever
 *  slices its first few) — reused here rather than a parallel /api/free
 *  route that would duplicate app/api/feed/route.ts's `buildFreeAnyTime`.
 *  Same principle as app/(shell)/deals/page.tsx's `fetchDeals` and
 *  app/(shell)/book-early/page.tsx's `fetchBookEarly`. */
async function fetchFreeAnyTime(): Promise<FreeAnyTimeItem[] | null> {
  try {
    const res = await fetch("/api/feed?window=now");
    const json = (await res.json()) as FeedResponse;
    return json.freeAnyTime;
  } catch (err) {
    console.error("[free] /api/feed fetch failed", err);
    return null;
  }
}

/** Ask Fomo deep-link — plain `?q=` prefill (see app/(shell)/fomo/page.tsx's
 *  own doc comment on that param), not the `seed` mechanism, which pins a
 *  specific subject card and needs a type/id/name this page-level button has
 *  none of. */
const ASK_FOMO_HREF = `/fomo?q=${encodeURIComponent("What free things can I do in Edinburgh today?")}`;

/**
 * Free Any Time — its own full page (moved out of Home's in-place "Show all
 * N" expander per the task brief, same pattern as /book-early). Same rows as
 * the Home section (components/happenings/FreeAnyTimeList.tsx's
 * `FreeAnyTimeRow`, reused as-is) — this page adds two client-side filters
 * (type / area, see lib/happenings/free-any-time-filters.ts) over the
 * identical full list.
 */
export default function FreeAnyTimePage() {
  const [items, setItems] = useState<FreeAnyTimeItem[] | null>(null);
  const [typeBucket, setTypeBucket] = useState<string | null>(null);
  const [district, setDistrict] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const json = await fetchFreeAnyTime();
      if (!cancelled) setItems(json);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const typeOptions = useMemo(() => (items ? distinctTypeBuckets(items) : []), [items]);
  const districtOptions = useMemo(() => (items ? distinctDistricts(items) : []), [items]);

  const filteredItems = useMemo(() => {
    if (!items) return [];
    return items.filter((i) => matchesFreeAnyTimeFilters(i, typeBucket, district));
  }, [items, typeBucket, district]);

  return (
    <div className="flex flex-col gap-5 pb-8">
      <PageHeader title="Free Any Time" showBack />

      <div className="flex flex-col gap-4 px-4">
        <p className="text-body-sm text-on-surface-variant">Edinburgh classics with £0 admission</p>

        <StickyFilterBar className="-mx-4 px-4">
          <div className="flex items-start justify-end gap-2">
            <FreeAnyTimeFilters
              typeLabel={typeBucket}
              district={district}
              typeOptions={typeOptions}
              districtOptions={districtOptions}
              onTypeChange={setTypeBucket}
              onDistrictChange={setDistrict}
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
        </StickyFilterBar>

        {items === null ? (
          <div className="flex flex-col gap-3 pt-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-container" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong p-8 text-center">
            <Icon name="all_inclusive" size={28} className="text-outline" />
            <p className="text-body-md text-on-surface-variant">Nothing free to show right now — check back soon.</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-hairline-strong py-6 text-center text-body-sm text-on-surface-variant">
            Nothing matches — clear filters
          </p>
        ) : (
          <div className="flex flex-col gap-2.5 pt-1">
            {filteredItems.map((item) => (
              <FreeAnyTimeRow key={`${item.kind}-${item.id}`} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
