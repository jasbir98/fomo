"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Icon } from "./Icon";
import { recordAffinity } from "@/lib/personalise/affinity";
import type { InterestKey } from "@/lib/personalise/interests";
import { track } from "@/lib/analytics/track";
import { useSignedIn } from "@/lib/useSaved";

export type ShareButtonProps = {
  /** Native share sheet title. */
  title: string;
  /** Native share sheet body — e.g. "{title} · {when} · {price} — found on Fomo". */
  text?: string;
  /** Canonical URL of the detail page (build from window.location.origin + path). */
  url: string;
  /** Icon-only circular button (default, matches PageHeader's back button) or an icon+label pill. */
  variant?: "icon" | "labelled";
  className?: string;
  /** This card's personalisation interest (lib/personalise/interests.ts) — feeds the implicit-learning affinity counter (lib/personalise/affinity.ts) on a completed share by a signed-in visitor, same signal SaveButton's own `interestHint` records on a save. Omit where the interest isn't readily available. */
  interestHint?: InterestKey | null;
  /** `share_completed`'s `kind` — what's being shared (happening/event/place/weekend page, ...). Omit only where the caller has no natural subject type (nothing shares without one today, but the event stays no-op-safe). */
  kind?: string;
};

/**
 * Share a detail page: `navigator.share` where available (mobile Safari/
 * Chrome, installed PWA — shows the OS share sheet), else copy the URL to
 * the clipboard and show a small inline "Link copied" confirmation. There's
 * no shared toast/snackbar component in this codebase yet, so the
 * confirmation mirrors the copied-state pattern already used for promo
 * codes (HappeningHero, app/(shell)/happening/[id]/page.tsx): swap the icon
 * to a checkmark and auto-reset after ~2.2s.
 *
 * AbortError (user dismissed the native share sheet) is swallowed
 * silently — that's a cancel, not a failure. Any other navigator.share
 * rejection (e.g. no registered share targets) falls back to clipboard
 * rather than leaving the tap dead.
 */
export function ShareButton({ title, text, url, variant = "icon", className = "", interestHint = null, kind }: ShareButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Sharing stays open to everyone, but only a signed-in share teaches the
  // affinity counter (it only ever feeds personalised ranking, which needs an
  // account), mirroring SaveButton.
  const signedIn = useSignedIn();

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  function addUtmParams(originalUrl: string, medium: string): string {
    // Only add UTM params to same-origin or relative URLs
    try {
      const url = new URL(originalUrl, typeof window !== "undefined" ? window.location.origin : "http://localhost");
      // Only process if it's same-origin or a relative URL
      if (originalUrl.startsWith("/") || originalUrl.startsWith(url.origin)) {
        // Don't duplicate params already present
        if (!url.searchParams.has("utm_source")) {
          url.searchParams.set("utm_source", "share");
        }
        if (!url.searchParams.has("utm_medium")) {
          url.searchParams.set("utm_medium", medium);
        }
        // Return relative URL if it was relative
        if (originalUrl.startsWith("/")) {
          return url.pathname + url.search + url.hash;
        }
        return url.toString();
      }
    } catch {
      // If URL parsing fails, just return the original
    }
    return originalUrl;
  }

  async function copyToClipboard() {
    try {
      const urlWithUtm = addUtmParams(url, "copy");
      await navigator.clipboard.writeText(urlWithUtm);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard API unsupported/denied — same silent no-op as the
      // promo-code copy buttons elsewhere in this app (HappeningHero,
      // happening/[id]'s handleCopyCode): nothing else to fall back to
      // here, so there's nothing actionable to log.
    }
  }

  async function handleShare(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        const urlWithUtm = addUtmParams(url, "native");
        await navigator.share({ title, text, url: urlWithUtm });
        if (signedIn === true) recordAffinity(interestHint);
        track("share_completed", { method: "native", kind });
        return;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        // Not a user cancel — e.g. no share targets registered. Fall back
        // to clipboard rather than leaving the tap dead.
      }
    }
    await copyToClipboard();
    if (signedIn === true) recordAffinity(interestHint);
    track("share_completed", { method: "clipboard", kind });
  }

  if (variant === "labelled") {
    return (
      <button
        type="button"
        onClick={handleShare}
        aria-label={copied ? "Link copied" : "Share"}
        className={`flex items-center gap-1.5 rounded-full bg-surface-container px-3.5 py-2 text-label-sm font-bold text-on-surface transition-opacity hover:opacity-90 active:scale-95 ${className}`}
      >
        <Icon name={copied ? "check" : "ios_share"} size={16} />
        {copied ? "Copied!" : "Share"}
      </button>
    );
  }

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        aria-label={copied ? "Link copied" : "Share"}
        onClick={handleShare}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-low ${className}`}
      >
        <Icon name={copied ? "check" : "ios_share"} />
      </button>
      {copied ? (
        <span
          role="status"
          className="pointer-events-none absolute right-0 top-full z-50 mt-1 whitespace-nowrap rounded-md bg-inverse-surface px-2.5 py-1 text-label-sm font-medium text-inverse-on-surface shadow-md"
        >
          Link copied
        </span>
      ) : null}
    </div>
  );
}

export default ShareButton;
