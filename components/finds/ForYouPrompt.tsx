"use client";

import { Icon } from "@/components/ui";
import { openMakeFomoYours } from "@/lib/personalise/trigger";
import { track } from "@/lib/analytics/track";

/**
 * The "Make Fomo yours" prompt as it appears on the For you tab, between the
 * hand-picked list and the recommendations. It opens the same global sheet as
 * Home's banner and Profile's Edit (components/personalise/MakeFomoYours.tsx,
 * mounted once in AppShell), so there is still exactly one place prefs are
 * edited. Shown only while the visitor has no prefs or save history, so the
 * second list isn't pretending to know them (its title is then "Popular this
 * week"). Unlike Home's slim banner it has no dismiss button: on this tab it
 * is the call to action, not a nag, and it disappears by itself once they
 * answer.
 */
export function ForYouPrompt({ className = "" }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        track("for_you_prefs_opened");
        openMakeFomoYours();
      }}
      className={`flex min-h-[56px] w-full items-center gap-3 rounded-2xl border border-hairline bg-surface-container-low px-4 py-3 text-left transition-colors hover:bg-surface-container ${className}`}
    >
      <Icon name="tune" size={22} className="shrink-0 text-primary" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-label-lg font-bold text-primary">Make this yours</span>
        <span className="text-body-sm text-on-surface-variant">
          Tell us what you&rsquo;re into and what you can spend, and we&rsquo;ll pick for you.
        </span>
      </span>
      <Icon name="chevron_right" size={20} className="shrink-0 text-on-surface-variant" />
    </button>
  );
}

export default ForYouPrompt;
