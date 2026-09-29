"use client";

import { AppHeader } from "@/components/shell/AppHeader";
import { SavedList } from "@/components/saved/SavedList";

/**
 * Saved — the user's saved items (deals, places and events).
 * Uses SavedList component (components/saved/SavedList.tsx) which loads from
 * /api/saved and manages caching/invalidation with the shared lib/useSaved.ts
 * store. Signed-out visitors see a friendly sign-in prompt. Page chrome follows
 * the Deals page style (AppHeader with title, content padding). The bottom-nav
 * Saved tab now points here instead of to Profile.
 */
export default function SavedPage() {
  return (
    <div className="flex flex-col pb-6">
      <AppHeader title="Saved" />

      <div className="flex flex-col gap-3 px-4 pt-3">
        <SavedList />
      </div>
    </div>
  );
}
