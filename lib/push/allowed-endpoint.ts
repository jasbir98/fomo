/**
 * Validate a browser-supplied Web Push `endpoint` URL before it's stored in
 * `push_subscriptions` — app/api/push/subscribe/route.ts's POST is the only
 * writer. The onsale-alerts Supabase Edge Function later POSTs a payload
 * straight to whatever endpoint is on file, with no further validation, so
 * an unchecked endpoint is an SSRF vector: a caller could register any
 * URL — an internal service, a cloud metadata endpoint, an arbitrary third
 * party — and have Fomo's own server hit it on every on-sale alert run.
 *
 * Only `https:` endpoints on a small allowlist of real push services are
 * accepted. Every browser vendor uses its own fixed host(s) for the Push
 * API, so this only needs to cover the services Fomo's supported browsers
 * actually use, not "any URL a browser could theoretically send":
 *
 *   - fcm.googleapis.com                    Chrome, Edge, most Android
 *   - *.push.services.mozilla.com           Firefox (e.g. updates.push.services.mozilla.com)
 *   - *.notify.windows.com                  legacy Edge / WNS
 *   - web.push.apple.com, *.push.apple.com  Safari
 */

interface AllowedPushHost {
  /** Exact hostname match. */
  exact?: string;
  /** Hostname must end with this (dot-prefixed) suffix — a wildcard subdomain. */
  suffix?: string;
}

export const ALLOWED_PUSH_ENDPOINT_HOSTS: readonly AllowedPushHost[] = [
  { exact: "fcm.googleapis.com" },
  { suffix: ".push.services.mozilla.com" },
  { suffix: ".notify.windows.com" },
  { exact: "web.push.apple.com" },
  { suffix: ".push.apple.com" },
];

/**
 * True when `value` is an `https:` URL whose hostname matches
 * `ALLOWED_PUSH_ENDPOINT_HOSTS`. Non-string input, a malformed URL, a
 * non-https scheme, or an unrecognised host all return `false` so the
 * caller can reject with a 400 rather than store it. The hostname is
 * lower-cased before matching (`URL` already normalizes host casing, but
 * this is explicit rather than relying on that); every suffix carries its
 * own leading dot, so a host like `evilpush.apple.com` (no dot before
 * "push") does not match `.push.apple.com`.
 */
export function isAllowedPushEndpoint(value: unknown): boolean {
  if (typeof value !== "string") return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  return ALLOWED_PUSH_ENDPOINT_HOSTS.some((entry) =>
    entry.exact ? host === entry.exact : host.endsWith(entry.suffix as string)
  );
}
