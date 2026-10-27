import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { Db } from "./types";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!supabaseUrl || !serviceRoleKey) {
  console.warn(
    "[fomo] Missing Supabase service-role env vars. Set NEXT_PUBLIC_SUPABASE_URL " +
      "and SUPABASE_SERVICE_ROLE_KEY in .env.local (server-only, never NEXT_PUBLIC_)."
  );
}

// Deliberately NOT `createClient<Database>` (see lib/supabase/types.ts's
// `Db` doc comment) — `Database`'s `Tables: Record<string, never>` stub
// would type every `.from("table").upsert(...)` call here as `never`. `Db`
// is the same untyped-schema alias every other client in this app uses.
let adminClient: Db | undefined;

/**
 * Service-role Supabase client — bypasses RLS entirely. `server-only`
 * guards against this ever being pulled into a client bundle; the module
 * singleton is safe (unlike `lib/supabase/server.ts`) because this client
 * carries no per-user session, just a static service-role key.
 *
 * Consumers: lib/rate-limit.ts and lib/db/push.ts's per-user writes, plus
 * app/api/subscribe, app/api/unsubscribe and app/api/resend/webhook's
 * session-less writes — routes with no signed-in caller to write as.
 *
 * Also the by-id reads of hidden rows, which the live-only public RLS policies
 * (supabase/live_only_public_read.sql) no longer let anon or a session see:
 * happening/event detail (pages, metadata, API routes, .ics), the Saved list
 * (lib/cards/resolve.ts) and weekend plans (lib/plans/snapshot.ts). Use it
 * for that one query only, never for a whole request.
 */
export function supabaseAdmin(): Db {
  if (!adminClient) {
    adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return adminClient;
}
