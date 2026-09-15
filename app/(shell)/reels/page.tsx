"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import {
  listPlaces,
  listReelsByLocation,
  type ReelLocationScope,
  type SocialPostWithPlace,
} from "@/lib/db";
import type { Place, SocialPost } from "@/lib/types";
import { sortByDistance, useGeolocation, type Coordinates } from "@/lib/geo";
import { Icon, SegmentedControl } from "@/components/ui";
import { AppHeader } from "@/components/shell/AppHeader";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { ReelViewer } from "@/components/social/ReelViewer";

const SCOPE_VALUES: ReelLocationScope[] = ["edinburgh", "near_edinburgh", "all_scotland"];
function isReelLocationScope(v: unknown): v is ReelLocationScope {
  return typeof v === "string" && (SCOPE_VALUES as string[]).includes(v);
}

/**
 * Last scope the user explicitly picked (task 13's "remember the last
 * scope too") — a plain single value, separate from the position store
 * below since it's one fact, not per-scope. Restoring it is treated exactly
 * like a fresh explicit pick (`userSelected = true`): the auto-fallback
 * cascade only exists to guess a starting scope for a visitor with no
 * signal at all, and a remembered pick is a stronger signal than that guess.
 */
const SCOPE_STORAGE_KEY = "fomo:reels:scope:v1";

function loadStoredScope(): ReelLocationScope | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SCOPE_STORAGE_KEY);
    return isReelLocationScope(raw) ? raw : null;
  } catch {
    return null;
  }
}

function saveStoredScope(scope: ReelLocationScope): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  } catch {
    // localStorage unavailable — scope memory just won't persist.
  }
}

/**
 * Resume position (task 13): which reel the user was on, per scope, so a
 * reload continues instead of restarting at 0. One object keyed by scope
 * (not one key per scope) so a single read/write covers a scope switch.
 * Entries older than 14 days are treated as stale and ignored — see
 * loadPositionReelId.
 */
type ReelPositionEntry = { reelId: string; updatedAt: number };
type ReelPositionStore = Partial<Record<ReelLocationScope, ReelPositionEntry>>;

const POSITION_STORAGE_KEY = "fomo:reels:position:v1";
const POSITION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function loadPositionStore(): ReelPositionStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(POSITION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as ReelPositionStore) : {};
  } catch {
    return {};
  }
}

/** The stored reel id for `scope`, or null if there isn't one or it's stale. */
function loadPositionReelId(scope: ReelLocationScope): string | null {
  const entry = loadPositionStore()[scope];
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > POSITION_MAX_AGE_MS) return null;
  return entry.reelId;
}

function savePosition(scope: ReelLocationScope, reelId: string): void {
  if (typeof window === "undefined") return;
  try {
    const store = loadPositionStore();
    store[scope] = { reelId, updatedAt: Date.now() };
    window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage unavailable — resume position just won't persist.
  }
}

/** Index of the stored resume reel within `reels`, or 0 if there isn't one / it's no longer present. */
function resolveStartIndex(reels: SocialPost[], scope: ReelLocationScope): number {
  const reelId = loadPositionReelId(scope);
  if (!reelId) return 0;
  const idx = reels.findIndex((r) => r.id === reelId);
  return idx >= 0 ? idx : 0;
}

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
  // it — no fallback"). A remembered scope (loadStoredScope) counts as an
  // explicit pick too (task 13) — see the mount effect below. It's read
  // there, not here: seeding useState from localStorage would render a
  // different segment on the client than the server did (hydration mismatch).
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

  // Initial auto-fallback cascade. A remembered scope short-circuits it — a
  // real earlier choice, not a blank slate to guess a starting point for —
  // by flipping `userSelected`, which hands the fetch to the effect below.
  // Otherwise depends only on `db` so it runs once on mount and never again
  // (in particular, not when it sets `scope` itself below) — a second
  // effect (below) owns every subsequent, user-driven fetch. Sequential
  // rather than parallel: each wider tier is a superset of the last, so
  // most opens resolve after one query (whichever tier actually has data
  // today) instead of always paying for three.
  useEffect(() => {
    if (userSelected) return;
    let cancelled = false;

    (async () => {
      const remembered = loadStoredScope();
      if (remembered) {
        setScope(remembered);
        setUserSelected(true);
        return;
      }
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
    // userSelected only ever flips false -> true (never back), so adding it
    // here just lets a mid-flight cascade bail early if the user taps a
    // segment (or a remembered scope is read) before it resolves — it never
    // causes the cascade itself to restart.
  }, [db, userSelected]);

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

  // Order freeze (task 13): sorted once per `viewer` object — which only
  // changes identity when a fetch actually completes for a (new-or-same)
  // scope, never on a later geolocation reading alone — so the stack the
  // user is mid-swipe through can't reshuffle under them once mounted.
  // Deliberately excludes `coords` from the deps: a coords update after
  // `viewer` has settled must NOT retrigger this sort. Called unconditionally
  // (rules of hooks) even while `viewer` is still null during a fetch.
  const sortedReels = useMemo<SocialPostWithPlace[]>(() => {
    if (!viewer) return [];
    return sortByDistance(viewer.reels, coords, reelCoords);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer]);

  function handleScopeChange(next: ReelLocationScope) {
    setUserSelected(true);
    setScope(next);
    saveStoredScope(next);
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
        <AppHeader />
        {filterRow}
        <div className="flex flex-1 items-center justify-center">
          <Icon name="auto_awesome" size={32} className="animate-pulse text-primary" />
        </div>
      </div>
    );
  }

  if (!viewer || sortedReels.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <AppHeader />
        {filterRow}
        {note}
        <div className="flex flex-col items-center gap-3 px-5 py-16 text-center text-on-surface-variant">
          <FomoSpot mood="meh" pose="shrug" className="h-20 w-20" />
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
      <AppHeader />
      {filterRow}
      <div className="relative min-h-0 flex-1">
        {/* Absolutely positioned rather than in normal flow: this view's
            height is a fixed budget (see comment above) with no slack for
            an extra row, and the note is transient (only while the
            auto-fallback note is live and undismissed) so it overlays the
            top of the swipe stack instead of shifting it. */}
        {note ? <div className="absolute inset-x-0 top-0 z-10 pt-3">{note}</div> : null}
        {/* key={scope}: ReelViewer only reads startIndex once (its own
            `index` state), so a scope switch needs a fresh mount to pick up
            that scope's resume position rather than keeping whatever index
            it was last on. startIndex is resolved synchronously
            (localStorage is sync) before this ever renders, so there's no
            flash of reel 0 while it resolves. */}
        <ReelViewer
          key={scope}
          reels={sortedReels}
          startIndex={resolveStartIndex(sortedReels, scope)}
          places={viewer.places}
          onIndexChange={(reel) => savePosition(scope, reel.id)}
        />
      </div>
    </div>
  );
}
