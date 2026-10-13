"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useSignedIn } from "@/lib/useSaved";
import { parseAffinity, readAffinityRaw, subscribeAffinity, type AffinityMap } from "./affinity";

const NO_AFFINITY: AffinityMap = {};

/**
 * The affinity map for ranking: the visitor's counters when signed in, `{}`
 * while signed out or still checking, so a signed-out visitor sees neutral
 * ordering. Pass the result to `personalBoost`. A separate file from
 * affinity.ts so score.ts (and its node tests) don't pull in React or the
 * Supabase-backed `useSaved`.
 */
export function useAffinity(): AffinityMap {
  const signedIn = useSignedIn();
  const raw = useSyncExternalStore(subscribeAffinity, readAffinityRaw, () => null);
  return useMemo(() => (signedIn === true ? parseAffinity(raw) : NO_AFFINITY), [signedIn, raw]);
}
