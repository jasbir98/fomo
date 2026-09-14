"use client";

import { useEffect, useState } from "react";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import {
  listPlaces,
  listReelsByLocation,
  type ReelLocationScope,
  type SocialPostWithPlace,
} from "@/lib/db";
import type { Place } from "@/lib/types";
import { sortByDistance, useGeolocation, type Coordinates } from "@/lib/geo";
import { Icon, PageHeader, SegmentedControl } from "@/components/ui";
import { ReelViewer } from "@/components/social/ReelViewer";

type ViewerData = { reels: SocialPostWithPlace[]; places: Place[] };

const SCOPE_OPTIONS: { value: ReelLocationScope; label: string }[] = [
  { value: "edinburgh", label: "Edinburgh" },
  { value: "near_edinburgh", label: "Near Edinburgh" },
  { value: "all_scotland", label: "All Scotland" },
];

const SCOPE_EMPTY_COPY: Record<ReelLocationScope, string> = {
  edinburgh: "No Edinburgh reels yet — try Near Edinburgh or All Scotland.",
  near_edinburgh: "No reels near Edinburgh yet — try All Scotland.",
  all_scotland: "No reels yet.",
};

/**
 * Note shown above the feed when the initial (non-explicit) load had to
 * widen past Edinburgh to find anything — see the auto-fallback effect
 * below. Never shown once the user has tapped a segment themselves.
 */
const FALLBACK_NOTE: Partial<Record<ReelLocationScope, string>> = {
  near_edinburgh: "No Edinburgh reels yet — showing reels near Edinburgh.",
  all_scotland: "No Edinburgh reels yet — showing reels from across Scotland.",
};

/** Cascade order for the initial auto-fallback: widen until one has results. */
const FALLBACK_TIERS: ReelLocationScope[] = ["edinburgh", "near_edinburgh", "all_scotland"];

/** Reel coordinate extractor (via its linked place) for sortByDistance. */
function reelCoords(reel: SocialPostWithPlace): Coordinates | null {
  const place = reel.place;
  return place?.lat != null && place?.lng != null ? { lat: place.lat, lng: place.lng } : null;
}

export default function ReelsTabPage() {
  const db = supabaseBrowserAuth();
  const { coords } = useGeolocation();

  // Defaults to "edinburgh" (task: "Default: Edinburgh"), but Edinburgh has
  // ~0 reels live today, so a plain default would render an empty tab on
  // first open. `userSelected` tracks whether the segment shown is the
  // user's own explicit choice: while it's false, the mount effect below
  // owns `scope` and is allowed to widen it past Edinburgh to whichever
  // tier first has results; once the user taps a segment themselves, that
  // effect is inert and every scope change is a plain single fetch with no
  // further widening (task: "If the user explicitly taps a segment, respect
  // it — no fallback").
  const [scope, setScope] = useState<ReelLocationScope>("edinburgh");
  const [userSelected, setUserSelected] = useState(false);
  // `fallback` is true only when this result came from the mount effect
  // widening past Edinburgh (and found something) — the sole trigger for
  // the note banner. `result` stays tagged with the scope/fallback it was
  // fetched for, so `loading`/`viewer` below are derived rather than
  // tracked separately — a scope change mid-fetch can't flash stale data.
  const [result, setResult] = useState<{ scope: ReelLocationScope; viewer: ViewerData; fallback: boolean } | null>(
    null
  );
  const [noteDismissedForScope, setNoteDismissedForScope] = useState<ReelLocationScope | null>(null);

  // Initial auto-fallback cascade. Depends only on `db` so it runs once on
  // mount and never again (in particular, not when it sets `scope` itself
  // below) — a second effect (below) owns every subsequent, user-driven
  // fetch. Sequential rather than parallel: each wider tier is a superset
  // of the last, so most opens resolve after one query (whichever tier
  // actually has data today) instead of always paying for three.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      for (const tier of FALLBACK_TIERS) {
        let reels: SocialPostWithPlace[];
        let places: Place[];
        try {
          [reels, places] = await Promise.all([listReelsByLocation(db, tier), listPlaces(db)]);
        } catch (err) {
          console.error("Failed to load reels tab", err);
          if (!cancelled) {
            setScope(tier);
            setResult({ scope: tier, viewer: { reels: [], places: [] }, fallback: false });
          }
          return;
        }
        if (cancelled) return;
        const isLastTier = tier === FALLBACK_TIERS[FALLBACK_TIERS.length - 1];
        if (reels.length > 0 || isLastTier) {
          setScope(tier);
          setResult({ scope: tier, viewer: { reels, places }, fallback: tier !== "edinburgh" && reels.length > 0 });
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [db]);

  // Every scope change once the user has picked one themselves. No-op while
  // `userSelected` is false so it never races the mount cascade above.
  useEffect(() => {
    if (!userSelected) return;
    let cancelled = false;

    (async () => {
      try {
        const [reels, places] = await Promise.all([listReelsByLocation(db, scope), listPlaces(db)]);
        if (cancelled) return;
        setResult({ scope, viewer: { reels, places }, fallback: false });
      } catch (err) {
        console.error("Failed to load reels tab", err);
        if (!cancelled) setResult({ scope, viewer: { reels: [], places: [] }, fallback: false });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [db, scope, userSelected]);

  const loading = result === null || result.scope !== scope;
  const viewer = !loading ? result.viewer : null;
  const showNote = !loading && result.fallback && noteDismissedForScope !== result.scope;

  function handleScopeChange(next: ReelLocationScope) {
    setUserSelected(true);
    setScope(next);
  }

  const filterRow = (
    <div className="px-5 pb-3">
      <SegmentedControl value={scope} options={SCOPE_OPTIONS} onChange={handleScopeChange} />
    </div>
  );

  const note =
    showNote && result ? (
      <div className="mx-5 mb-3 flex items-center justify-between gap-3 rounded-lg bg-surface-container px-3 py-2 text-label-md text-on-surface-variant">
        <span>{FALLBACK_NOTE[result.scope]}</span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setNoteDismissedForScope(result.scope)}
          className="shrink-0 text-on-surface-variant/70 hover:text-on-surface"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
    ) : null;

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Reels" />
        {filterRow}
        <div className="flex flex-1 items-center justify-center">
          <Icon name="auto_awesome" size={32} className="animate-pulse text-primary" />
        </div>
      </div>
    );
  }

  const sortedReels = viewer ? sortByDistance(viewer.reels, coords, reelCoords) : [];

  if (!viewer || sortedReels.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Reels" />
        {filterRow}
        {note}
        <div className="flex flex-col items-center gap-3 px-5 py-16 text-center text-on-surface-variant">
          <Icon name="videocam_off" size={32} />
          <p className="text-body-md">{SCOPE_EMPTY_COPY[scope]}</p>
        </div>
      </div>
    );
  }

  return (
    // Mirrors AppShell's reserved bottom padding (see its comment) so this
    // fills exactly the remaining viewport with no extra scroll — full-bleed
    // for the swipe stack, clearing the fixed BottomNav on every device. The
    // filter row's own height comes out of the swipe stack's share (no
    // scroll either way) since it's a fixed 88px + env(...) budget already.
    <div className="flex h-[calc(100dvh-88px-env(safe-area-inset-bottom))] flex-col">
      <PageHeader title="Reels" />
      {filterRow}
      <div className="relative min-h-0 flex-1">
        {/* Absolutely positioned rather than in normal flow: this view's
            height is a fixed budget (see comment above) with no slack for
            an extra row, and the note is transient (only while the
            auto-fallback note is live and undismissed) so it overlays the
            top of the swipe stack instead of shifting it. */}
        {note ? <div className="absolute inset-x-0 top-0 z-10 pt-3">{note}</div> : null}
        <ReelViewer reels={sortedReels} startIndex={0} places={viewer.places} />
      </div>
    </div>
  );
}
