"use client";

import { useEffect, useSyncExternalStore } from "react";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { listSavedItems, saveItem, unsaveItem } from "@/lib/db/saved";
import { describeSupabaseError } from "@/lib/db/errors";
import { parseWhoGroups, type DealWhoGroup } from "@/lib/happenings/groups";
import type { CardSubjectType } from "@/lib/types";

/**
 * One shared, page-load-wide answer to "is this visitor signed in, and what
 * have they saved" — so every bookmark on screen starts in its real state
 * (the old per-card buttons always started unsaved) and one tap anywhere
 * updates the rest. Same module-store + useSyncExternalStore shape as
 * lib/geo.ts's shared location store.
 *
 * Browsing is public (proxy.ts), so a signed-out tap on Save sends the
 * visitor to /signin with `next` set to the current page, and they come back
 * to the item afterwards.
 */
interface SavedState {
  /** `null` until the session check resolves. */
  signedIn: boolean | null;
  keys: ReadonlySet<string>;
  /** Deals profile (lib/happenings/groups.ts `parseWhoGroups`) — read from the same session. */
  who: readonly DealWhoGroup[];
}

const INITIAL: SavedState = { signedIn: null, keys: new Set(), who: [] };
let state: SavedState = INITIAL;
const listeners = new Set<() => void>();
const inFlight = new Set<string>();
let initStarted = false;

function setState(next: SavedState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;
const getServerSnapshot = () => INITIAL;

function keyOf(subjectType: CardSubjectType, subjectId: string): string {
  return `${subjectType}:${subjectId}`;
}

async function load(): Promise<void> {
  const db = supabaseBrowserAuth();
  const {
    data: { session },
  } = await db.auth.getSession();
  if (!session) {
    setState({ signedIn: false, keys: new Set(), who: [] });
    return;
  }
  const who = parseWhoGroups(session.user.user_metadata);
  try {
    const rows = await listSavedItems(db);
    setState({ signedIn: true, keys: new Set(rows.map((r) => keyOf(r.subject_type, r.subject_id))), who });
  } catch (err) {
    console.error(`[saved] load failed ${describeSupabaseError(err)}`);
    setState({ signedIn: true, keys: state.keys, who });
  }
}

/** Save the deals profile to the account (auth user_metadata). Optimistic; reverts and rethrows on failure. */
export async function setWhoGroups(groups: DealWhoGroup[]): Promise<void> {
  const previous = state.who;
  setState({ ...state, who: groups });
  const { error } = await supabaseBrowserAuth().auth.updateUser({ data: { fomo_who: groups } });
  if (error) {
    setState({ ...state, who: previous });
    throw error;
  }
}

function ensureInitialized(): void {
  if (initStarted || typeof window === "undefined") return;
  initStarted = true;
  void load();
  supabaseBrowserAuth().auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN" || event === "SIGNED_OUT") void load();
  });
}

function sendToSignIn(): void {
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/signin?next=${encodeURIComponent(next)}`);
}

/** Optimistic save/unsave; reverts on failure. Signed out → sign-in, then back here. */
export async function toggleSaved(subjectType: CardSubjectType, subjectId: string): Promise<void> {
  if (state.signedIn === false) {
    sendToSignIn();
    return;
  }
  const key = keyOf(subjectType, subjectId);
  if (inFlight.has(key)) return;
  inFlight.add(key);

  const wasSaved = state.keys.has(key);
  const optimistic = new Set(state.keys);
  if (wasSaved) optimistic.delete(key);
  else optimistic.add(key);
  setState({ ...state, keys: optimistic });

  const db = supabaseBrowserAuth();
  try {
    if (wasSaved) await unsaveItem(db, subjectType, subjectId);
    else await saveItem(db, { subject_type: subjectType, subject_id: subjectId, note: null });
  } catch (err) {
    console.error(`[saved] toggle failed ${describeSupabaseError(err)}`);
    const reverted = new Set(state.keys);
    if (wasSaved) reverted.add(key);
    else reverted.delete(key);
    setState({ ...state, keys: reverted });
    // Tapped before the session check finished, and there was no session.
    if (state.signedIn !== true) sendToSignIn();
  } finally {
    inFlight.delete(key);
  }
}

export function useSaved() {
  useEffect(() => {
    ensureInitialized();
  }, []);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    signedIn: snapshot.signedIn,
    who: snapshot.who,
    isSaved: (subjectType: CardSubjectType, subjectId: string) => snapshot.keys.has(keyOf(subjectType, subjectId)),
    toggle: toggleSaved,
  };
}

export function useSignedIn(): boolean | null {
  return useSaved().signedIn;
}

export function useDealProfile() {
  const { signedIn, who } = useSaved();
  return { signedIn, who, setWho: setWhoGroups };
}
