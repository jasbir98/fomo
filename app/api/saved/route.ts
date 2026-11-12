/**
 * Fomo Saved — GET /api/saved?limit=&offset=
 *   Identity comes from the session cookie, not a query param — see
 *   plan-v1.2-accounts.md §A.5. No session -> immediate `degraded:
 *   "unauthorized"`, never a silent empty response.
 *   limit:  default 24, max 60.
 *   offset: default 0 — pagination for lib/useInfiniteList.ts, driving
 *           app/(shell)/saved/page.tsx.
 *
 * Reads one page of saved_items (user-scoped via RLS, NOT trip-scoped — see
 * lib/db/saved.ts's listSavedItemsPage doc comment), then resolves each row
 * into the same Candidate shape (lib/cards/types.ts) by direct id lookup
 * against places/events/happenings.
 *
 * A saved subject whose row was since deleted, or whose subject_type is one
 * of the removed kinds ("reel"/"experience"/"itinerary_item"/"practicality"
 * — the 2026-09 cleanup dropped their features and
 * supabase/archive/drop_legacy.sql deleted their rows), is silently dropped
 * rather than rendered broken. That can make a resolved page shorter than
 * the underlying saved_items page, which can make lib/useInfiniteList.ts's
 * `rows.length >= pageSize` hasMore heuristic stop one page early — an
 * accepted best-effort limitation, not a bug to chase down here.
 */
import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { listSavedItemsPage } from "@/lib/db/saved";
import { resolveSavedCandidates } from "@/lib/cards/saved-candidates";
import type { Candidate } from "@/lib/cards/types";
import { isUnauthorizedError } from "@/lib/supabase-error";
import { cachedJson, CACHE_PRIVATE_NO_STORE } from "@/lib/http/cache";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

interface SavedResponse {
  items: Candidate[];
  /**
   * Absent in the normal (including empty-list) case — only set when the
   * caller has no session, or the catch below positively identifies an auth
   * denial, so existing callers that only check `items.length` keep working
   * unchanged.
   */
  degraded?: "unauthorized";
}

export async function GET(request: Request) {
  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    return cachedJson<SavedResponse>({ items: [], degraded: "unauthorized" }, CACHE_PRIVATE_NO_STORE);
  }

  const { searchParams } = new URL(request.url);

  // Same null-vs-0 guard used across this app's GET routes — searchParams.get
  // is null when absent, and Number(null) is 0, which Number.isFinite treats
  // as real, so the raw string must be null-checked before converting.
  const rawLimitParam = searchParams.get("limit");
  const rawLimit = rawLimitParam == null ? NaN : Number(rawLimitParam);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT) : DEFAULT_LIMIT;

  const rawOffsetParam = searchParams.get("offset");
  const rawOffset = rawOffsetParam == null ? NaN : Number(rawOffsetParam);
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;

  try {
    const saved = await listSavedItemsPage(db, { limit, offset });
    const items = await resolveSavedCandidates(db, saved);
    return cachedJson<SavedResponse>({ items }, CACHE_PRIVATE_NO_STORE);
  } catch (err) {
    console.error("[api/saved] failed", err);
    return cachedJson<SavedResponse>(
      isUnauthorizedError(err) ? { items: [], degraded: "unauthorized" } : { items: [] },
      CACHE_PRIVATE_NO_STORE
    );
  }
}
