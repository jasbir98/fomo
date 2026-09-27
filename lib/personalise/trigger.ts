"use client";

import { useSyncExternalStore } from "react";

/**
 * Global open/close switch for `<MakeFomoYours>` (mounted once, in
 * components/shell/AppShell.tsx, alongside BottomNav) — a plain
 * module-level store rather than route/page state, since the sheet can be
 * triggered from almost anywhere a `SaveButton` lives (feed cards, detail
 * pages), not just from Home or Profile, which are the only two places
 * that would otherwise own it.
 */
let open = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean): void {
  open = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openMakeFomoYours(): void {
  setOpen(true);
}

export function closeMakeFomoYours(): void {
  setOpen(false);
}

export function useMakeFomoYoursOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false);
}

// First-save trigger (task brief §2): "once, the FIRST time a signed-in
// user saves something ... if `fomo_prefs_done` is not set". `done` alone
// isn't quite enough to gate on — until the visitor actually answers or
// skips the card, EVERY save would re-open it, which reads as nagging
// rather than a one-time prompt. `promptedThisSession` narrows "once" to
// "once per session" as the practical middle ground: still fires again on
// a later visit if they never completed it, but never twice in one sitting.
let promptedThisSession = false;

export function maybeOpenOnFirstSave(prefsDone: boolean): void {
  if (prefsDone || promptedThisSession) return;
  promptedThisSession = true;
  openMakeFomoYours();
}
