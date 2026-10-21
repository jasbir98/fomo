/**
 * Server instrumentation (Next's `instrumentation.ts` convention; the browser
 * half is instrumentation-client.ts).
 *
 * - `register`: turns on Node's source map support, which Next's own error
 *   logs (Vercel function logs) use to print `app/…/page.tsx:line` instead of
 *   chunk offsets (maps from next.config.ts's `experimental.serverSourceMaps`).
 * - `onRequestError`: every uncaught server error (server components, route
 *   handlers, server actions, proxy) goes to PostHog as `$exception` with the
 *   route and request context. See lib/analytics/server-exception.ts.
 */
import type { Instrumentation } from "next";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") process.setSourceMapsEnabled?.(true);
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const { captureServerException } = await import("./lib/analytics/server-exception");
  await captureServerException(error, {
    path: request.path,
    method: request.method,
    headers: request.headers,
    route: context.routePath,
    router_kind: context.routerKind,
    route_type: context.routeType,
    render_source: context.renderSource,
    revalidate_reason: context.revalidateReason ?? null,
  });
};
