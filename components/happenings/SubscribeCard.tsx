"use client";

import { useId, useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui";
import { track } from "@/lib/analytics/track";

export interface SubscribeCardProps {
  /** Where this card is mounted — sent as `source` to POST /api/subscribe so the digest signup list can tell which surface drove a signup. */
  source: "weekend" | "home" | "home_top" | "signup" | "finds" | "plan" | "kids";
  /**
   * `card` (default): the full card. `compact`: one slim block for Home's
   * first scroll (the promise line, email + Join, dismiss). The compact one
   * renders nothing for a browser that already subscribed or dismissed it.
   */
  variant?: "card" | "compact";
  className?: string;
}

/** localStorage key remembering "this browser already subscribed" — see this file's doc comment. */
const SUBSCRIBED_KEY = "fomo_subscribed";

/** localStorage key remembering "this browser dismissed the compact form". Only the compact variant reads it; the full card has no dismiss. */
const COMPACT_DISMISSED_KEY = "fomo:subscribe-compact-dismissed";

// Every mounted copy listens, so subscribing through one form (Home's compact
// one, say) flips the others on the same page to done/hidden too.
const storageListeners = new Set<() => void>();

function subscribeStorage(listener: () => void): () => void {
  storageListeners.add(listener);
  return () => {
    storageListeners.delete(listener);
  };
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Private window / blocked storage — the card just re-asks next visit,
    // no worse than not having this at all.
  }
  for (const listener of storageListeners) listener();
}

const readSubscribed = () => readFlag(SUBSCRIBED_KEY);
const readCompactDismissed = () => readFlag(COMPACT_DISMISSED_KEY);
const serverFalse = () => false;

/**
 * Weekend email capture ("This weekend in Edinburgh, under £10", sent
 * Thursday evening by .github/workflows/weekly-content.yml) — the account-free retention loop for the
 * Edinburgh wedge (students + young professionals who won't sign up for an
 * account, but will give an email for a weekly digest). POSTs
 * /api/subscribe, which is public (see proxy.ts's `PUBLIC_POST_PREFIXES`).
 *
 * Shown to every visitor, signed in or not — deliberately not hidden for
 * signed-in users; the digest is a separate opt-in from having an account.
 * Once a browser has successfully subscribed, `fomo_subscribed` in
 * localStorage short-circuits straight to the done state on every later
 * mount, so a returning subscriber never sees the form again (best-effort:
 * a different browser/device, or cleared storage, just asks again — no
 * server-side "is this email already on the list" check is exposed to the
 * client, see the route's doc comment on not leaking that).
 *
 * Mounted on This weekend (app/(shell)/weekend/page.tsx, source "weekend")
 * Home (app/(shell)/HomeClient.tsx: the full card at the bottom, source
 * "home", plus the compact variant right after Top picks, source
 * "home_top") and the For you tab
 * (app/(shell)/for-you, source "finds") and shared weekend plans
 * (app/(shell)/plan/[id], source "plan").
 */
export function SubscribeCard({ source, variant = "card", className = "" }: SubscribeCardProps) {
  // Home mounts two copies (phone column + desktop rail, one always `display:none`), so the input id can't be a fixed string.
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // honeypot — always empty for a real visitor
  // Server snapshot is "not subscribed" so the hydration pass matches the
  // server HTML; a returning subscriber flips to "done" right after.
  const alreadySubscribed = useSyncExternalStore(subscribeStorage, readSubscribed, serverFalse);
  const compactDismissed = useSyncExternalStore(subscribeStorage, readCompactDismissed, serverFalse);
  const [formStatus, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const status = alreadySubscribed && formStatus === "idle" ? "done" : formStatus;
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (status === "sending" || status === "done") return;
    setStatus("sending");
    setErrorMessage(null);
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, source, website }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) {
        setStatus("error");
        setErrorMessage(body?.error ?? "Couldn't save that. Try again.");
        return;
      }
      // Status first, so this copy shows its own "You're in" rather than
      // hiding (the compact variant hides on an already-subscribed browser).
      setStatus("done");
      writeFlag(SUBSCRIBED_KEY);
      track("subscribe_submitted", { surface: source });
    } catch {
      setStatus("error");
      setErrorMessage("Couldn't save that. Check your connection and try again.");
    }
  }

  function dismissCompact() {
    writeFlag(COMPACT_DISMISSED_KEY);
    track("subscribe_dismissed", { surface: source });
  }

  if (variant === "compact") {
    // Already on the list from an earlier visit, or waved away: nothing.
    if (formStatus === "idle" && (alreadySubscribed || compactDismissed)) return null;
    if (status === "done") {
      return (
        <div className={`flex min-h-11 items-center gap-2 rounded-xl bg-primary-container px-3 py-2 text-on-primary-container ${className}`}>
          <Icon name="check_circle" size={18} filled />
          <p className="text-label-md font-semibold">You&rsquo;re in. See you Thursday.</p>
        </div>
      );
    }
    return (
      <form
        onSubmit={handleSubmit}
        aria-label="Weekly email"
        className={`relative flex flex-col gap-1.5 rounded-xl border border-hairline-strong bg-surface-container-low px-3 py-2.5 ${className}`}
      >
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-label-md text-on-surface">
            <span className="font-bold">This weekend in Edinburgh, under &pound;10.</span>{" "}
            <span className="text-on-surface-variant">In your inbox Thursday by 6pm.</span>{" "}
            <Link href="/privacy" className="text-label-sm text-on-surface-variant underline underline-offset-2">
              Privacy
            </Link>
          </p>
          <button
            type="button"
            onClick={dismissCompact}
            aria-label="Dismiss"
            className="-mt-1.5 -mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <label htmlFor={emailId} className="sr-only">
            Email address
          </label>
          <input
            id={emailId}
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            maxLength={254}
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={status === "sending"}
            className="min-h-10 min-w-0 flex-1 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-70"
          />
          {/* Honeypot, same as the full card's. */}
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            className="absolute h-0 w-0 opacity-0"
            style={{ left: "-9999px" }}
          />
          <button
            type="submit"
            disabled={status === "sending"}
            className="flex min-h-10 shrink-0 items-center rounded-lg bg-primary px-4 text-label-md font-bold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {status === "sending" ? "Joining…" : "Join"}
          </button>
        </div>
        {status === "error" && errorMessage ? (
          <p className="text-label-sm font-medium text-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
      </form>
    );
  }

  if (status === "done") {
    return (
      <div
        className={`flex items-center gap-3 rounded-2xl bg-primary-container px-4 py-3 text-on-primary-container ${className}`}
      >
        <Icon name="check_circle" size={22} filled />
        <p className="text-body-md font-semibold">You&rsquo;re in. See you Thursday.</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={`flex flex-col gap-3 rounded-2xl border border-hairline-strong bg-surface-container-low p-3.5 ${className}`}
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="text-title-sm font-extrabold tracking-tight text-on-surface">
          This weekend in Edinburgh, under &pound;10
        </h3>
        <p className="text-body-sm text-on-surface-variant">In your inbox Thursday by 6pm. One email, no account.</p>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <label htmlFor={emailId} className="sr-only">
          Email address
        </label>
        <input
          id={emailId}
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          maxLength={254}
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={status === "sending"}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-70"
        />
        {/* Honeypot — hidden from sighted and assistive visitors alike. A
            real form-filler never sees or reaches this field; a bot that
            blindly fills every input trips it, and the route silently
            no-ops on a non-empty value. */}
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          className="absolute h-0 w-0 opacity-0"
          style={{ left: "-9999px" }}
        />
        <button
          type="submit"
          disabled={status === "sending"}
          className="flex min-h-11 shrink-0 items-center rounded-lg bg-primary px-4 text-label-md font-bold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {status === "sending" ? "Joining…" : "Join"}
        </button>
      </div>

      {status === "error" && errorMessage ? (
        <p className="text-label-sm font-medium text-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <Link href="/privacy" className="text-label-sm text-on-surface-variant underline underline-offset-2">
        Privacy
      </Link>
    </form>
  );
}

export default SubscribeCard;
