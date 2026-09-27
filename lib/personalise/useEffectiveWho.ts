"use client";

import { useSaved } from "@/lib/useSaved";
import { usePrefs, whoFromPrefs } from "./usePrefs";
import type { DealWhoGroup } from "@/lib/happenings/groups";

/**
 * The visitor's actual eligibility set for "You qualify" badges and
 * `personalBoost`, signed-in OR signed-out.
 *
 * lib/useSaved.ts's own `who` only ever holds something for a signed-in
 * visitor (it's read from the Supabase session's `user_metadata`) — a
 * signed-out visitor who answered "Make Fomo yours" via the Home banner has
 * their eligibility sitting in `localStorage fomo:prefs`
 * (lib/personalise/usePrefs.ts) instead, and `useSaved().who` has no way to
 * see it. This hook is the one place that reconciles the two: signed-in,
 * `useSaved().who` is authoritative (it's already synced from the same
 * prefs via `setWhoGroups`, see usePrefs.ts's `persistToAccount`);
 * signed-out, it derives the same shape locally via `whoFromPrefs`.
 *
 * Lives in lib/personalise/ (not lib/useSaved.ts) specifically to avoid a
 * circular import — lib/personalise/usePrefs.ts already imports from
 * lib/useSaved.ts (to call `setWhoGroups`), so useSaved.ts itself must never
 * import back from lib/personalise/.
 */
export function useEffectiveWho(): readonly DealWhoGroup[] {
  const { who, signedIn } = useSaved();
  const prefs = usePrefs();
  if (signedIn === true) return who;
  return whoFromPrefs(prefs);
}

export default useEffectiveWho;
