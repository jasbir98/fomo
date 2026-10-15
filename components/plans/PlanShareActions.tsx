"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon, ShareButton } from "@/components/ui";
import { track } from "@/lib/analytics/track";

export interface PlanShareActionsProps {
  id: string;
  headline: string;
}

/**
 * The plan page's buttons: "Send to the group" (WhatsApp), the native share
 * sheet / copy link, and "Make your own plan". `weekend_plan_shared` fires on
 * each completed share; the WhatsApp one counts on tap, since wa.me gives no
 * completion signal.
 *
 * The creator lands here from PlanBar with `?made=1`: they see a "your link
 * is ready" line and "Change picks" instead of "Make your own plan". The
 * param is read after mount (the page is cached and static) and stripped.
 */
export function PlanShareActions({ id, headline }: PlanShareActionsProps) {
  const [made, setMade] = useState(false);
  const [origin, setOrigin] = useState("https://askfomo.com");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    queueMicrotask(() => setOrigin(url.origin));
    if (url.searchParams.get("made") === "1") {
      queueMicrotask(() => setMade(true));
      // The creator came here to send it: bring the buttons into view under the receipt.
      setTimeout(() => rootRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
      url.searchParams.delete("made");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
  }, []);

  const link = `${origin}/plan/${id}`;
  const waText = `${headline}. Who's in?\n${link}?utm_source=share&utm_medium=whatsapp`;

  return (
    <div ref={rootRef} className="flex scroll-mt-20 flex-col gap-3">
      {made ? (
        <p role="status" className="flex items-center gap-2 rounded-xl bg-secondary-container px-3.5 py-2.5 text-label-md font-semibold text-on-secondary-container">
          <Icon name="check_circle" filled size={18} />
          Your link&rsquo;s ready. Send it to the group chat.
        </p>
      ) : null}
      <a
        href={`https://wa.me/?text=${encodeURIComponent(waText)}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => track("weekend_plan_shared", { id, method: "whatsapp", creator: made })}
        className="flex h-12 items-center justify-center gap-2 rounded-full bg-[#1f7a4d] px-5 text-label-lg font-extrabold text-white transition-opacity hover:opacity-90 active:scale-[0.98]"
      >
        <Icon name="chat" size={20} />
        Send to the group
      </a>
      <div className="flex gap-2">
        <ShareButton
          title={`${headline} · Fomo`}
          text={`${headline}. Who's in?`}
          url={link}
          variant="labelled"
          kind="plan"
          onShared={(method) => track("weekend_plan_shared", { id, method, creator: made })}
          className="h-11 flex-1 justify-center"
        />
        <Link
          href="/weekend"
          onClick={() => track("plan_make_own_clicked", { id, creator: made })}
          className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full border border-hairline-strong px-4 text-label-md font-bold text-primary hover:bg-surface-container"
        >
          <Icon name={made ? "edit" : "add"} size={18} />
          {made ? "Change picks" : "Make your own plan"}
        </Link>
      </div>
    </div>
  );
}

export default PlanShareActions;
