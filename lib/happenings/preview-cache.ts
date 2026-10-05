"use client";

/**
 * Client-side preview cache for happening cards → detail page navigation.
 *
 * The card components (FeedListCard, HappeningHero, TodaysDealsStrip,
 * BookEarlyCard) already have almost everything the detail page's hero
 * needs — title, image, price/saving badge, a short date/time label, venue
 * — before the tap even happens. This lets them hand that forward instead
 * of the detail page starting from a blank screen and re-deriving it a
 * moment later from its own fetch (see app/(shell)/happening/[id]/page.tsx's
 * doc comment on the ~2s cold-load waterfall this exists to shortcut).
 *
 * Two independent caches, both module-level (so they survive the
 * card→detail navigation, unlike component state) with a sessionStorage
 * mirror wrapped in try/catch — sessionStorage can throw in Safari private
 * mode or when storage is full, and this is a pure performance nicety,
 * never something correctness should depend on:
 *
 *  - preview cache — the small hero fields a card already rendered,
 *    written at click time (NavCard's `onNavigate`) so the detail page can
 *    paint the hero instantly on mount.
 *  - fetch cache — the actual GET /api/happenings/[id] promise, started
 *    early at pointerdown/touchstart (NavCard's `onPointerDown` — pointer
 *    events fire for touch too, so no separate touchstart listener is
 *    needed) so the detail page's own fetch reuses it instead of firing a
 *    second, redundant request.
 *
 * Both are keyed by happening id and deliberately NOT persisted to
 * localStorage — a stale price/date label sitting around for days is a
 * worse bug than an empty cache; sessionStorage already clears itself per
 * tab/session, which is the right lifetime for "the user is mid-browse".
 */

import type { Happening, HappeningCategory, HappeningKind } from "@/lib/happenings/types";
import type { HappeningResponse } from "@/app/api/happenings/[id]/route";

export interface HappeningPreview {
  title: string;
  imageUrl: string | null;
  category: HappeningCategory | null;
  kind: HappeningKind;
  /** Short saving/price badge text, e.g. "50% off" — `savingBadgeLabel`'s output, not the full `saving_label` sentence. */
  priceLabel: string | null;
  /** Short date/time label, e.g. "Today · 7pm" — whatever the card itself already shows, best-effort. */
  whenLabel: string | null;
  venueName: string | null;
  district: string | null;
}

/** Builds a `HappeningPreview` from a real `Happening` row plus whatever
 *  short price/when labels the calling card already computed for its own
 *  display — every card names these differently (`badge`, `priceLabel`,
 *  `time`, `card.dateLabel`…), so this only takes the fields every
 *  `Happening` row always has and leaves the rest to the caller. */
export function happeningToPreview(
  happening: Pick<Happening, "title" | "image_url" | "category" | "kind" | "venue_name" | "district">,
  labels: { priceLabel?: string | null; whenLabel?: string | null } = {}
): HappeningPreview {
  return {
    title: happening.title,
    imageUrl: happening.image_url,
    category: happening.category,
    kind: happening.kind,
    priceLabel: labels.priceLabel ?? null,
    whenLabel: labels.whenLabel ?? null,
    venueName: happening.venue_name,
    district: happening.district,
  };
}

const SS_KEY_PREFIX = "fomo:happening-preview:";

const previewCache = new Map<string, HappeningPreview>();
const fetchCache = new Map<string, Promise<HappeningResponse>>();

/** Written by a card at click time (see NavCard's `onNavigate`). */
export function setHappeningPreview(id: string, preview: HappeningPreview): void {
  previewCache.set(id, preview);
  try {
    sessionStorage.setItem(SS_KEY_PREFIX + id, JSON.stringify(preview));
  } catch {
    // Storage unavailable/full — the in-memory cache still covers the
    // normal same-tab card→detail navigation this exists for.
  }
}

/** Read by the detail page on mount. Checks the in-memory cache first (the
 *  common case — same tab, just navigated), then sessionStorage (a full
 *  reload of the detail page itself, e.g. a shared link opened directly). */
export function getHappeningPreview(id: string): HappeningPreview | null {
  const mem = previewCache.get(id);
  if (mem) return mem;
  try {
    const raw = sessionStorage.getItem(SS_KEY_PREFIX + id);
    if (!raw) return null;
    // Memoised so repeat reads return the same object — the detail page
    // reads this through useSyncExternalStore, which needs a stable snapshot.
    const parsed = JSON.parse(raw) as HappeningPreview;
    previewCache.set(id, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** Kicks off GET /api/happenings/[id] early (NavCard's `onPointerDown`) and
 *  stashes the promise so the detail page's own fetch can reuse it instead
 *  of firing a second request. No-op if a fetch for this id is already in
 *  flight. */
export function prefetchHappening(id: string): void {
  if (fetchCache.has(id)) return;
  const promise = fetch(`/api/happenings/${id}`).then((res) => {
    if (!res.ok) throw new Error(`GET /api/happenings/${id} ${res.status}`);
    return res.json() as Promise<HappeningResponse>;
  });
  // A failed prefetch shouldn't wedge this id against ever fetching again —
  // drop it so the detail page's own fetchHappening starts fresh instead of
  // replaying the same rejected promise.
  promise.catch(() => fetchCache.delete(id));
  fetchCache.set(id, promise);
}

/** Consumed once by the detail page's own fetch — removes the entry so a
 *  later reload of the same page (id unchanged, but a fresh mount) fetches
 *  for real rather than replaying an old response forever. */
export function takePrefetchedHappening(id: string): Promise<HappeningResponse> | undefined {
  const promise = fetchCache.get(id);
  fetchCache.delete(id);
  return promise;
}
