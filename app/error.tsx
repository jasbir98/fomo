"use client";

import { useEffect } from "react";
import Link from "next/link";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { AppShell } from "@/components/shell/AppShell";
import { reportError } from "@/lib/analytics/report-error";

/**
 * Route-level error boundary — catches a render/render-time throw anywhere
 * under the root layout (root layout itself is only caught by
 * global-error.tsx). Client Component per Next's convention: it needs
 * `reset()` (a closure, can't cross the server/client boundary) and an
 * effect to report the error exactly once per throw.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reportError(error);
  }, [error]);

  return (
    <AppShell>
      <div className="flex min-h-[70dvh] flex-col items-center justify-center gap-4 px-6 text-center">
        <FomoSpot mood="gasp" pose="shrug" className="h-28 w-28" />
        <div className="flex flex-col gap-1">
          <h1 className="text-headline-md text-primary">Something went sideways</h1>
          <p className="max-w-[280px] text-body-md text-on-surface-variant">
            Our fault, not yours. Give it another go.
          </p>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex min-h-[48px] items-center justify-center rounded-full bg-secondary-container px-6 text-label-md font-semibold text-on-secondary-container shadow-sm transition-opacity hover:opacity-90 active:opacity-80"
          >
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex min-h-[48px] items-center justify-center rounded-full border-[1.5px] border-primary px-6 text-label-md font-semibold text-primary transition-colors hover:bg-primary/5 active:bg-primary/10"
          >
            Back to Fomo
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
