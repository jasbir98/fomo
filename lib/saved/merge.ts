/**
 * Merge a visitor's local saves (lib/saved/local-store.ts) into their account
 * when they sign in. Pure: every side effect is injected, so the rules (skip
 * duplicates, skip items that no longer exist, keep everything on failure)
 * are unit tested without a browser or a database.
 *
 * Idempotent: the account write is an upsert and already-saved items are
 * skipped, so running it twice (two tabs, a retry after a failure) is safe.
 */
import type { LocalSave } from "./local-store";
import { localKey } from "./local-store";

export interface MergeDeps {
  /** The visitor's local saves. */
  local: readonly LocalSave[];
  /** Keys ("type:id") the account already has saved. */
  accountKeys: ReadonlySet<string>;
  /** Keys of the given saves whose item still exists. Throws if it can't tell. */
  existing: (refs: readonly LocalSave[]) => Promise<ReadonlySet<string>>;
  /** Saves one item to the account (an upsert). Throws on failure. */
  save: (ref: LocalSave) => Promise<void>;
  /** Called once everything landed; clears the local store. */
  clear: () => void;
}

export type MergeResult =
  | { status: "empty" }
  | { status: "merged"; added: LocalSave[]; skipped: number }
  | { status: "failed"; added: LocalSave[]; error: unknown };

export async function mergeLocalSaves(deps: MergeDeps): Promise<MergeResult> {
  if (deps.local.length === 0) return { status: "empty" };

  const fresh = deps.local.filter((s) => !deps.accountKeys.has(localKey(s.type, s.id)));
  const added: LocalSave[] = [];
  let skipped = deps.local.length - fresh.length;

  try {
    const alive = fresh.length > 0 ? await deps.existing(fresh) : new Set<string>();
    // Oldest first, so the account's "newest saved" order matches when they were saved.
    const todo = fresh.filter((s) => alive.has(localKey(s.type, s.id))).sort((a, b) => a.savedAt - b.savedAt);
    skipped += fresh.length - todo.length;
    for (const ref of todo) {
      await deps.save(ref);
      added.push(ref);
    }
  } catch (error) {
    // Local saves stay put; the next sign-in load tries again (the upsert makes that safe).
    return { status: "failed", added, error };
  }

  deps.clear();
  return { status: "merged", added, skipped };
}
