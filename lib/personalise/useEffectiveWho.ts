"use client";

import { useMemo } from "react";
import { useSaved } from "@/lib/useSaved";
import type { DealWhoGroup } from "@/lib/happenings/groups";
import { usePrefs, whoFromPrefs } from "./usePrefs";

const NO_WHO: readonly DealWhoGroup[] = [];

/**
 * The visitor's eligibility set for "You qualify" badges and
 * `personalBoost`.
 *
 *  - Signed in: `useSaved().who` is authoritative (it's synced from the same
 *    prefs via `setWhoGroups`, see usePrefs.ts's `persistToAccount`).
 *  - Signed out: derived from the eligibility answers stored on this device
 *    (Home's inline audience ask, or the Make Fomo yours sheet), so the
 *    badges react the moment a chip is tapped. Those answers merge into the
 *    account on sign-in when it has none yet (usePrefs.ts's `load`).
 *  - Still checking the session (also the server snapshot): empty, so the
 *    server HTML and hydration stay neutral.
 *
 * Memoised on the fields it reads so callers can keep using the result as a
 * `useMemo` dependency without recomputing every render.
 *
 * Lives in lib/personalise/ (not lib/useSaved.ts) for the same import-cycle
 * reason as before: lib/personalise/usePrefs.ts already imports from
 * lib/useSaved.ts (to call `setWhoGroups`), so useSaved.ts itself must never
 * import back from lib/personalise/.
 */
export function useEffectiveWho(): readonly DealWhoGroup[] {
  const { who, signedIn } = useSaved();
  const prefs = usePrefs();
  const localOnly = signedIn !== true && prefs.signedIn === false;
  const { status, under26, residents, over60, kids } = prefs;
  const localWho = useMemo(
    () => (localOnly ? whoFromPrefs({ status, under26, residents, over60, kids }) : NO_WHO),
    [localOnly, status, under26, residents, over60, kids]
  );
  if (signedIn === true) return who;
  return localWho.length > 0 ? localWho : NO_WHO;
}

export default useEffectiveWho;
