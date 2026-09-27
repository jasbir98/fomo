"use client";

import { useEffect, useSyncExternalStore } from "react";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { setWhoGroups } from "@/lib/useSaved";
import { WHO_GROUP_ORDER, type DealWhoGroup } from "@/lib/happenings/groups";
import { INTEREST_ORDER, type InterestKey } from "./interests";

/**
 * "Make Fomo yours" personalisation prefs — replaces Profile's old 4-chip
 * "Deals for you" selector (task brief). Signed-in: lives in Supabase auth
 * `user_metadata` (no table, same convention lib/happenings/groups.ts's
 * `fomo_who` already established). Signed-out: mirrored to localStorage
 * `fomo:prefs`, wrapped in try/catch, and merged into `user_metadata` on
 * sign-in when the account has none of this yet (task brief §1).
 *
 * `fomo_who` (lib/useSaved.ts's `setWhoGroups`/`who`) stays the single
 * source every "You qualify" badge and `personalBoost` eligibility check
 * reads — this module DERIVES it from `status`/`under26`/`residents`/
 * `over60` rather than storing its own copy, and writes it back through
 * `setWhoGroups` so lib/useSaved.ts's shared store (and everything that
 * already reads `useDealProfile()`/`useSaved().who`) stays in sync for free.
 */
export type FomoStatus = "student" | "working" | "other";
export type FomoBudget = "free" | "under10" | "any";

export interface FomoPrefs {
  status: FomoStatus | null;
  under26: boolean;
  residents: boolean;
  over60: boolean;
  interests: InterestKey[];
  budget: FomoBudget;
  /** True once the card has been completed or dismissed (task brief) — gates the first-save trigger and the Home banner. */
  done: boolean;
}

const DEFAULT_PREFS: FomoPrefs = {
  status: null,
  under26: false,
  residents: false,
  over60: false,
  interests: [],
  budget: "any",
  done: false,
};

const STORAGE_KEY = "fomo:prefs";

interface StoredShape {
  status?: unknown;
  under26?: unknown;
  residents?: unknown;
  over60?: unknown;
  interests?: unknown;
  budget?: unknown;
  done?: unknown;
}

function isFomoStatus(v: unknown): v is FomoStatus {
  return v === "student" || v === "working" || v === "other";
}

function isFomoBudget(v: unknown): v is FomoBudget {
  return v === "free" || v === "under10" || v === "any";
}

function normalisePrefs(raw: StoredShape | null | undefined): FomoPrefs {
  const rawInterests = Array.isArray(raw?.interests) ? raw.interests : [];
  const interests = INTEREST_ORDER.filter((i) => rawInterests.includes(i)).slice(0, 5);
  return {
    status: isFomoStatus(raw?.status) ? raw.status : null,
    under26: raw?.under26 === true,
    residents: raw?.residents === true,
    over60: raw?.over60 === true,
    interests,
    budget: isFomoBudget(raw?.budget) ? raw.budget : "any",
    done: raw?.done === true,
  };
}

function readLocalPrefs(): FomoPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    return normalisePrefs(JSON.parse(raw) as StoredShape);
  } catch {
    return DEFAULT_PREFS;
  }
}

function writeLocalPrefs(prefs: FomoPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full/blocked (private mode) — the sheet still works for this
    // session, it just won't be remembered next visit.
  }
}

/** Derives the persisted `fomo_who` array from status + toggles. Exported for the score/test modules, which need the same mapping to build a `who` set out of a `FomoPrefs`-shaped object. */
export function whoFromPrefs(prefs: Pick<FomoPrefs, "status" | "under26" | "residents" | "over60">): DealWhoGroup[] {
  const out: DealWhoGroup[] = [];
  if (prefs.status === "student") out.push("students");
  if (prefs.under26) out.push("under_26");
  if (prefs.residents) out.push("residents");
  if (prefs.over60) out.push("over_60");
  return out;
}

/** Reverse of `whoFromPrefs`, for reading a signed-in visitor's existing `fomo_who` (set before this feature existed, or edited elsewhere) back into the toggle shape the sheet edits. */
function togglesFromWho(who: readonly DealWhoGroup[]) {
  return {
    under26: who.includes("under_26"),
    residents: who.includes("residents"),
    over60: who.includes("over_60"),
  };
}

interface PrefsState {
  prefs: FomoPrefs;
  /** `null` until the session check + metadata read resolves — mirrors lib/useSaved.ts's own `signedIn`. */
  signedIn: boolean | null;
}

let state: PrefsState = { prefs: readLocalPrefs(), signedIn: null };
const listeners = new Set<() => void>();
let initStarted = false;

function setState(next: PrefsState): void {
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
const getServerSnapshot = (): PrefsState => ({ prefs: DEFAULT_PREFS, signedIn: null });

/** `null` when the account's `user_metadata` carries none of this feature's fields yet — the caller then merges in whatever was gathered locally pre-sign-in instead of starting the account blank. */
function parseAccountPrefs(userMetadata: unknown): FomoPrefs | null {
  const meta = userMetadata as Record<string, unknown> | null | undefined;
  if (!meta) return null;
  const hasAny =
    meta.fomo_status !== undefined ||
    meta.fomo_interests !== undefined ||
    meta.fomo_budget !== undefined ||
    meta.fomo_prefs_done !== undefined;
  if (!hasAny) return null;
  const who = WHO_GROUP_ORDER.filter((g) => Array.isArray(meta.fomo_who) && (meta.fomo_who as unknown[]).includes(g));
  const toggles = togglesFromWho(who);
  const status = isFomoStatus(meta.fomo_status) ? meta.fomo_status : who.includes("students") ? "student" : null;
  return normalisePrefs({
    status,
    ...toggles,
    interests: meta.fomo_interests,
    budget: meta.fomo_budget,
    done: meta.fomo_prefs_done,
  });
}

async function persistToAccount(prefs: FomoPrefs): Promise<void> {
  // Goes through lib/useSaved.ts's own setter so its shared `who` (every
  // "You qualify" badge, Ask Fomo, the Home hero) updates in the same tick
  // rather than waiting on the next SIGNED_IN/SIGNED_OUT reload.
  await setWhoGroups(whoFromPrefs(prefs));
  const db = supabaseBrowserAuth();
  const { error } = await db.auth.updateUser({
    data: {
      fomo_status: prefs.status,
      fomo_interests: prefs.interests,
      fomo_budget: prefs.budget,
      fomo_prefs_done: prefs.done,
    },
  });
  if (error) throw error;
}

async function load(): Promise<void> {
  const db = supabaseBrowserAuth();
  const {
    data: { session },
  } = await db.auth.getSession();
  if (!session) {
    setState({ prefs: readLocalPrefs(), signedIn: false });
    return;
  }
  const fromAccount = parseAccountPrefs(session.user.user_metadata);
  if (fromAccount) {
    setState({ prefs: fromAccount, signedIn: true });
    return;
  }
  // Signed in, but the account carries none of this yet — merge in whatever
  // was gathered locally pre-sign-in (task brief §1: "merged into
  // user_metadata on sign-in when metadata has none") rather than starting
  // the account blank.
  const local = readLocalPrefs();
  setState({ prefs: local, signedIn: true });
  if (local.status || local.interests.length > 0 || local.done) {
    try {
      await persistToAccount(local);
    } catch (err) {
      console.error("[personalise] merge local prefs on sign-in failed", err);
    }
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

/** Optimistic write; reverts + rethrows on failure. Signed-out → localStorage only (wrapped in try/catch, task brief §1). */
export async function savePrefs(next: FomoPrefs): Promise<void> {
  const previous = state.prefs;
  setState({ ...state, prefs: next });
  writeLocalPrefs(next);
  if (state.signedIn !== true) return;
  try {
    await persistToAccount(next);
  } catch (err) {
    setState({ ...state, prefs: previous });
    writeLocalPrefs(previous);
    throw err;
  }
}

/** "Skip for now" — marks the card done without changing any answered field. */
export async function dismissPrefs(): Promise<void> {
  await savePrefs({ ...state.prefs, done: true });
}

export function usePrefs() {
  useEffect(() => {
    ensureInitialized();
  }, []);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    ...snapshot.prefs,
    signedIn: snapshot.signedIn,
    save: savePrefs,
    dismiss: dismissPrefs,
  };
}

/** Read-only peek at the current prefs without subscribing to changes — for a caller (e.g. `personalBoost`'s callers) that already has `who`/prefs from its own render and just needs the raw snapshot once. */
export function getPrefsSnapshot(): FomoPrefs {
  return state.prefs;
}
