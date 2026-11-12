"use client";

import { useEffect } from "react";
import { Icon } from "@/components/ui";
import { dismissSavePrompt, useSaved } from "@/lib/useSaved";
import { sendToSignIn } from "@/lib/auth/send-to-signin";

/** How long the prompt stays up if nobody touches it. */
const AUTO_HIDE_MS = 15_000;

/**
 * The small, non-blocking nudge shown on a visitor's third save without an
 * account (lib/saved/local-store.ts decides when; it then stays quiet for 30
 * days). Mounted once in the shell. It floats above the bottom nav, never
 * covers the page behind it, can be dismissed, and goes away by itself.
 */
export function SavePrompt() {
  const { promptOpen } = useSaved();

  useEffect(() => {
    if (!promptOpen) return;
    const timer = window.setTimeout(dismissSavePrompt, AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [promptOpen]);

  if (!promptOpen) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-[calc(96px+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-[440px] items-center gap-2 rounded-2xl bg-inverse-surface py-2 pl-4 pr-1 text-inverse-on-surface shadow-level-3 lg:inset-x-auto lg:bottom-6 lg:right-6 lg:mx-0"
    >
      <p className="min-w-0 flex-1 text-label-md font-medium leading-snug">
        Sign in to keep your saves across devices and get alerts.
      </p>
      <button
        type="button"
        onClick={() => {
          dismissSavePrompt();
          sendToSignIn("keep_saves");
        }}
        className="flex h-11 shrink-0 items-center rounded-full bg-primary px-4 text-label-md font-bold text-on-primary"
      >
        Sign in
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismissSavePrompt}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-inverse-on-surface/80 hover:bg-white/10"
      >
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}

export default SavePrompt;
