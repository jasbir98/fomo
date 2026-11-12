// Run: npx tsx --test lib/saved/local-store.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_SAVES_KEY,
  SAVE_PROMPT_COOLDOWN_MS,
  addLocalSave,
  clearLocalSaves,
  markSavePromptShown,
  readLocalSaves,
  removeLocalSave,
  shouldShowSavePrompt,
} from "./local-store";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

class ThrowingStorage extends MemoryStorage {
  getItem(): string | null {
    throw new Error("blocked");
  }
  setItem(): void {
    throw new Error("blocked");
  }
}

test("adds, reads newest first, and ignores duplicates", () => {
  const s = new MemoryStorage();
  addLocalSave("happening", "a", 100, s);
  addLocalSave("event", "b", 200, s);
  addLocalSave("happening", "a", 300, s);
  assert.deepEqual(
    readLocalSaves(s).map((x) => `${x.type}:${x.id}`),
    ["event:b", "happening:a"]
  );
  assert.equal(readLocalSaves(s).find((x) => x.id === "a")?.savedAt, 100);
});

test("removes one save and clears the key when empty", () => {
  const s = new MemoryStorage();
  addLocalSave("place", "p", 1, s);
  addLocalSave("place", "q", 2, s);
  removeLocalSave("place", "p", s);
  assert.equal(readLocalSaves(s).length, 1);
  removeLocalSave("place", "q", s);
  assert.equal(s.getItem(LOCAL_SAVES_KEY), null);
  addLocalSave("place", "p", 1, s);
  clearLocalSaves(s);
  assert.deepEqual(readLocalSaves(s), []);
});

test("corrupt or foreign data reads as empty, bad rows are dropped", () => {
  const s = new MemoryStorage();
  s.setItem(LOCAL_SAVES_KEY, "{not json");
  assert.deepEqual(readLocalSaves(s), []);
  s.setItem(
    LOCAL_SAVES_KEY,
    JSON.stringify({
      v: 1,
      items: [
        { type: "happening", id: "ok", savedAt: 5 },
        { type: "reel", id: "removed-kind", savedAt: 5 },
        { type: "event", id: "", savedAt: 5 },
        { type: "event", id: "ok2" },
        { type: "happening", id: "ok", savedAt: 9 },
        null,
      ],
    })
  );
  assert.deepEqual(
    readLocalSaves(s).map((x) => x.id).sort(),
    ["ok", "ok2"]
  );
});

test("blocked storage never throws", () => {
  const s = new ThrowingStorage();
  assert.deepEqual(readLocalSaves(s), []);
  assert.equal(addLocalSave("event", "x", 1, s), null);
  assert.equal(shouldShowSavePrompt(3, 1, s), true);
  markSavePromptShown(1, s);
  assert.deepEqual(readLocalSaves(null), []);
  assert.equal(addLocalSave("event", "x", 1, null), null);
});

test("prompt shows on exactly the third save, once per cooldown", () => {
  const s = new MemoryStorage();
  const t0 = 1_000_000;
  assert.equal(shouldShowSavePrompt(1, t0, s), false);
  assert.equal(shouldShowSavePrompt(2, t0, s), false);
  assert.equal(shouldShowSavePrompt(3, t0, s), true);
  assert.equal(shouldShowSavePrompt(4, t0, s), false);
  markSavePromptShown(t0, s);
  assert.equal(shouldShowSavePrompt(3, t0 + 1000, s), false);
  assert.equal(shouldShowSavePrompt(3, t0 + SAVE_PROMPT_COOLDOWN_MS - 1, s), false);
  assert.equal(shouldShowSavePrompt(3, t0 + SAVE_PROMPT_COOLDOWN_MS + 1, s), true);
});
