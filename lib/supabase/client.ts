"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./types";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

if (!supabaseUrl || !supabaseAnonKey) {
  // Don't crash the build — surface a clear warning so the user knows to
  // paste creds into .env.local. Auth calls will fail until then.
  console.warn(
    "[fomo] Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and " +
      "NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local."
  );
}

let browserClient: ReturnType<typeof createBrowserClient<Database>> | undefined;

/**
 * Singleton browser Supabase client backed by `@supabase/ssr`'s cookie
 * storage (not localStorage) — one browser, one session, and the same
 * cookie the middleware / server client read. This is the auth-aware
 * sibling of `lib/supabase.ts`, which stays as the anon, auth-disabled
 * client every existing `lib/db/*` call still uses in this phase.
 *
 * Module-level singleton is correct *here* specifically because this file
 * only ever runs in the browser (one user, one tab) — unlike
 * `lib/supabase/server.ts`, which must never be a singleton.
 */
export function supabaseBrowserAuth() {
  if (!browserClient) {
    browserClient = createBrowserClient<Database>(supabaseUrl, supabaseAnonKey);
  }
  return browserClient;
}
