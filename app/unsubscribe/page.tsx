"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FomoLogo } from "@/components/ui";

/**
 * Fomo Friday one-click unsubscribe landing page.
 *
 * Public, no session required (see proxy.ts — pages are public by default
 * there; only the API route needed an explicit allowlist entry). Calls
 * GET /api/unsubscribe?token=… itself on mount and always shows the same
 * neutral confirmation, matching that route's no-enumeration behaviour —
 * this page never tells a visitor whether their token was valid, already
 * used, or bogus, just that they're unsubscribed either way.
 */
function UnsubscribeContent() {
  const params = useSearchParams();
  const token = params.get("token");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const res = await fetch(`/api/unsubscribe?token=${encodeURIComponent(token ?? "")}`);
        const body = (await res.json()) as { message?: string };
        if (!cancelled) setMessage(body.message ?? "You're unsubscribed.");
      } catch {
        // Network failure only — the route itself never errors on a bad
        // token (see its own no-enumeration note). Same neutral copy.
        if (!cancelled) setMessage("You're unsubscribed. You won't get any more Fomo Friday emails.");
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#f4f5f8] px-6 text-center lg:mx-auto lg:max-w-3xl lg:px-8 lg:py-12">
      <FomoLogo className="mb-8 h-8 w-auto" />
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm">
        {message === null ? (
          <p className="text-sm text-[#5b6472]">Unsubscribing…</p>
        ) : (
          <>
            <h1 className="text-lg font-bold text-[#1b365d]">You&apos;re unsubscribed</h1>
            <p className="mt-3 text-sm leading-relaxed text-[#5b6472]">{message}</p>
          </>
        )}
        <a
          href="/weekend"
          className="mt-6 inline-block text-sm font-semibold text-[#1b365d] underline underline-offset-2"
        >
          Back to askfomo.com
        </a>
      </div>
    </main>
  );
}

export default function UnsubscribePage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-[#f4f5f8]">
          <p className="text-sm text-[#5b6472]">Loading…</p>
        </main>
      }
    >
      <UnsubscribeContent />
    </Suspense>
  );
}
