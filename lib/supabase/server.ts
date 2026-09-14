import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./types";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    "[fomo] Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and " +
      "NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local."
  );
}

/**
 * Per-request Supabase server client, bound to the current request's
 * cookies via `next/headers`.
 *
 * DELIBERATELY a factory function, never a module-level singleton. A
 * singleton server client would be constructed once at module-init time
 * against whichever request happened to trigger it, then reused for every
 * subsequent request on the server — silently serving one user's session
 * to another user's concurrent request. Call `supabaseServer()` fresh,
 * inside every route handler / server component / server action that needs
 * it; never hoist the result to module scope.
 *
 * `set()` can throw when called from a Server Component (Next.js only
 * allows cookie writes from Route Handlers and Server Actions) — that's
 * caught and ignored here, matching the documented `@supabase/ssr` pattern:
 * the proxy (`proxy.ts`) is what actually refreshes the session
 * cookie on every request, so a failed write from a Server Component is
 * harmless as long as the proxy ran.
 */
export async function supabaseServer() {
  const cookieStore = await cookies();

  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — ignore, middleware handles
          // the actual refresh (see doc comment above).
        }
      },
    },
  });
}
