"use client";

import { useEffect, useRef } from "react";
import { Button, Icon } from "@/components/ui";
import { track } from "@/lib/analytics/track";
import { sendToSignIn } from "@/lib/auth/send-to-signin";

export interface ForYouLockedProps {
  /** How many live picks there are this week (FindsResponse.total). */
  total: number;
  /** How many of them the visitor can already see above this card (the teaser). */
  shown: number;
  className?: string;
}

/**
 * The sign-in card at the foot of the For you teaser, shown to signed-out
 * visitors in place of the rest of the page (FindsClient). The tab is
 * account-only: the full hand-picked list and the "matched to your taste"
 * recommendations are for signed-in visitors, and only the first couple of
 * picks are public.
 *
 * It says what's behind the wall: "N more picks this week" when there are
 * picks beyond the teaser, otherwise just the matched-to-you half (the list is
 * short enough that the teaser may already be all of it). One primary button
 * sends them to /signin and back to this tab (`sendToSignIn` keeps the
 * `?tab=` query). `signin_prompt_shown` fires once when the card mounts, so
 * the prompt's pull can be read as shown -> clicked (`signin_prompt_clicked`
 * is tracked by `sendToSignIn`).
 *
 * The email digest (SubscribeCard) sits right under it as the no-account way
 * to get the picks.
 */
export function ForYouLocked({ total, shown, className = "" }: ForYouLockedProps) {
  const tracked = useRef(false);
  useEffect(() => {
    if (tracked.current) return;
    tracked.current = true;
    track("signin_prompt_shown", { reason: "for_you" });
  }, []);

  const more = Math.max(0, total - shown);
  const title = more > 0 ? `${more} more ${more === 1 ? "pick" : "picks"} this week` : "More matched to you";
  const body =
    more > 0
      ? "Sign in to see them all, plus things matched to your taste."
      : "Sign in and we’ll line up things matched to your taste.";

  return (
    <div className={`flex flex-col gap-3 rounded-2xl border border-hairline bg-surface-container-low p-4 ${className}`}>
      <div className="flex items-start gap-3">
        <Icon name="lock" size={22} className="mt-0.5 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-headline-sm font-bold text-on-surface">{title}</p>
          <p className="text-body-md text-on-surface-variant">{body}</p>
        </div>
      </div>
      <Button variant="orange" fullWidth className="lg:w-auto lg:self-start" onClick={() => sendToSignIn("for_you")}>
        Sign in
      </Button>
    </div>
  );
}

export default ForYouLocked;
