"use client";

import { useEffect, useSyncExternalStore } from "react";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { listSavedItems, saveItem, unsaveItem } from "@/lib/db/saved";
import { describeSupabaseError } from "@/lib/db/errors";
import { parseWhoGroups, type DealWhoGroup } from "@/lib/happenings/groups";
import type { CardSubjectType } from "@/lib/types";
import { sendToSignIn } from "@/lib/auth/send-to-signin";
import {
  addLocalSave,
  clearLocalSaves,
  isLocalSaveType,
  localKey,
  markSavePromptShown,
  readLocalSaves,
  removeLocalSave,
  shouldShowSavePrompt,
  type LocalSave,
} from "@/lib/saved/local-store";
import { mergeLocalSaves } from "@/lib/saved/merge";

/**
 * One shared, page-load-wide answer to "is this visitor signed in, and what
 * have they saved" — so every bookmark on screen starts in its real state
 * (the old per-card buttons always started unsaved) and one tap anywhere
 * updates the rest. Same module-store + useSyncExternalStore shape as
 * lib/geo.ts's shared location store.
 *
 * Browsing is public (proxy.ts), so a signed-out tap on Save keeps the save
 * on this device (lib/saved/local-store.ts) instead of sending the visitor to
 * a sign-in wall. On the third local save a small prompt offers sign-in; once
 * they do sign in, `load()` merges the local saves into the account
 * (lib/saved/merge.ts) and clears them.
 */
interface SavedState {
  /** `null` until the session check resolves. */
  signedIn: boolean | null;
  keys: ReadonlySet<string>;
  /** Deals profile (lib/happenings/groups.ts `parseWhoGroups`) — read from the same session. */
  who: readonly DealWhoGroup[];
  /** The "sign in to keep your saves" prompt is showing (third local save). */
  promptOpen: boolean;
}

const INITIAL: SavedState = { signedIn: null, keys: new Set(), who: [], promptOpen: false };
let state: SavedState = INITIAL;
const listeners = new Set<() => void>();
const inFlight = new Set<string>();
let initStarted = false;
let loadPromise: Promise<void> | null = null;
let merging = false;

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
  return localKey(subjectType, subjectId);
}

const keysOfLocal = (saves: readonly LocalSave[]): Set<string> => new Set(saves.map((s) => localKey(s.type, s.id)));

/** Which of these local saves still exist, via the public by-id read (/api/saved/local). Throws if it can't tell, so a failed check never loses saves. */
async function fetchExistingKeys(refs: readonly LocalSave[]): Promise<ReadonlySet<string>> {
  const found = new Set<string>();
  for (let i = 0; i < refs.length; i += 60) {
    const refsParam = refs
      .slice(i, i + 60)
      .map((r) => localKey(r.type, r.id))
      .join(",");
    const res = await fetch(`/api/saved/local?refs=${encodeURIComponent(refsParam)}`);
    if (!res.ok) throw new Error(`saved/local ${res.status}`);
    const data = (await res.json()) as { items?: { subject: { type: string; id: string } }[] };
    for (const c of data.items ?? []) found.add(localKey(c.subject.type, c.subject.id));
  }
  return found;
}

/** Signed in: copy any local saves into the account, then clear them. On failure they stay for the next load. */
async function mergeLocalIntoAccount(db: ReturnType<typeof supabaseBrowserAuth>, accountKeys: ReadonlySet<string>): Promise<void> {
  if (merging) return;
  const local = readLocalSaves();
  if (local.length === 0) return;
  merging = true;
  try {
    const result = await mergeLocalSaves({
      local,
      accountKeys,
      existing: fetchExistingKeys,
      save: async (ref) => {
        await saveItem(db, { subject_type: ref.type, subject_id: ref.id, note: null });
      },
      clear: clearLocalSaves,
    });
    if (result.status === "failed") console.error(`[saved] merging local saves failed ${describeSupabaseError(result.error)}`);
    if (result.status !== "empty" && result.added.length > 0) {
      setState({ ...state, keys: new Set([...state.keys, ...keysOfLocal(result.added)]) });
    }
  } finally {
    merging = false;
  }
}

async function load(): Promise<void> {
  const db = supabaseBrowserAuth();
  const {
    data: { session },
  } = await db.auth.getSession();
  if (!session) {
    setState({ ...state, signedIn: false, keys: keysOfLocal(readLocalSaves()), who: [] });
    return;
  }
  const who = parseWhoGroups(session.user.user_metadata);
  try {
    const rows = await listSavedItems(db);
    const accountKeys = new Set(rows.map((r) => keyOf(r.subject_type, r.subject_id)));
    setState({ ...state, signedIn: true, keys: accountKeys, who, promptOpen: false });
    void mergeLocalIntoAccount(db, accountKeys);
  } catch (err) {
    console.error(`[saved] load failed ${describeSupabaseError(err)}`);
    setState({ ...state, signedIn: true, keys: state.keys, who });
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
  loadPromise = load();
  supabaseBrowserAuth().auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN" || event === "SIGNED_OUT") void load();
  });
}

/** What a save/unsave tap actually did — callers use it to decide what to count. */
export interface SaveOutcome {
  /** The save state really moved (false for a no-op, a failure, or a redirect to sign-in). */
  changed: boolean;
  /** Where the save lives: `local` = this device only (signed out), `account` = the user's account. */
  storage: "local" | "account";
}

const NO_CHANGE_ACCOUNT: SaveOutcome = { changed: false, storage: "account" };
const NO_CHANGE_LOCAL: SaveOutcome = { changed: false, storage: "local" };

/** Signed out: keep the save on this device. Falls back to sign-in only when storage is unavailable or the subject type can't be stored. */
function setLocalSaved(subjectType: CardSubjectType, subjectId: string, desired: boolean): SaveOutcome {
  if (!isLocalSaveType(subjectType)) {
    sendToSignIn("save");
    return NO_CHANGE_LOCAL;
  }
  if (state.keys.has(keyOf(subjectType, subjectId)) === desired) return NO_CHANGE_LOCAL;
  const next = desired ? addLocalSave(subjectType, subjectId) : removeLocalSave(subjectType, subjectId);
  if (next === null) {
    // Storage blocked (private window): the old behaviour, a sign-in.
    sendToSignIn("save");
    return NO_CHANGE_LOCAL;
  }
  const promptOpen = desired && shouldShowSavePrompt(next.length);
  if (promptOpen) markSavePromptShown();
  setState({ ...state, keys: keysOfLocal(next), promptOpen: promptOpen || state.promptOpen });
  return { changed: true, storage: "local" };
}

/** Hide the "sign in to keep your saves" prompt. The cooldown already started when it was shown. */
export function dismissSavePrompt(): void {
  if (state.promptOpen) setState({ ...state, promptOpen: false });
}

/**
 * Shared optimistic save/unsave core: moves (subjectType, subjectId) to
 * `desired` (true = saved, false = unsaved). No-ops if already in that
 * state. Signed out → saved on this device only.
 */
async function setSavedState(
  subjectType: CardSubjectType,
  subjectId: string,
  desired: boolean
): Promise<SaveOutcome> {
  // A tap before the session check finished waits for it, so it lands in the right place.
  if (state.signedIn === null && loadPromise) await loadPromise;
  if (state.signedIn === false) return setLocalSaved(subjectType, subjectId, desired);
  const key = keyOf(subjectType, subjectId);
  if (inFlight.has(key)) return NO_CHANGE_ACCOUNT;
  const wasSaved = state.keys.has(key);
  if (wasSaved === desired) return NO_CHANGE_ACCOUNT;
  inFlight.add(key);

  const optimistic = new Set(state.keys);
  if (desired) optimistic.add(key);
  else optimistic.delete(key);
  setState({ ...state, keys: optimistic });

  const db = supabaseBrowserAuth();
  try {
    if (desired) await saveItem(db, { subject_type: subjectType, subject_id: subjectId, note: null });
    else await unsaveItem(db, subjectType, subjectId);
  } catch (err) {
    console.error(`[saved] ${desired ? "save" : "unsave"} failed ${describeSupabaseError(err)}`);
    const reverted = new Set(state.keys);
    if (desired) reverted.delete(key);
    else reverted.add(key);
    setState({ ...state, keys: reverted });
    return NO_CHANGE_ACCOUNT;
  } finally {
    inFlight.delete(key);
  }
  return { changed: true, storage: "account" };
}

/** Optimistic save/unsave toggle; reverts on failure. Signed out → kept on this device. */
export async function toggleSaved(subjectType: CardSubjectType, subjectId: string): Promise<SaveOutcome> {
  if (state.signedIn === null && loadPromise) await loadPromise;
  const wasSaved = state.keys.has(keyOf(subjectType, subjectId));
  return setSavedState(subjectType, subjectId, !wasSaved);
}

/**
 * Subscribe to the saved-*keys* set specifically, ignoring `signedIn`/`who`
 * changes that don't affect what's saved. Used by
 * app/(shell)/profile/page.tsx to invalidate its cached Saved list (see
 * lib/http/clientCache.ts) whenever a save/unsave happens anywhere in the
 * app — including on a different page, since this is the one shared store
 * every bookmark tap goes through. Returns an unsubscribe function.
 */
export function subscribeSavedChanges(listener: (keys: ReadonlySet<string>) => void): () => void {
  let lastKeys = state.keys;
  return subscribe(() => {
    if (state.keys !== lastKeys) {
      lastKeys = state.keys;
      listener(state.keys);
    }
  });
}

export function useSaved() {
  useEffect(() => {
    ensureInitialized();
  }, []);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    signedIn: snapshot.signedIn,
    who: snapshot.who,
    /** Saves held on this device only; 0 once signed in (they merge into the account). */
    localSaveCount: snapshot.signedIn === false ? snapshot.keys.size : 0,
    promptOpen: snapshot.promptOpen,
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
