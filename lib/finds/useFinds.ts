"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useSignedIn } from "@/lib/useSaved";
import { findKey, type FindItem, type FindsResponse, type FindSubjectType } from "./types";

/**
 * Client-side store of this week's live "For you" picks (the in-app name for
 * the Finds; the @askfomo Instagram series is still called "Fomo Finds"), so
 * any card or detail page can ask "is this one of them?" and show the
 * "Picked for you" badge without every caller fetching.
 *
 * Account-only, like the list itself: the store fetches only once the visitor
 * is known to be signed in (`useSignedIn() === true`) and holds an empty set
 * otherwise, so a "Picked for you" badge can never reveal which items are on
 * the list to a signed-out visitor. (GET /api/finds would only hand a signed-out
 * caller the 2-pick teaser anyway; the badge store doesn't ask.) It fetches as
 * soon as the visitor signs in, and drops back to empty on sign-out.
 *
 * Same shape as lib/useSaved.ts and AppHeader's `fetchWeatherOnce`:
 *  - module-level state read through `useSyncExternalStore`, shared by every
 *    mount, so a feed of 40 cards costs one `GET /api/finds` per page load;
 *  - the in-flight promise is cached, and reset on failure (or a non-2xx) so a
 *    later mount gets a fresh try instead of replaying a rejected promise;
 *  - the server snapshot is always empty, so server HTML and the first client
 *    render agree (no hydration mismatch); badges appear a beat after mount.
 *
 * A failed or empty fetch just means no badges. Nothing here ever throws.
 */
interface FindsState {
  /** "type:id" -> the pick, empty until the one fetch resolves. */
  byKey: ReadonlyMap<string, FindItem>;
}

const EMPTY: FindsState = { byKey: new Map() };
let state: FindsState = EMPTY;
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
let loaded = false;
/** Bumped on sign-out so a fetch still in flight for the old session can't fill the store afterwards. */
let generation = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;
const getServerSnapshot = () => EMPTY;

function itemKey(item: FindItem): string {
  return item.kind === "happening" ? findKey("happening", item.happening.id) : findKey("event", item.event.id);
}

function fetchOnce(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!inFlight) {
    const startedIn = generation;
    inFlight = fetch("/api/finds")
      .then((res) => {
        if (!res.ok) throw new Error(`GET /api/finds ${res.status}`);
        return res.json() as Promise<FindsResponse>;
      })
      .then((json) => {
        if (startedIn !== generation) return;
        loaded = true;
        state = { byKey: new Map((json.items ?? []).map((item) => [itemKey(item), item])) };
        for (const listener of listeners) listener();
      })
      .catch((err) => {
        console.error("[finds] fetch failed", err);
        // Let a later mount try again rather than staying stuck on this failure.
        inFlight = null;
      });
  }
  return inFlight;
}

/** Signed out (or signed out again): forget the list so no badge outlives the session. */
function clearStore(): void {
  generation += 1;
  inFlight = null;
  loaded = false;
  if (state !== EMPTY) {
    state = EMPTY;
    for (const listener of listeners) listener();
  }
}

function useEnsureLoaded(): void {
  const signedIn = useSignedIn();
  useEffect(() => {
    if (signedIn === true) void fetchOnce();
    else if (signedIn === false) clearStore();
  }, [signedIn]);
}

/** The live pick for this happening or event, or null (also null until the one shared fetch lands). */
export function useFind(type: FindSubjectType, id: string | null | undefined): FindItem | null {
  useEnsureLoaded();
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return id ? (snapshot.byKey.get(findKey(type, id)) ?? null) : null;
}

/** Every live pick's "type:id" key. */
export function useFindKeys(): ReadonlySet<string> {
  useEnsureLoaded();
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return new Set(snapshot.byKey.keys());
}
