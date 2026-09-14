import { redirect } from "next/navigation";

/**
 * `/map` -> `/explore`. The Map tab was renamed "Explore" (BottomNav); this
 * keeps the old URL working for anything that still links or bookmarks it
 * instead of a hard 404. The real page lives at
 * app/(shell)/explore/page.tsx now.
 */
export default function MapRedirectPage() {
  redirect("/explore");
}
