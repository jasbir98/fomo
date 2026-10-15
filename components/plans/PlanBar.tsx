"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Icon, SmartImage } from "@/components/ui";
import { track } from "@/lib/analytics/track";
import { clearBasket, removeFromBasket, usePlanBasket } from "@/lib/plans/basket";
import { planTotal } from "@/lib/plans/price";
import { PLAN_MIN_ITEMS } from "@/lib/plans/types";

/** Where the bar shows: the pages that have "Plan" buttons. */
function showsOn(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === "/weekend" || pathname.startsWith("/happening/") || pathname.startsWith("/event/");
}

function sourceFor(pathname: string): string {
  if (pathname.startsWith("/happening/")) return "happening_detail";
  if (pathname.startsWith("/event/")) return "event_detail";
  return "weekend";
}

/**
 * The weekend plan being built: thumbnails, running total and "Make link".
 * Mounted once in AppShell; shown on /weekend and detail pages while there's
 * at least one pick. "Make link" posts the refs to /api/plans and opens the
 * plan's own page (/plan/<id>), which has the share buttons. The picks are
 * kept, so the visitor can swap one and make a new link.
 *
 * On phones it sits just above the bottom nav, with an in-flow spacer so it
 * never covers the end of the page; on desktop it floats bottom-right, above
 * the detail modal (z-65).
 */
export function PlanBar() {
  const pathname = usePathname();
  const router = useRouter();
  const items = usePlanBasket();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!showsOn(pathname) || items.length === 0) return null;

  const total = planTotal(items.map((i) => i.price));
  const ready = items.length >= PLAN_MIN_ITEMS;
  const need = PLAN_MIN_ITEMS - items.length;

  async function makeLink() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: items.map(({ kind, id, day }) => ({ kind, id, day })) }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; created?: boolean; error?: string; message?: string };
      if (!res.ok || !body.id) {
        setError(
          res.status === 422 || res.status === 429
            ? (body.message ?? body.error ?? "Couldn't make your link.")
            : "Couldn't make your link. Try again in a minute."
        );
        return;
      }
      track("weekend_plan_created", {
        id: body.id,
        count: items.length,
        total: total.amount,
        total_from: total.from,
        unknown_prices: total.unknown,
        reused: body.created === false,
        source: sourceFor(pathname ?? ""),
      });
      setOpen(false);
      router.push(`/plan/${body.id}?made=1`);
    } catch {
      setError("Couldn't make your link. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Keeps the bar from covering the end of the page on phones. */}
      <div aria-hidden="true" className="h-24 lg:hidden" />
      <section
        aria-label="Your weekend plan"
        className="fixed inset-x-0 bottom-[calc(88px+env(safe-area-inset-bottom))] z-30 mx-auto w-full max-w-[480px] px-3 pb-2 lg:inset-x-auto lg:bottom-6 lg:right-6 lg:z-[70] lg:w-96 lg:max-w-none lg:px-0 lg:pb-0"
      >
        <div className="overflow-hidden rounded-2xl bg-inverse-surface text-inverse-on-surface shadow-level-3">
          {open ? (
            <ul className="flex flex-col gap-1 border-b border-white/10 p-2">
              {items.map((item) => (
                <li key={`${item.kind}-${item.id}`} className="flex items-center gap-2.5 rounded-xl px-1.5 py-1">
                  <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg bg-white/10">
                    <SmartImage src={item.image} alt="" width={36} height={36} className="h-full w-full object-cover" />
                  </div>
                  <span className="min-w-0 flex-1 truncate text-label-md font-semibold">{item.title}</span>
                  <span className="shrink-0 text-label-sm opacity-80">{item.price.label ?? "TBC"}</span>
                  <button
                    type="button"
                    onClick={() => removeFromBasket(item.kind, item.id)}
                    aria-label={`Remove ${item.title}`}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-white/10"
                  >
                    <Icon name="close" size={18} />
                  </button>
                </li>
              ))}
              <li className="flex justify-end px-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    clearBasket();
                    setOpen(false);
                  }}
                  className="text-label-sm font-semibold underline opacity-80 hover:opacity-100"
                >
                  Clear plan
                </button>
              </li>
            </ul>
          ) : null}
          <div className="flex items-center gap-3 p-2.5 pl-3">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
            >
              <span className="flex shrink-0 -space-x-3">
                {items.map((item) => (
                  <span
                    key={`${item.kind}-${item.id}`}
                    className="h-9 w-9 overflow-hidden rounded-full border-2 border-inverse-surface bg-white/10"
                  >
                    <SmartImage src={item.image} alt="" width={36} height={36} className="h-full w-full object-cover" />
                  </span>
                ))}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-label-lg font-bold">
                  {items.length} picked · {total.short}
                </span>
                <span className="truncate text-label-sm opacity-75">
                  {error ?? (ready ? "Ready to send" : `Add ${need} more`)}
                </span>
              </span>
              <Icon name={open ? "expand_more" : "expand_less"} size={20} className="shrink-0 opacity-75" />
            </button>
            <button
              type="button"
              onClick={makeLink}
              disabled={!ready || busy}
              className="flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 text-label-md font-extrabold text-on-accent transition-opacity disabled:opacity-50"
            >
              <Icon name={busy ? "progress_activity" : "link"} size={18} className={busy ? "animate-spin" : ""} />
              {busy ? "Making…" : "Make link"}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

export default PlanBar;
