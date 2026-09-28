/**
 * Validate an untrusted `?next=` value before using it as a redirect
 * target. `next` rides through the whole signed-out deep-link flow as a
 * query param — `/welcome?next=...` → `/signin?next=...` →
 * `/auth/callback?next=...` (also as the OAuth `redirectTo`'s own query
 * param) → any post-sign-in setup/onboarding step → the final redirect —
 * and it's attacker-controlled at every hop, so every reader validates
 * through this one helper rather than trusting the string as-is.
 *
 * Only a same-origin relative path (optionally with a query string/hash) is
 * honoured. Rejected, all falling back to `/`:
 * - absolute URLs (`https://evil.com`) and anything else that isn't
 *   `/`-prefixed (`javascript:...`, `mailto:...`, bare strings, empty,
 *   null, undefined)
 * - protocol-relative URLs (`//evil.com`) — a leading `//` is
 *   scheme-relative, so the browser still navigates off-origin
 * - anything containing a raw backslash, or a `%5C` etc. that *decodes* to
 *   one (`/\evil.com`, `/%5C/evil.com`) — some URL parsers (including
 *   browsers, historically) normalize a leading `\` to `/`, so this is
 *   `//evil.com` in disguise
 * - anything containing a raw ASCII control character (tab, CR, LF, ...),
 *   or a percent-encoding that decodes to one (`/%09/evil.com`,
 *   `/%0a/evil.com`, `/%0d/evil.com`) — browsers strip these while parsing
 *   a URL, so `/\t/evil.com` also becomes `//evil.com` in disguise
 * - anything that decodes to a leading `//` (`/%2F/evil.com`) for the same
 *   scheme-relative reason as the raw case above
 * - a malformed percent-encoding that fails to decode at all
 *
 * As a final check (after the above), the value is resolved against a
 * fixed dummy origin with the platform's own `URL` parser and the
 * resulting origin is required to still match that dummy origin — this
 * catches anything the manual checks above missed. Only the
 * pathname+search+hash survive; the origin itself is never reused.
 */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export function safeNext(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("\\") || CONTROL_CHAR_RE.test(value)) return "/";

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "/";
  }
  if (
    decoded.includes("\\") ||
    CONTROL_CHAR_RE.test(decoded) ||
    decoded.startsWith("//")
  ) {
    return "/";
  }

  try {
    const u = new URL(value, "https://fomo.invalid");
    if (u.origin !== "https://fomo.invalid") return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}
