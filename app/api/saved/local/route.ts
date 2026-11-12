/**
 * Saved, for visitors with no account yet — GET /api/saved/local?refs=happening:ID,event:ID,place:ID
 *
 * A signed-out visitor's saves live in localStorage (lib/saved/local-store.ts),
 * so the Saved page sends the refs and gets back the same Candidate cards the
 * account list shows (lib/cards/saved-candidates.ts). The sign-in merge uses
 * it too, to find out which saved items still exist before copying them over.
 *
 * Public and read-only (proxy.ts allows this one path). It reads the same
 * catalogue rows the detail pages already serve to anyone, by id, and stores
 * nothing. Capped at 60 refs per call. Unlike /api/saved, a failure is a 500,
 * not an empty list: the merge must be able to tell "nothing exists" from
 * "couldn't check", or it would throw away saves.
 */
import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { resolveSavedCandidates } from "@/lib/cards/saved-candidates";
import { cachedJson, CACHE_PRIVATE_NO_STORE } from "@/lib/http/cache";
import { isLocalSaveType } from "@/lib/saved/local-store";

export const runtime = "nodejs";

const MAX_REFS = 60;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("refs") ?? "";
  const seen = new Set<string>();
  const refs: { subject_type: string; subject_id: string }[] = [];
  for (const part of raw.split(",")) {
    const [type, id, ...rest] = part.split(":");
    if (rest.length > 0 || !isLocalSaveType(type) || !id || !ID.test(id)) continue;
    if (seen.has(part)) continue;
    seen.add(part);
    refs.push({ subject_type: type, subject_id: id });
    if (refs.length >= MAX_REFS) break;
  }
  if (refs.length === 0) return cachedJson({ items: [] }, CACHE_PRIVATE_NO_STORE);

  try {
    const db = await supabaseServer();
    const items = await resolveSavedCandidates(db, refs);
    return cachedJson({ items }, CACHE_PRIVATE_NO_STORE);
  } catch (err) {
    console.error("[api/saved/local] failed", err);
    return cachedJson({ error: "failed" }, CACHE_PRIVATE_NO_STORE, { status: 500 });
  }
}
