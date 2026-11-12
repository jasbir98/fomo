"use client";

import { useSyncExternalStore } from "react";
import { SubscribeCard } from "./SubscribeCard";

const subscribeNoop = () => () => {};

function readFromShare(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("utm_source") === "share";
  } catch {
    return false;
  }
}

/**
 * The email signup at the bottom of a detail page, but only for someone who
 * arrived from a shared link (`utm_source=share`, added by ShareButton). That
 * visitor has just been sent something by a friend, so the weekly email is
 * the natural next step; everyone else browsing detail pages isn't asked.
 * Signed with its own `source` ("shared") so signups from shares can be told
 * apart. Read on the client after mount, so cached server HTML is unaffected.
 */
export function SharedSubscribeCard({ className = "" }: { className?: string }) {
  const fromShare = useSyncExternalStore(subscribeNoop, readFromShare, () => false);

  if (!fromShare) return null;
  return (
    <div className={`px-4 lg:mx-auto lg:w-full lg:max-w-[1200px] lg:px-8 ${className}`}>
      <SubscribeCard source="shared" />
    </div>
  );
}

export default SharedSubscribeCard;
