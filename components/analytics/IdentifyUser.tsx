"use client";

import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { usePrefs } from "@/lib/personalise/usePrefs";
import { track } from "@/lib/analytics/track";
import { CONSENT_CHANGED_EVENT } from "./ConsentBar";

/** sessionStorage key app/signin/page.tsx sets right before it hands off to
 *  a real sign-in (OTP verify, Google ID-token exchange, or the OAuth
 *  redirect fallback) — every one of those paths ends in a full page
 *  navigation (`window.location.assign`, or the OAuth provider redirect
 *  itself), so by the time this component mounts on the destination page a
 *  session already exists. Reading (and clearing) this flag once on mount
 *  is what makes `signin_completed` fire exactly once per sign-in instead
 *  of on every later page load of an already-signed-in visitor — see
 *  app/signin/page.tsx's own use of this key. */
const PENDING_SIGNIN_METHOD_KEY = "fomo:pending_signin_method";

function readAndClearPendingSigninMethod(): string | null {
  try {
    const method = sessionStorage.getItem(PENDING_SIGNIN_METHOD_KEY);
    if (method) sessionStorage.removeItem(PENDING_SIGNIN_METHOD_KEY);
    return method;
  } catch {
    return null;
  }
}

/** Whether the account was created in the last 10 minutes — i.e. this sign-in is its first. */
function isNewUser(user: User): boolean {
  const created = Date.parse(user.created_at);
  return Number.isFinite(created) && Date.now() - created < 10 * 60 * 1000;
}

/** identify()/reset() only once the visitor has tapped "OK". In cookieless
 *  mode (no answer yet, or "No thanks") the anonymous distinct_id is the
 *  `$posthog_cookieless` sentinel; identifying would send it as
 *  `$anon_distinct_id` and merge every cookieless browser into one person.
 *  Signed-in visitors without consent are still counted (by the daily hash)
 *  and carry `signed_in: true`. See instrumentation-client.ts. */
function hasConsent(): boolean {
  return window.posthog?.get_explicit_consent_status?.() === "granted";
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.("(display-mode: standalone)").matches === true || nav.standalone === true;
}

/** `fomo_who` is stored as a plain array in user_metadata (lib/useSaved.ts's
 *  `setWhoGroups`) — this just counts it defensively (a session read
 *  straight from Supabase, not our own normalised shape). */
function whoGroupsFromMetadata(userMetadata: Record<string, unknown> | null | undefined): string[] {
  const raw = userMetadata?.fomo_who;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

function interestsCountFromMetadata(userMetadata: Record<string, unknown> | null | undefined): number {
  const raw = userMetadata?.fomo_interests;
  return Array.isArray(raw) ? raw.length : 0;
}

/** Identifies the signed-in visitor to PostHog (never their email — see
 *  brief, and only with consent — see `hasConsent`) and registers the
 *  app-wide super properties every event should carry. Mounted once in
 *  AppShell, alongside ConsentBar. */
export function IdentifyUser() {
  const prefs = usePrefs();
  const [signedIn, setSignedIn] = useState(false);
  // Bumped on every cookie-bar choice: opting in resets PostHog's identity
  // and super properties, so both effects below re-run on it.
  const [consentVersion, setConsentVersion] = useState(0);

  useEffect(() => {
    const onConsentChanged = () => setConsentVersion((v) => v + 1);
    window.addEventListener(CONSENT_CHANGED_EVENT, onConsentChanged);
    return () => window.removeEventListener(CONSENT_CHANGED_EVENT, onConsentChanged);
  }, []);

  // Auth identity — separate from the super-properties effect below so a
  // prefs-only change (e.g. toggling a budget chip) never re-runs the
  // identify/reset call, only the super-property registration.
  useEffect(() => {
    const db = supabaseBrowserAuth();

    function identifySession(session: Session) {
      setSignedIn(true);
      if (!hasConsent()) return;
      const user = session.user;
      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      window.posthog?.identify?.(user.id, {
        signin_method: user.app_metadata?.provider ?? "email",
        fomo_status: typeof meta.fomo_status === "string" ? meta.fomo_status : null,
        who_groups: whoGroupsFromMetadata(meta),
        interests_count: interestsCountFromMetadata(meta),
        budget: typeof meta.fomo_budget === "string" ? meta.fomo_budget : null,
        prefs_set: meta.fomo_prefs_done === true,
      });
    }

    // Current session, once — covers both "already signed in, page just
    // loaded" and "just finished signing in and landed here via a full
    // navigation" (see PENDING_SIGNIN_METHOD_KEY's own doc comment).
    void db.auth.getSession().then(({ data: { session } }) => {
      if (!session) return;
      identifySession(session);
      const pendingMethod = readAndClearPendingSigninMethod();
      if (pendingMethod) track("signin_completed", { method: pendingMethod, is_new_user: isNewUser(session.user) });
    });

    const {
      data: { subscription },
    } = db.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) {
        identifySession(session);
        const pendingMethod = readAndClearPendingSigninMethod();
        if (pendingMethod) track("signin_completed", { method: pendingMethod, is_new_user: isNewUser(session.user) });
      } else if (event === "SIGNED_OUT") {
        if (hasConsent()) window.posthog?.reset?.();
        setSignedIn(false);
      }
    });

    return () => subscription.unsubscribe();
  }, [consentVersion]);

  // Super properties — attached to every event, identified or not.
  // Re-registered whenever `signedIn`/`prefs.done` changes (sign-in/out,
  // Make Fomo yours completed/skipped/edited) and after a cookie-bar choice.
  useEffect(() => {
    window.posthog?.register?.({
      signed_in: signedIn,
      standalone: isStandalone(),
      prefs_set: prefs.done,
    });
  }, [signedIn, prefs.done, consentVersion]);

  return null;
}

export default IdentifyUser;
