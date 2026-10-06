// Run with `npx tsx --test lib/auth/identity.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { User } from "@supabase/supabase-js";
import type { Profile } from "@/lib/types";
import { avatarUrlOf, displayNameOf, initialsOf } from "./identity";

const user = (meta: Record<string, unknown>) => ({ user_metadata: meta }) as unknown as User;
const profile = (p: Partial<Profile>) => p as Profile;

test("displayNameOf prefers the profile, then full_name, then name", () => {
  assert.equal(displayNameOf(profile({ display_name: "  Sam " }), user({ full_name: "G Name" })), "Sam");
  assert.equal(displayNameOf(profile({ display_name: null }), user({ full_name: "G Name", name: "x" })), "G Name");
  assert.equal(displayNameOf(null, user({ name: "Only Name" })), "Only Name");
  assert.equal(displayNameOf(null, user({})), null);
  assert.equal(displayNameOf(undefined, null), null);
  assert.equal(displayNameOf(profile({ display_name: "   " }), user({})), null);
});

test("avatarUrlOf prefers the upload, then avatar_url, then picture, http(s) only", () => {
  assert.equal(avatarUrlOf(profile({ avatar_url: "https://a/b.jpg" }), user({ avatar_url: "https://g/1" })), "https://a/b.jpg");
  assert.equal(avatarUrlOf(null, user({ avatar_url: "https://g/1", picture: "https://g/2" })), "https://g/1");
  assert.equal(avatarUrlOf(null, user({ picture: "https://g/2" })), "https://g/2");
  assert.equal(avatarUrlOf(null, user({ picture: "javascript:alert(1)" })), null);
  assert.equal(avatarUrlOf(null, user({ picture: 42 })), null);
  assert.equal(avatarUrlOf(null, null), null);
});

test("initialsOf", () => {
  assert.equal(initialsOf("Ada Lovelace"), "AL");
  assert.equal(initialsOf("ada"), "A");
  assert.equal(initialsOf("Mary Jane Watson"), "MW");
  assert.equal(initialsOf("jas.singh@example.com"), "JS");
  assert.equal(initialsOf("  "), "");
});
