"use client";

import { useSaved } from "@/lib/useSaved";
import type { DealWhoGroup } from "@/lib/happenings/groups";

const NO_WHO: readonly DealWhoGroup[] = [];

/**
 * The visitor's eligibility set for "You qualify" badges and
 * `personalBoost`. Personalisation needs an account, so this is empty for a
 * signed-out visitor (and while the session check is still running), even if
 * they answered "Make Fomo yours" locally: those answers only carry over
 * once they sign in (lib/personalise/usePrefs.ts merges them into
 * `user_metadata`). Signed-in, `useSaved().who` is authoritative (it's synced
 * from the same prefs via `setWhoGroups`, see usePrefs.ts's
 * `persistToAccount`).
 *
 * Lives in lib/personalise/ (not lib/useSaved.ts) for the same import-cycle
 * reason as before: lib/personalise/usePrefs.ts already imports from
 * lib/useSaved.ts (to call `setWhoGroups`), so useSaved.ts itself must never
 * import back from lib/personalise/.
 */
export function useEffectiveWho(): readonly DealWhoGroup[] {
  const { who, signedIn } = useSaved();
  return signedIn === true ? who : NO_WHO;
}

export default useEffectiveWho;
