"use client";

import Link from "next/link";
import { Icon } from "@/components/ui";
import type { Quota } from "@/lib/fomo-chat/useFomoChat";

export interface ChatComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  /** Send `text` (the textarea's Enter/Send button pass the current input, suggestion chips pass their label). */
  onSend: (text: string) => void;
  sending: boolean;
  /** Out of free questions: the textarea is replaced by a sign-in call to action. */
  exhausted: boolean;
  /** null until the session check finishes; the quota line only shows for signed-out visitors. */
  signedIn: boolean | null;
  quota: Quota | null;
  suggestions: string[];
  /**
   * "fixed" (default): pinned above the bottom nav, as on the mobile page.
   * "inline": same content in normal flow, for the desktop side panel.
   */
  layout?: "fixed" | "inline";
}

/** Composer: suggested prompts + input bar. */
export function ChatComposer({
  input,
  onInputChange,
  onSend,
  sending,
  exhausted,
  signedIn,
  quota,
  suggestions,
  layout = "fixed",
}: ChatComposerProps) {
  // Fixed: above the bottom nav (and its safe-area inset).
  const containerClass =
    layout === "fixed"
      ? "fixed bottom-[calc(64px+env(safe-area-inset-bottom))] left-1/2 z-40 w-full max-w-[480px] -translate-x-1/2 bg-gradient-to-t from-background via-background to-transparent px-4 pb-3 pt-6"
      : "relative w-full bg-background px-4 pb-3 pt-3";

  return (
    <div className={containerClass}>
      {suggestions.length > 0 && !exhausted ? (
        <div className="no-scrollbar mb-2 flex gap-2 overflow-x-auto">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSend(s)}
              disabled={sending || exhausted}
              className="whitespace-nowrap rounded-full border border-outline-variant/60 bg-surface px-4 py-2 text-label-sm font-semibold text-on-surface-variant transition-colors hover:bg-surface-container disabled:opacity-40"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}

      {signedIn === false && quota && !exhausted ? (
        <p className="mb-2 px-1 text-center text-label-md text-on-surface-variant">
          {quota.remaining >= 2 ? `${quota.remaining} free questions left today` : "Last free question today"}
          {" · "}
          <Link href="/signin?next=/fomo&reason=fomo" className="font-semibold text-primary underline">
            Sign in for more
          </Link>
        </p>
      ) : null}

      {/* Out of free questions: a real way forward instead of a greyed-out box. */}
      {exhausted ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-outline-variant/60 bg-surface p-3 text-center shadow-[0_2px_12px_rgba(3,22,50,0.06)]">
          <p className="text-label-md text-on-surface-variant">
            That&apos;s your free questions for today. They reset tomorrow.
          </p>
          <Link
            href="/signin?next=/fomo&reason=fomo"
            className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-primary text-label-lg font-semibold text-on-primary transition-opacity hover:opacity-90"
          >
            Sign in to keep asking
          </Link>
        </div>
      ) : (
        <div className="flex items-end gap-2 rounded-2xl border border-outline-variant/60 bg-surface p-2 shadow-[0_2px_12px_rgba(3,22,50,0.06)] focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
          <textarea
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend(input);
              }
            }}
            rows={1}
            aria-label="Message Fomo"
            disabled={exhausted}
            placeholder={exhausted ? "Sign in to keep asking" : "Ask about deals, free things, what's on…"}
            className="max-h-[120px] min-h-[44px] flex-1 resize-none border-none bg-transparent p-2 text-body-md text-on-surface outline-none placeholder:text-outline focus:ring-0"
          />
          <button
            type="button"
            aria-label="Send"
            onClick={() => onSend(input)}
            disabled={sending || exhausted || !input.trim()}
            className="shrink-0 rounded-xl bg-secondary-container p-3 text-on-secondary-container shadow-sm transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <Icon name="arrow_upward" filled />
          </button>
        </div>
      )}
    </div>
  );
}
