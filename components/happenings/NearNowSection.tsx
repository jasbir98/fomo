"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, ScrollRail } from "@/components/ui";
import { FeedListCard } from "@/components/happenings/FeedListCard";
import { refreshGeolocation, useGeolocation } from "@/lib/geo";
import { nearNow } from "@/lib/happenings/near-now";
import { weekendCardKey } from "@/lib/happenings/weekend";
import { CITY } from "@/lib/city";
import { track } from "@/lib/analytics/track";
import { useNow } from "@/lib/useNow";
import type { FeedResponse } from "@/lib/happenings/feed-types";

export interface NearNowSectionProps {
  /** The Today (`window=now`) feed Home already loaded — no fetch of its own. */
  feed: FeedResponse;
  className?: string;
}

function Header() {
  return (
    <h3 className="flex items-center gap-2 px-1 text-headline-sm font-extrabold tracking-tight text-on-surface">
      <Icon name="near_me" size={20} className="text-accent" />
      Near you now
    </h3>
  );
}

/**
 * Home's "Near you now" (lib/happenings/near-now.ts picks the cards): today's
 * What's on cards and deals within a short walk, nearest first, each with a
 * "450 m · 6 min walk · starts 19:00" line.
 *
 * Location is asked for only on a tap of "What's on near me?" — never on load
 * (lib/geo.ts's rule). A visitor who granted it before sees the section
 * straight away; a denial or an unsupported browser renders nothing.
 * Coordinates never leave the device: analytics get a count and a status only.
 */
export function NearNowSection({ feed, className = "" }: NearNowSectionProps) {
  const geo = useGeolocation();
  const now = useNow();
  const [asking, setAsking] = useState(false);
  const tappedRef = useRef(false);
  const reportedRef = useRef(false);

  const result = useMemo(
    () => (geo.status === "granted" && geo.coords ? nearNow(feed, geo.coords, now, CITY.timezone) : null),
    [feed, geo.status, geo.coords, now]
  );

  // One `near_me_result` per mount: the first resolved outcome, whether it
  // came from a tap or from a permission granted on an earlier visit.
  useEffect(() => {
    if (reportedRef.current) return;
    if (result) {
      reportedRef.current = true;
      const status = result.status === "outside_city" ? "outside_city" : result.items.length ? "ok" : "empty";
      track("near_me_result", { status, count: result.items.length, tapped: tappedRef.current });
    } else if (tappedRef.current && geo.status === "denied") {
      reportedRef.current = true;
      track("near_me_result", { status: "denied", count: 0, tapped: true });
    }
  }, [result, geo.status]);

  if (geo.status === "denied" || geo.status === "unsupported") return null;

  if (!result) {
    const busy = asking;
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          tappedRef.current = true;
          setAsking(true);
          track("near_me_tapped");
          void refreshGeolocation().finally(() => setAsking(false));
        }}
        className={`flex min-h-[44px] w-full items-center gap-2 rounded-xl border border-hairline bg-surface-container-low px-3 py-2.5 text-left text-label-md font-semibold text-primary transition-opacity hover:opacity-90 disabled:opacity-70 ${className}`}
      >
        <Icon name="near_me" size={18} className={busy ? "animate-pulse motion-reduce:animate-none" : ""} />
        <span className="flex-1">{busy ? "Finding what's near you…" : "What's on near me?"}</span>
        {busy ? null : <Icon name="chevron_right" size={16} />}
      </button>
    );
  }

  if (result.status === "outside_city") {
    return (
      <section className={`flex flex-col gap-2 ${className}`}>
        <Header />
        <p className="px-1 text-body-sm text-on-surface-variant">Near me works in {CITY.name}.</p>
      </section>
    );
  }

  return (
    <section className={`flex flex-col gap-2 ${className}`}>
      <Header />
      {result.items.length === 0 ? (
        <p className="px-1 text-body-sm text-on-surface-variant">Nothing within a 20-minute walk right now.</p>
      ) : (
        <ScrollRail scrollerClassName="-mx-4 items-stretch gap-3 px-4 pb-1 lg:mx-0 lg:px-0">
          {result.items.map((item, i) => (
            <div key={weekendCardKey(item.card)} className="w-[17.5rem] shrink-0">
              <FeedListCard card={item.card} surface="home_near_now" position={i} reason={item.reason} reasonIcon="near_me" />
            </div>
          ))}
        </ScrollRail>
      )}
    </section>
  );
}

export default NearNowSection;
