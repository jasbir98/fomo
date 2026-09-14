/**
 * `Database` type for the `@supabase/ssr` clients.
 *
 * There's no Supabase CLI codegen wired up in this repo — `supabase/` is a
 * folder of hand-written `.sql` files run manually via the dashboard, no
 * `supabase/config.toml`, no `supabase gen types`. Setting that up is out of
 * scope for this phase too.
 *
 * Rather than invent a large fake schema by hand-transcribing every table in
 * `supabase/*.sql` (which would drift the moment a `.sql` file changes and
 * nothing would catch it), this is intentionally loose: `Record<string,
 * never>` for `Tables`/`Views` means Supabase's generic client still
 * type-checks (`createBrowserClient<Database>` compiles), but nothing here
 * claims to know the real column shapes. Callers get real safety from
 * `lib/db/*`'s existing hand-written return types, not from this file.
 *
 * `Db` (below) deliberately does NOT parameterize `SupabaseClient` with this
 * `Database` type, precisely because it's a `Record<string, never>` stub —
 * doing so would type every `.from("table")` call's row/insert/update shape
 * as `never`, which is exactly what broke when Phase 2 (identity + RLS)
 * funneled every `lib/db/*` query through a typed `db: Db` parameter for the
 * first time (Phase 1 never actually called `.from()` through this generic,
 * so the mismatch was latent). `Database` stays exported for callers that
 * want it for other reasons, but `Db` is intentionally untyped-schema so
 * `.from(...)` behaves exactly like the old plain `createClient(url, key)`
 * (no generic) that `lib/supabase.ts` used pre-auth — permissive, relying on
 * `lib/db/*`'s hand-written return types for real safety, same as before.
 * A future pass wiring up real `supabase gen types` codegen could replace
 * this with a fully-typed `Database` and drop this workaround.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

/**
 * Shared alias every `lib/db/*` function and `lib/now/*` builder takes as
 * its first parameter, in place of the old `deviceId: string`. Callers pass
 * whichever client carries the right identity for the context:
 * `supabaseBrowserAuth()` (lib/supabase/client.ts) from client components,
 * `await supabaseServer()` (lib/supabase/server.ts) from route handlers/
 * server components — both return a client structurally compatible with
 * this type. `supabaseAdmin()` (lib/supabase/admin.ts) also satisfies `Db`
 * but is service-role and bypasses RLS entirely; only pass it where that's
 * the intent (catalog cache writes), never as a stand-in for a user's own
 * session.
 *
 * Deliberately no default value anywhere a `Db` is accepted — see
 * plan-v1.2-accounts.md §A.5. A default would let a server route silently
 * fall back to an unauthenticated client, and since these routes swallow
 * errors into a `degraded` field, that would render as permanent silent data
 * loss instead of a compile error.
 */
export type Db = SupabaseClient;
