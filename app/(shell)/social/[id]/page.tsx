"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { getSocialPost, listPlaces, listReels, listSocialPosts } from "@/lib/db";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import type { Db } from "@/lib/supabase/types";
import type { Place, SocialPost } from "@/lib/types";
import { FomoLoader, Icon, PageHeader } from "@/components/ui";
import { ReelViewer } from "@/components/social/ReelViewer";

type ViewerData = { reels: SocialPost[]; startIndex: number; places: Place[] };

/**
 * Builds the swipe stack for the tapped post: reels for its destination
 * (falling back to every reel, then the full social feed) so the tapped
 * post is always present in the stack, starting at its index.
 */
async function buildViewerData(db: Db, id: string, post: SocialPost): Promise<ViewerData> {
  let reels: SocialPost[] = await listReels(db, post.destination ?? null);
  if (!reels.some((r) => r.id === id)) {
    reels = await listReels(db, null);
  }
  if (!reels.some((r) => r.id === id)) {
    const allPosts = await listSocialPosts(db);
    reels = allPosts.some((r) => r.id === id) ? allPosts : [post];
  }
  const startIndex = Math.max(
    reels.findIndex((r) => r.id === id),
    0
  );
  const places = await listPlaces(db);
  return { reels, startIndex, places };
}

export default function SocialReelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const db = supabaseBrowserAuth();

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [viewer, setViewer] = useState<ViewerData | null>(null);

  useEffect(() => {
    let cancelled = false;

    getSocialPost(db, id)
      .then(async (post) => {
        if (cancelled) return;
        if (!post) {
          setNotFound(true);
          return;
        }
        const data = await buildViewerData(db, id, post);
        if (!cancelled) setViewer(data);
      })
      .catch((err) => {
        console.error("Failed to load reel viewer", err);
        if (!cancelled) setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [db, id]);

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <FomoLoader />
      </div>
    );
  }

  if (notFound || !viewer) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Reel" showBack />
        <div className="flex flex-col items-center gap-3 px-5 py-16 text-center text-on-surface-variant">
          <Icon name="videocam_off" size={32} />
          <p className="text-body-md">This reel isn&rsquo;t available.</p>
          <Link href="/" className="text-label-md font-medium text-secondary">
            Back to Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    // Mirrors AppShell's reserved bottom padding (see its comment) so this
    // fills exactly the remaining viewport with no extra scroll — full-bleed
    // for the swipe stack, clearing the fixed BottomNav on every device.
    <div className="flex h-[calc(100dvh-88px-env(safe-area-inset-bottom))] flex-col">
      <PageHeader title="Reels" showBack />
      <div className="relative min-h-0 flex-1">
        {/* No active-trip lookup on this route (single-post deep link, not
            trip-scoped) — tripId null just means ReelActionRow's "Add to
            today" stays disabled here; Ask Fomo/Save still work fine. */}
        <ReelViewer reels={viewer.reels} startIndex={viewer.startIndex} places={viewer.places} />
      </div>
    </div>
  );
}
