/**
 * Saves made before an account exists. A signed-out tap on a bookmark stores
 * a small reference (type + id + when) in localStorage; on sign-in they are
 * merged into the account (lib/saved/merge.ts) and this store is cleared.
 *
 * This is functional storage (it is the feature), not analytics. Everything
 * takes an optional `Storage` so it can be tested without a browser, and every
 * read and write is wrapped: private windows and blocked storage must never
 * throw into the UI.
 */
import type { CardSubjectType } from "@/lib/types";

export const LOCAL_SAVES_KEY = "fomo_saved_local_v1";
export const SAVE_PROMPT_KEY = "fomo_saved_prompt_v1";

/** Types a signed-out visitor can save (the ones the Saved page can render). */
export type LocalSaveType = Extract<CardSubjectType, "happening" | "place" | "event">;

export interface LocalSave {
  type: LocalSaveType;
  id: string;
  /** Epoch milliseconds. */
  savedAt: number;
}

/** The save count at which the sign-in prompt appears. */
export const SAVE_PROMPT_AT = 3;
/** Once the prompt has been shown, it stays quiet for this long. */
export const SAVE_PROMPT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
/** Safety cap so a runaway loop can never fill storage. */
export const MAX_LOCAL_SAVES = 200;

const TYPES: readonly string[] = ["happening", "place", "event"];

export function isLocalSaveType(value: unknown): value is LocalSaveType {
  return typeof value === "string" && TYPES.includes(value);
}

export function localKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): LocalSave[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object") return [];
    const list = (data as { items?: unknown }).items;
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const out: LocalSave[] = [];
    for (const row of list) {
      if (!row || typeof row !== "object") continue;
      const { type, id, savedAt } = row as Record<string, unknown>;
      if (!isLocalSaveType(type) || typeof id !== "string" || id.length === 0 || id.length > 100) continue;
      const key = localKey(type, id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type, id, savedAt: typeof savedAt === "number" && Number.isFinite(savedAt) ? savedAt : 0 });
    }
    return out;
  } catch {
    return [];
  }
}

/** Newest first. */
export function readLocalSaves(storage: Storage | null = defaultStorage()): LocalSave[] {
  if (!storage) return [];
  try {
    return parse(storage.getItem(LOCAL_SAVES_KEY)).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

function write(storage: Storage | null, items: LocalSave[]): boolean {
  if (!storage) return false;
  try {
    if (items.length === 0) storage.removeItem(LOCAL_SAVES_KEY);
    else storage.setItem(LOCAL_SAVES_KEY, JSON.stringify({ v: 1, items }));
    return true;
  } catch {
    return false;
  }
}

/** Adds a save (no-op if already there). Returns the list afterwards, or null when storage refused the write. */
export function addLocalSave(
  type: LocalSaveType,
  id: string,
  now: number = Date.now(),
  storage: Storage | null = defaultStorage()
): LocalSave[] | null {
  const current = readLocalSaves(storage);
  if (current.some((s) => s.type === type && s.id === id)) return current;
  const next = [{ type, id, savedAt: now }, ...current].slice(0, MAX_LOCAL_SAVES);
  return write(storage, next) ? next : null;
}

/** Removes a save. Returns the list afterwards, or null when storage refused the write. */
export function removeLocalSave(type: string, id: string, storage: Storage | null = defaultStorage()): LocalSave[] | null {
  const next = readLocalSaves(storage).filter((s) => !(s.type === type && s.id === id));
  return write(storage, next) ? next : null;
}

export function clearLocalSaves(storage: Storage | null = defaultStorage()): void {
  write(storage, []);
}

/**
 * Whether the "sign in to keep your saves" prompt should appear right after a
 * save that left the visitor with `countAfterSave` local saves. Only on the
 * third (never before), and not again within the cooldown of the last time it
 * was shown.
 */
export function shouldShowSavePrompt(
  countAfterSave: number,
  now: number = Date.now(),
  storage: Storage | null = defaultStorage()
): boolean {
  if (countAfterSave !== SAVE_PROMPT_AT) return false;
  if (!storage) return true;
  try {
    const raw = storage.getItem(SAVE_PROMPT_KEY);
    const at = raw ? Number(raw) : NaN;
    if (Number.isFinite(at) && now - at < SAVE_PROMPT_COOLDOWN_MS) return false;
  } catch {
    // Unreadable: show it; the cooldown is a courtesy, not a rule.
  }
  return true;
}

/** Records that the prompt was shown, starting the cooldown. */
export function markSavePromptShown(now: number = Date.now(), storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(SAVE_PROMPT_KEY, String(now));
  } catch {
    // Blocked storage: the prompt may reappear next time. Acceptable.
  }
}
