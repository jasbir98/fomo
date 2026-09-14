"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui";

/**
 * /saved now redirects to /profile#saved — the shortlist moved into a
 * "Saved" section on Profile in the Home decluttering pass (Deals took this
 * slot in the bottom nav; see components/shell/BottomNav.tsx). The route
 * itself stays alive rather than 404ing so any existing link/bookmark to
 * /saved keeps working — a client-side redirect (not a Next.js `redirect()`
 * in a server component) so the `#saved` fragment actually lands the browser
 * on the right section instead of being dropped by a server redirect.
 */
export default function SavedRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/profile#saved");
  }, [router]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 text-on-surface-variant">
      <Icon name="bookmark" size={28} className="animate-pulse text-primary" />
      <p className="text-body-md">Taking you to Saved…</p>
    </div>
  );
}
