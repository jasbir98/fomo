"use client";

import { Suspense, use, useEffect, useState } from "react";
import Link from "next/link";
import { useGeolocation } from "@/lib/geo";
import { CITY } from "@/lib/city";
import type { DiscoverIntentSlug, DiscoverResponse } from "@/lib/now/types";
import { Icon } from "@/components/ui";
import { FomoCard } from "@/components/fomo/Card";

const VALID_INTENTS: DiscoverIntentSlug[] = ["eat", "nearby", "indoors", "tonight", "book"];

/**
 * Chip discover surface (plan-v1-home-pivot.md §6) — the picture-grid a Home
 * intent chip opens into. Always pre-filtered by GET /api/discover; there is
 * no blank-search entry point into this route.
 */
function DiscoverPageInner({ params }: { params: Promise<{ intent: string }> }) {
  const { intent } = use(params);
  const [result, setResult] = useState<DiscoverResponse | null>(null);
  const { coords } = useGeolocation();

  const validIntent = VALID_INTENTS.includes(intent as DiscoverIntentSlug) ? (intent as DiscoverIntentSlug) : null;

  useEffect(() => {
    if (!validIntent) return;
    let cancelled = false;
    (async () => {
      try {
        const params2 = new URLSearchParams({ intent: validIntent });
        if (coords) {
          params2.set("lat", String(coords.lat));
          params2.set("lng", String(coords.lng));
        }
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
  }, [validIntent, coords]);

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
        {!result ? (
          <div className="flex flex-1 items-center justify-center py-16">
            <Icon name="auto_awesome" size={28} className="animate-pulse text-primary" />
          </div>
        ) : result.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Icon name="explore" size={28} className="text-outline" />
            <p className="text-body-md text-on-surface-variant">
              Nothing much on in {CITY.name} right now — here&rsquo;s what&rsquo;s worth doing anyway. Try the
              Map tab for more.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {result.items.map((item) => (
              <FomoCard key={`${item.subject.type}:${item.subject.id}`} candidate={item} variant="grid" />
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
