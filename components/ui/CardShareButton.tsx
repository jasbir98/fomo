"use client";

import { ShareButton } from "./ShareButton";
import type { InterestKey } from "@/lib/personalise/interests";

export type CardShareButtonProps = {
  kind: "happening" | "event" | "place";
  id: string;
  title: string;
  /** The card's `surface` (FeedCardSurface, e.g. "home_top_picks"), sent on `share_completed`. */
  surface?: string;
  interestHint?: InterestKey | null;
  className?: string;
};

/**
 * The share control on a feed card, next to the bookmark. Shares the item's
 * canonical detail page (the same path the card opens), with the same UTM
 * convention as detail pages plus `utm_content=card`. Tapping it never opens
 * the card (ShareButton stops the click), and it has the same 44px target as
 * SaveButton. See components/ui/ShareButton.tsx.
 */
export function CardShareButton({ kind, id, title, surface, interestHint = null, className = "" }: CardShareButtonProps) {
  return (
    <ShareButton
      variant="card"
      utmContent="card"
      title={title}
      text={`${title} · found on Fomo`}
      url={`/${kind}/${id}`}
      kind={kind}
      surface={surface}
      interestHint={interestHint}
      className={className}
    />
  );
}

export default CardShareButton;
