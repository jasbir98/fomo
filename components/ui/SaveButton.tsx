"use client";

import { Icon } from "./Icon";
import { useSaved } from "@/lib/useSaved";
import { usePrefs } from "@/lib/personalise/usePrefs";
import { maybeOpenOnFirstSave } from "@/lib/personalise/trigger";
import { recordAffinity } from "@/lib/personalise/affinity";
import type { InterestKey } from "@/lib/personalise/interests";
import type { CardSubjectType } from "@/lib/types";
import { track } from "@/lib/analytics/track";

export type SaveButtonProps = {
  subjectType: CardSubjectType;
  subjectId: string;
  className?: string;
  /** This card's personalisation interest (lib/personalise/interests.ts), when the caller has it handy — feeds the implicit-learning affinity counter (lib/personalise/affinity.ts) on a genuine save. Omit where the interest isn't readily available; nothing else here depends on it. */
  interestHint?: InterestKey | null;
  /** 40px hit area instead of 44px — for a card footer row that shares its line with text. */
  compact?: boolean;
};

/**
 * The one bookmark toggle — feed cards, detail pages and the Explore sheet.
 * State comes from lib/useSaved.ts, so it starts saved when it is saved, and
 * a signed-out tap saves on this device (lib/saved/local-store.ts) and
 * merges into the account at sign-in. Stops propagation so it works
 * inside a whole-card NavCard. 44px tap target.
 *
 * Also the trigger point for "Make Fomo yours" (task brief §2: open once,
 * the first time a signed-in visitor saves something with the card not yet
 * done) and for implicit interest learning (§3: a successful save nudges
 * `interestHint`'s affinity counter) — both fire only on a genuine
 * unsaved→saved transition by a signed-in visitor, never on unsave or a
 * save held only on this device.
 */
export function SaveButton({ subjectType, subjectId, className = "", interestHint = null, compact = false }: SaveButtonProps) {
  const { isSaved, toggle } = useSaved();
  const prefs = usePrefs();
  const saved = isSaved(subjectType, subjectId);

  return (
    <button
      type="button"
      aria-pressed={saved}
      aria-label={saved ? "Remove from saved" : "Save"}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        const wasSaved = saved;
        // Only counted once the toggle actually lands (a failed write, or a
        // blocked-storage redirect to sign-in, never registers as a save).
        // `storage` tells a save on this device (signed out) from an account one.
        void toggle(subjectType, subjectId).then(({ changed, storage }) => {
          if (!changed) return;
          track(wasSaved ? "save_removed" : "save_added", { kind: subjectType, id: subjectId, storage });
          // The rest is account-only: "Make Fomo yours" and interest learning need a sign-in.
          if (wasSaved || storage !== "account") return;
          maybeOpenOnFirstSave(prefs.done);
          recordAffinity(interestHint);
        });
      }}
      className={`flex ${compact ? "h-10 w-10" : "h-11 w-11"} shrink-0 items-center justify-center rounded-full transition-colors hover:bg-surface-container ${
        saved ? "text-primary" : "text-on-surface-variant"
      } ${className}`}
    >
      <Icon name={saved ? "bookmark" : "bookmark_border"} filled={saved} size={22} />
    </button>
  );
}
