"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "roameo_device_id";
/**
 * `?device=<uuid>` claims an existing device's data in this browser (it is
 * written to localStorage, so it survives navigation once the param is gone).
 * This is how you open the app on a phone against the LAN dev server and see
 * the same trip as your laptop — localStorage is per-browser, so a phone would
 * otherwise mint a fresh id and land in onboarding.
 */
const OVERRIDE_PARAM = "device";
/**
 * Optional shared id for local development (set NEXT_PUBLIC_DEV_DEVICE_ID in
 * .env.local): every browser hitting this dev server starts on that device's
 * data without needing the query param. Only used when nothing is stored yet,
 * so a `?device=` override or an already-onboarded browser still wins.
 */
const DEV_FALLBACK_ID = process.env.NEXT_PUBLIC_DEV_DEVICE_ID?.trim() || null;

/** `?device=<id>` from the current URL, or null. */
function readOverrideId(): string | null {
  try {
    const value = new URLSearchParams(window.location.search).get(OVERRIDE_PARAM);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Returns a stable per-device UUID, persisted in localStorage.
 * SSR-safe: returns "" on the server (no localStorage). Always resolve the
 * real id on the client via useDeviceId() before issuing device-scoped queries.
 *
 * Resolution order: `?device=` in the URL (adopted and persisted), then the
 * stored id, then NEXT_PUBLIC_DEV_DEVICE_ID, then a fresh UUID.
 */
export function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  try {
    const override = readOverrideId();
    if (override) {
      if (window.localStorage.getItem(STORAGE_KEY) !== override) {
        window.localStorage.setItem(STORAGE_KEY, override);
      }
      return override;
    }
    let id = window.localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = DEV_FALLBACK_ID ?? randomId();
      window.localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  } catch {
    // localStorage unavailable (private mode / blocked) — degrade gracefully.
    return "";
  }
}

/**
 * crypto.randomUUID() only exists in secure contexts (HTTPS or localhost).
 * Loading the dev server via a LAN IP (http://192.168.x.x) is not a secure
 * context, so it's undefined there — fall back to a manual UUIDv4.
 */
function randomId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const noopSubscribe = () => () => {};

/**
 * React hook that resolves the device id. Returns "" on the server / during
 * hydration, then the stable id on the client — no hydration mismatch, no
 * setState-in-effect. getDeviceId() returns the same persisted string on every
 * client call, satisfying useSyncExternalStore's snapshot stability.
 */
export function useDeviceId(): string {
  return useSyncExternalStore(
    noopSubscribe,
    () => getDeviceId(),
    () => ""
  );
}
