"use client";

import { useState, type MouseEvent } from "react";
import { Icon } from "@/components/ui";

export interface NotifyMeButtonProps {
  /** Whether this viewer has already asked to be notified — purely local state today (see this file's own doc comment); a future wiring would lift this from a real subscription record. */
  subscribed: boolean;
  /** Called on tap when not yet subscribed. The caller owns what "notify" actually means once a delivery mechanism exists — this component only reports the intent. */
  onNotify: () => void;
}

/**
 * "Notify me when tickets open" affordance for a Book Early card whose
 * booking hasn't opened yet.
 *
 * Purely presentational — `onNotify`/`subscribed` are owned by the caller
 * (BookEarlyCard, components/happenings/BookEarlyCard.tsx), which runs the
 * real web-push subscribe flow (lib/push/client.ts) and POSTs
 * /api/alerts on tap. This component only reports intent and renders the
 * resulting state; it has no knowledge of push, permissions, or the network.
 *
 * Gated at the call site by `NOTIFY_ME_ENABLED`
 * (lib/happenings/book-early.ts, true once NEXT_PUBLIC_VAPID_PUBLIC_KEY is
 * set) — hidden entirely while unset, not just disabled, since a
 * visible-but-inert button implies a feature that doesn't exist yet.
 */
export function NotifyMeButton({ subscribed, onNotify }: NotifyMeButtonProps) {
  const [pending, setPending] = useState(false);

  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    if (pending || subscribed) return;
    setPending(true);
    try {
      onNotify();
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending || subscribed}
      aria-pressed={subscribed}
      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline-strong px-3 py-2 text-label-sm font-bold text-secondary transition-colors hover:bg-surface-container disabled:opacity-70"
    >
      <Icon name={subscribed ? "notifications_active" : "notifications"} size={16} filled={subscribed} />
      {subscribed ? "We'll notify you" : "Notify me"}
    </button>
  );
}

export default NotifyMeButton;
