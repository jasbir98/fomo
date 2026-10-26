import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { Db } from "./types";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

let anonClient: Db | undefined;

/**
 * Cookie-less, session-less Supabase client: always the anon role.
 *
 * For server-rendered pages that must stay statically cacheable (revalidated
 * on a timer) because they read the public catalogue only: live
 * happenings, active events, places and the feed built from them are readable
 * by anon under RLS (hidden or ended rows are not: by-id reads of those go
 * through supabaseAdmin(), see supabase/live_only_public_read.sql). `supabaseServer()` (lib/supabase/server.ts) reads cookies(), which
 * would make every such page dynamic and uncacheable.
 *
 * A module singleton is safe here, unlike `supabaseServer()`: the client
 * carries no per-user state at all. Never use it for anything personal.
 */
export function supabaseAnon(): Db {
  if (!anonClient) {
    anonClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return anonClient;
}
