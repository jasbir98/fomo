/**
 * Server-side `$exception` capture: a plain POST to PostHog's capture API (no
 * posthog-node, so nothing to batch or flush before a serverless function
 * freezes). Called by instrumentation.ts's `onRequestError` for every
 * uncaught server error (server components, route handlers, server actions,
 * proxy), and directly by route handlers that catch an error and answer 500.
 *
 * The browser only ever sees a server component error as "An error occurred
 * in the Server Components render" plus a `digest`; this event carries the
 * real message and stack under the same `digest`, so the two can be matched
 * up in PostHog. Server events have no visitor identity (`distinct_id`
 * "fomo-server", no person profile). Inert without NEXT_PUBLIC_POSTHOG_KEY,
 * and in dev unless NEXT_PUBLIC_POSTHOG_DEBUG=1 — same rules as the browser.
 */
import { enrichExceptionProperties, exceptionList, type ExceptionEntry } from "./exceptions";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const CAPTURE_URL = "https://eu.i.posthog.com/i/v0/e/";
const enabled =
  Boolean(POSTHOG_KEY) && (process.env.NODE_ENV !== "development" || process.env.NEXT_PUBLIC_POSTHOG_DEBUG === "1");

export interface ServerExceptionContext {
  /** Request path, query included; only the pathname is sent (queries can carry tokens). */
  path?: string;
  method?: string;
  /** The request's own headers, to read the host and whether a Supabase session cookie is present. */
  headers?: Headers | Record<string, string | string[] | undefined>;
  /** True when a route handler caught the error itself and answered 5xx. */
  handled?: boolean;
  /** Anything else worth filtering on: route, router_kind, render_source, … */
  [key: string]: unknown;
}

function header(headers: ServerExceptionContext["headers"], name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = headers[name];
  return Array.isArray(value) ? value.join("; ") : value;
}

/** Never throws, never takes longer than 3 seconds. */
export async function captureServerException(error: unknown, context: ServerExceptionContext = {}): Promise<void> {
  if (!enabled) return;
  try {
    const { path, method, headers, handled = false, ...extra } = context;
    const pathname = path?.split("?")[0];
    const host = header(headers, "x-forwarded-host") ?? header(headers, "host");
    const cookie = header(headers, "cookie") ?? "";
    const digest = (error as { digest?: unknown } | null)?.digest;

    const properties: Record<string, unknown> = {
      $exception_list: exceptionList(error, { type: handled ? "route-catch" : "onRequestError", handled }),
      $exception_level: "error",
      $process_person_profile: false,
      $lib: "fomo-server",
      ...(host && pathname ? { $current_url: `https://${host}${pathname}`, $host: host } : {}),
      $pathname: pathname,
      method,
      runtime: process.env.NEXT_RUNTIME ?? "nodejs",
      signed_in: /sb-[^=]*-auth-token/.test(cookie),
      ...(typeof digest === "string" ? { digest } : {}),
      ...extra,
    };
    enrichExceptionProperties(properties);
    if (process.env.NEXT_RUNTIME === "nodejs") {
      try {
        const { resolveServerFrames } = await import("./server-source-map");
        resolveServerFrames(properties.$exception_list as ExceptionEntry[]);
      } catch {
        // Send the chunk frames rather than nothing.
      }
    }

    await fetch(CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event: "$exception",
        distinct_id: "fomo-server",
        properties,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Telemetry must never turn one error into two.
  }
}
