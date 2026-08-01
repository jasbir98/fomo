"use client";

import { useEffect, useState } from "react";
import { useDeviceId } from "@/lib/device";
import { getCurrentTrip, listPlaces, listReels, type SocialPostWithPlace } from "@/lib/db";
import type { Place } from "@/lib/types";
import { sortByDistance, useGeolocation, type Coordinates } from "@/lib/geo";
import { Icon, PageHeader } from "@/components/ui";
import { ReelViewer } from "@/components/social/ReelViewer";

type ViewerData = { reels: SocialPostWithPlace[]; places: Place[]; tripId: string | null };

/** Reel coordinate extractor (via its linked place) for sortByDistance. */
function reelCoords(reel: SocialPostWithPlace): Coordinates | null {
  const place = reel.place;
  return place?.lat != null && place?.lng != null ? { lat: place.lat, lng: place.lng } : null;
}

export default function ReelsTabPage() {
  const deviceId = useDeviceId();
  const { coords } = useGeolocation();

  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState<ViewerData | null>(null);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;

    (async () => {
      try {
        const trip = await getCurrentTrip(deviceId);
        if (cancelled) return;

        // Reels for the active trip's destination, falling back to every
        // reel so the tab is never blank (mirrors /social/[id]'s fallback
        // chain).
        let reels: SocialPostWithPlace[] = await listReels(trip?.destination ?? null);
        if (cancelled) return;
        if (reels.length === 0) {
          reels = await listReels(null);
          if (cancelled) return;
        }

        const places = await listPlaces();
        if (cancelled) return;

        setViewer({ reels, places, tripId: trip?.id ?? null });
      } catch (err) {
        console.error("Failed to load reels tab", err);
        if (!cancelled) setViewer({ reels: [], places: [], tripId: null });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Icon name="auto_awesome" size={32} className="animate-pulse text-primary" />
      </div>
    );
  }

  const sortedReels = viewer ? sortByDistance(viewer.reels, coords, reelCoords) : [];

  if (!viewer || sortedReels.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Reels" />
        <div className="flex flex-col items-center gap-3 px-5 py-16 text-center text-on-surface-variant">
          <Icon name="videocam_off" size={32} />
          <p className="text-body-md">No reels yet for this trip.</p>
        </div>
      </div>
    );
  }

  return (
    // Mirrors AppShell's reserved bottom padding (see its comment) so this
    // fills exactly the remaining viewport with no extra scroll — full-bleed
    // for the swipe stack, clearing the fixed BottomNav on every device.
    <div className="flex h-[calc(100dvh-88px-env(safe-area-inset-bottom))] flex-col">
      <PageHeader title="Reels" />
      <div className="relative min-h-0 flex-1">
        <ReelViewer reels={sortedReels} startIndex={0} places={viewer.places} tripId={viewer.tripId} />
      </div>
    </div>
  );
}
