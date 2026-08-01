"use client";

import { Suspense, use, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useDeviceId } from "@/lib/device";
import { getCurrentTrip } from "@/lib/db";
import { useGeolocation } from "@/lib/geo";
import type { DiscoverIntentSlug, DiscoverResponse } from "@/lib/now/types";
import type { Trip } from "@/lib/types";
import { Icon } from "@/components/ui";
import { RoameoCard } from "@/components/roameo/Card";

const VALID_INTENTS: DiscoverIntentSlug[] = [
  "tonight",
  "book",
  "eat",
  "gap",
  "indoors",
  // v1.1 W2 additions — see-all targets for Home's quick-action "Nearby"
  // tile and the near_next/closing rails (lib/now/rails.ts).
  "nearby",
  "near-next",
  "closing",
];

/**
 * Chip discover surface (plan-v1-home-pivot.md §6) — the picture-grid a Home
 * intent chip opens into. Always pre-filtered by GET /api/discover; there is
 * no blank-search entry point into this route.
 */
function DiscoverPageInner({ params }: { params: Promise<{ intent: string }> }) {
  const { intent } = use(params);
  const deviceId = useDeviceId();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [result, setResult] = useState<DiscoverResponse | null>(null);
  const { coords } = useGeolocation();
  const searchParams = useSearchParams();
  // "More for this gap →" (Plan's gap blocks, plan-v1.1-overhaul.md W4 #3)
  // passes the free-minute count — see lib/now/discover.ts's `minutes` doc
  // comment for what it does (and doesn't) affect. /plan/add's "Browse
  // what's nearby" (W4 #7) links here scoped to the selected day, but no
  // `day` filter exists on this surface yet — that link is a plain
  // navigation for now, same "at minimum just navigate there" allowance the
  // brief gives `minutes`.
  const minutesParam = searchParams.get("minutes");

  const validIntent = VALID_INTENTS.includes(intent as DiscoverIntentSlug) ? (intent as DiscoverIntentSlug) : null;

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const currentTrip = await getCurrentTrip(deviceId);
        if (!cancelled) setTrip(currentTrip);
      } catch (err) {
        console.error("[discover] trip load failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  useEffect(() => {
    if (!deviceId || !trip || !validIntent) return;
    let cancelled = false;
    (async () => {
      try {
        const params2 = new URLSearchParams({ deviceId, tripId: trip.id, intent: validIntent });
        if (coords) {
          params2.set("lat", String(coords.lat));
          params2.set("lng", String(coords.lng));
        }
        if (minutesParam) params2.set("minutes", minutesParam);
        const res = await fetch(`/api/discover?${params2.toString()}`);
        const json = (await res.json()) as DiscoverResponse;
        if (!cancelled) setResult(json);
      } catch (err) {
        console.error("[discover] /api/discover fetch failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, trip, validIntent, coords, minutesParam]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 flex items-center gap-3 bg-background/90 px-5 pt-safe pb-3 backdrop-blur-sm">
        <Link
          href="/"
          aria-label="Back to Home"
          className="flex h-9 w-9 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container"
        >
          <Icon name="arrow_back" />
        </Link>
        <div>
          <h1 className="text-headline-sm text-primary">{result?.title ?? "Discover"}</h1>
          {result ? <p className="text-label-sm text-on-surface-variant">{result.meta}</p> : null}
        </div>
      </header>

      <div className="flex-1 px-5 pb-10">
        {!trip ? (
          <div className="flex flex-1 items-center justify-center py-16">
            <Icon name="auto_awesome" size={28} className="animate-pulse text-primary" />
          </div>
        ) : !result ? (
          <div className="flex flex-1 items-center justify-center py-16">
            <Icon name="auto_awesome" size={28} className="animate-pulse text-primary" />
          </div>
        ) : result.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Icon name="explore" size={28} className="text-outline" />
            <p className="text-body-md text-on-surface-variant">
              Nothing much on in {trip.destination ?? "this area"}{" "}
              right now — here&rsquo;s what&rsquo;s worth doing anyway. Try the Map tab for more.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {result.items.map((item) => (
              <RoameoCard
                key={`${item.subject.type}:${item.subject.id}`}
                candidate={item}
                variant="grid"
                deviceId={deviceId}
                tripId={trip.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function DiscoverPage(props: { params: Promise<{ intent: string }> }) {
  return (
    <Suspense fallback={null}>
      <DiscoverPageInner {...props} />
    </Suspense>
  );
}
