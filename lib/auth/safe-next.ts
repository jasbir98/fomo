/**
 * Validate an untrusted `?next=` value before using it as a redirect
 * target. `next` rides through the whole signed-out deep-link flow as a
 * query param — `/welcome?next=...` → `/signin?next=...` →
 * `/auth/callback?next=...` (also as the OAuth `redirectTo`'s own query
 * param) → any post-sign-in setup/onboarding step → the final redirect —
 * and it's attacker-controlled at every hop, so every reader validates
 * through this one helper rather than trusting the string as-is.
 *
 * Only a same-origin relative path (optionally with a query string) is
 * honoured. Rejected, all falling back to `/`:
 * - absolute URLs (`https://evil.com`) — don't start with `/` at all
 * - protocol-relative URLs (`//evil.com`) — a leading `//` is
 *   scheme-relative, so the browser still navigates off-origin
 * - backslash-leading paths (`/\evil.com`, `/\/evil.com`) — some URL
 *   parsers (including browsers, historically) normalize a leading `\` to
 *   `/`, so this is `//evil.com` in disguise
 * - anything else that isn't `/`-prefixed (`javascript:...`, `mailto:...`,
 *   bare strings, empty, null, undefined)
 */
export function safeNext(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}
