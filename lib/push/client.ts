"use client";

/**
 * Fomo — browser-side Web Push subscribe/unsubscribe.
 *
 * Feature-detection and the iOS "not installed" case are the two real traps
 * here:
 *   - Push requires a Service Worker (`public/sw.js`, registered from
 *     app/layout.tsx) + the Push API + Notification API. All three exist on
 *     desktop Chrome/Firefox/Edge and on Android Chrome; Safari on iOS only
 *     exposes them once the site has been added to the Home Screen (iOS
 *     16.4+) — running inside a normal Safari tab, `window.PushManager` is
 *     simply undefined, same as a browser with no support at all, so that
 *     alone can't distinguish "never will work here" from "would work after
 *     Add to Home Screen." `isIOSNotStandalone()` below narrows that so the
 *     UI can show the right message instead of a generic "not supported."
 *   - `Notification.requestPermission()` must be called from a user gesture
 *     (a click handler) — callers of `subscribeToPush` are expected to only
 *     invoke it from one (e.g. NotifyMeButton's onClick), never from an
 *     effect. This module doesn't enforce that; it can't from in here.
 */

export type PushUnsupportedReason =
  | "no_service_worker"
  | "no_push_manager"
  | "no_notification_api"
  | "ios_not_standalone";

export interface PushSubscribeResult {
  ok: boolean;
  /** Set when `ok` is false. */
  reason?: PushUnsupportedReason | "permission_denied" | "vapid_key_missing" | "subscribe_failed" | "save_failed";
}

/** True on iOS Safari running as a normal browser tab (not installed to the Home Screen) — the one case worth a distinct, actionable message rather than "unsupported." */
export function isIOSNotStandalone(): boolean {
  if (typeof navigator === "undefined") return false;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS 13+ reports as "MacIntel" with touch support — the standard sniff.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!isIOS) return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  const isStandalone = nav.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches;
  return !isStandalone;
}

/** Cheap feature/support check, no side effects and no permission prompt — safe to call on mount to decide whether to render the Notify Me affordance at all. */
export function pushSupportReason(): PushUnsupportedReason | null {
  if (isIOSNotStandalone()) return "ios_not_standalone";
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return "no_service_worker";
  if (typeof window === "undefined" || !("PushManager" in window)) return "no_push_manager";
  if (typeof window === "undefined" || !("Notification" in window)) return "no_notification_api";
  return null;
}

/**
 * Returned as `BufferSource` rather than `Uint8Array` — TS's DOM lib types
 * `PushSubscriptionOptionsInit.applicationServerKey` against
 * `ArrayBufferView<ArrayBuffer>` specifically, and a plain `Uint8Array`'s
 * inferred `ArrayBufferLike` backing buffer doesn't structurally satisfy
 * that (a real runtime non-issue — `new Uint8Array(n)` always backs onto a
 * real `ArrayBuffer`, never a `SharedArrayBuffer`).
 */
function urlBase64ToUint8Array(base64String: string): BufferSource {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray as BufferSource;
}

/**
 * Ensures the browser holds a live PushSubscription and that the server
 * knows about it (POST /api/push/subscribe). Idempotent — safe to call every
 * time a user taps a "Notify me" affordance, not just once per device: an
 * existing subscription is reused, and the upsert-by-endpoint on the server
 * means re-registering the same device is a no-op update, not a duplicate.
 *
 * MUST be called from a user gesture the first time (permission hasn't been
 * granted yet) — `Notification.requestPermission()` silently auto-denies
 * outside one in most browsers.
 */
export async function ensurePushSubscribed(): Promise<PushSubscribeResult> {
  const unsupported = pushSupportReason();
  if (unsupported) return { ok: false, reason: unsupported };

  if (Notification.permission === "denied") {
    return { ok: false, reason: "permission_denied" };
  }
  if (Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { ok: false, reason: "permission_denied" };
  }

  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidKey) return { ok: false, reason: "vapid_key_missing" };

  try {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    }

    const json = subscription.toJSON();
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: json.endpoint,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
        userAgent: navigator.userAgent,
      }),
    });
    if (!res.ok) return { ok: false, reason: "save_failed" };
    return { ok: true };
  } catch (err) {
    console.error("[push] subscribe failed", err);
    return { ok: false, reason: "subscribe_failed" };
  }
}

/** Unsubscribes this device from push entirely (both the browser's PushSubscription and the server's record of it). Does not touch onsale_alerts rows or big_onsale_alerts — callers that mean "stop this one alert" should call the alerts API instead. */
export async function unsubscribeFromPush(): Promise<void> {
  if (pushSupportReason()) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
  } catch (err) {
    console.error("[push] unsubscribe failed", err);
  }
}

/** Human-readable, UI-ready line for a `PushSubscribeResult`'s failure reason (or the current permission state on mount). Never throws. */
export function pushReasonMessage(reason: PushUnsupportedReason | string | null | undefined): string | null {
  switch (reason) {
    case "ios_not_standalone":
      return "Add Fomo to your Home Screen to get alerts.";
    case "permission_denied":
      return "Notifications are blocked. Enable them in your browser settings to get alerts.";
    case "no_service_worker":
    case "no_push_manager":
    case "no_notification_api":
      return "Your browser doesn't support notifications.";
    case "vapid_key_missing":
      return "Alerts aren't set up yet.";
    case "subscribe_failed":
    case "save_failed":
      return "Couldn't turn on alerts. Try again.";
    default:
      return null;
  }
}
