import Link from "next/link";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { AppShell } from "@/components/shell/AppShell";

/**
 * Global 404 — catches any unmatched route (typo'd link, dead deep-link,
 * a happening/event that's been removed). Lives at the app root rather than
 * inside app/(shell) so it also catches paths outside that group (e.g.
 * /signin/typo), but is still wrapped in AppShell so a mistyped or dead
 * link doesn't strand the visitor without the bottom nav to get back in —
 * the (shell) group's own layout only wraps routes matched inside it, which
 * a 404 by definition isn't.
 */
export default function NotFound() {
  return (
    <AppShell>
      <div className="flex min-h-[70dvh] flex-col items-center justify-center gap-4 px-6 text-center">
        <FomoSpot mood="meh" pose="shrug" className="h-28 w-28" />
        <div className="flex flex-col gap-1">
          <h1 className="text-headline-md text-primary">Nothing here</h1>
          <p className="max-w-[280px] text-body-md text-on-surface-variant">
            This page did a runner. Let&apos;s get you back to what&apos;s on.
          </p>
        </div>
        <Link
          href="/"
          className="mt-2 inline-flex min-h-[48px] items-center justify-center rounded-full bg-secondary-container px-6 text-label-md font-semibold text-on-secondary-container shadow-sm transition-opacity hover:opacity-90 active:opacity-80"
        >
          Back to Fomo
        </Link>
      </div>
    </AppShell>
  );
}
