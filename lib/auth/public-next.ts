import { safeNext } from "./safe-next";

/**
 * Mirrors proxy.ts's `SIGNED_IN_PAGE_PREFIXES` — duplicated here rather than
 * imported so this stays a plain client-safe module with no edge/server-only
 * surface (proxy.ts runs at the edge; this runs in the browser). Keep the
 * two lists in sync if an account-gated route is added or removed.
 *
 * Used only to decide where /signin's "Not now — keep browsing" button
 * should land: back on `next` if a signed-out visitor
 * can actually see that page, else Home — never back onto the very page
 * that would just bounce them here again.
 */
const ACCOUNT_GATED_PREFIXES = ["/profile"];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** `next` (sanitized through `safeNext`) if a signed-out visitor can actually browse it, else `"/"`. */
export function publicNextOrHome(next: string | null | undefined): string {
  const safe = safeNext(next);
  if (safe === "/") return "/";
  const pathOnly = safe.split("?")[0] ?? safe;
  return ACCOUNT_GATED_PREFIXES.some((prefix) => matchesPrefix(pathOnly, prefix)) ? "/" : safe;
}
