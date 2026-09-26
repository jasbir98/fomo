"use client";

import { AppHeader } from "@/components/shell/AppHeader";
import { SavedList } from "@/components/saved/SavedList";

/**
 * Saved — the user's saved items (deals, places, events, experiences, reels).
 * Uses SavedList component (components/saved/SavedList.tsx) which loads from
 * /api/saved and manages caching/invalidation with the shared lib/useSaved.ts
 * store. Signed-out visitors see a friendly sign-in prompt. Page chrome follows
 * the Deals page style (AppHeader with title, content padding). The bottom-nav
 * Saved tab now points here instead of to Profile.
 */
export default function SavedPage() {
  return (
    <div className="flex flex-col gap-5 pb-8">
      <AppHeader title="Saved" />

      <div className="flex flex-col gap-4 px-4">
        <SavedList />
      </div>
    </div>
  );
}
