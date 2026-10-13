"use client";

import { track } from "@/lib/analytics/track";
import type { SigninReason } from "./signin-reason";

/**
 * The one way a signed-out tap on an account-only feature (Save, Notify me,
 * For you, Make Fomo yours, Google place search) goes to /signin. `next`
 * defaults to the current page, so the visitor comes back to where they
 * were; pass `next` to land somewhere else (e.g. "/for-you" after answering
 * the Make Fomo yours sheet). `reason` picks the one-line context /signin
 * shows (lib/auth/signin-reason.ts) and tags the analytics event, so each
 * prompt's pull can be measured.
 */
export function sendToSignIn(reason: SigninReason, next?: string): void {
  if (typeof window === "undefined") return;
  const target = next ?? `${window.location.pathname}${window.location.search}`;
  track("signin_prompt_clicked", { reason });
  window.location.assign(`/signin?next=${encodeURIComponent(target)}&reason=${reason}`);
}

/** The /signin href for a plain link, same shape as `sendToSignIn` builds. */
export function signinHref(reason: SigninReason, next: string): string {
  return `/signin?next=${encodeURIComponent(next)}&reason=${reason}`;
}
