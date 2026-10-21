/**
 * What every `$exception` event carries beyond PostHog's defaults — shared by
 * the browser (instrumentation-client.ts's `before_send`) and the server
 * (lib/analytics/server-exception.ts). No posthog-js import, so it is safe in
 * both bundles. See docs/analytics.md, "Exceptions".
 */

/** Git commit of this build (Vercel's VERCEL_GIT_COMMIT_SHA, inlined by next.config.ts's `env`), "local" off Vercel. */
export const APP_RELEASE = process.env.APP_RELEASE || "local";
/** "production" | "preview" | "development" (Vercel's VERCEL_ENV, inlined the same way). */
export const APP_ENV = process.env.APP_ENV || "development";

/**
 * Production React only ships an error code ("Minified React error #418;
 * visit https://react.dev/errors/418?args[]=text…"), which is what every
 * issue title in PostHog showed. These are the codes worth spelling out; the
 * `%s` placeholders take the `args[]` from the URL, as react.dev does.
 */
const REACT_ERRORS: Record<string, string> = {
  "31": "Objects are not valid as a React child (found: %s)",
  "130": "Element type is invalid: expected a string or a class/function but got: %s",
  "185": "Maximum update depth exceeded (a setState loop)",
  "300": "Rendered fewer hooks than expected",
  "310": "Rendered more hooks than during the previous render",
  "418": "Hydration failed: the server-rendered %s didn't match the client",
  "419": "The server could not finish this Suspense boundary; switched to client rendering",
  "421": "A Suspense boundary received an update before it finished hydrating",
  "422": "Error while hydrating a Suspense boundary; switched to client rendering",
  "423": "Error while hydrating; React recovered by client rendering the whole root",
  "425": "Text content does not match server-rendered HTML",
  // The browser's view of a server component error; the server-side
  // $exception with the same `digest` has the real message and stack.
  "441": "A Server Components render failed (see the server event with this digest)",
};

const MINIFIED_REACT = /Minified React error #(\d+);[^?]*(\?\S*)?/;

/** `{ code, message }` for a minified React error message, else null. */
export function decodeReactError(message: string): { code: number; message: string } | null {
  const match = MINIFIED_REACT.exec(message);
  if (!match) return null;
  const [, code, query = ""] = match;
  const args = [...query.matchAll(/args(?:\[\]|%5B%5D)=([^&]*)/g)].map((m) => decodeURIComponent(m[1]));
  const template = REACT_ERRORS[code] ?? "React error";
  let i = 0;
  const text = template.replace(/%s/g, () => args[i++] || "?");
  return { code: Number(code), message: `${text} (React #${code})` };
}

/**
 * Errors that aren't ours and that we can't fix. Matched against each
 * exception's message.
 * - "Java object is gone": Facebook/Instagram's Android in-app browser
 *   calling its own JS bridge after the WebView tore it down.
 */
const NOISE = [/Error invoking postMessage: Java object is gone/];

export function isNoise(message: string): boolean {
  return NOISE.some((re) => re.test(message));
}

/** One entry of PostHog's `$exception_list` (the parts this file reads or writes). */
export interface ExceptionEntry {
  type?: string;
  value?: string;
  mechanism?: Record<string, unknown>;
  stacktrace?: { type: "raw"; frames: StackFrame[] };
}

export interface StackFrame {
  platform: string;
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

/**
 * Rewrites a `$exception` event's properties in place: decodes minified React
 * errors into readable messages (the issue title is the first entry's
 * `type: value`), and adds `app_release`, `app_env` and, for React errors,
 * `react_error_code`. Returns false if the event is noise and should be
 * dropped.
 */
export function enrichExceptionProperties(properties: Record<string, unknown>): boolean {
  const list = properties.$exception_list as ExceptionEntry[] | undefined;
  if (Array.isArray(list)) {
    if (list.some((e) => isNoise(e.value ?? ""))) return false;
    for (const entry of list) {
      const react = entry.value ? decodeReactError(entry.value) : null;
      if (!react) continue;
      entry.value = react.message;
      properties.react_error_code ??= react.code;
    }
    // PostHog's flat copies of the list, used by search and the issue list.
    properties.$exception_values = list.map((e) => e.value);
  }
  properties.app_release = APP_RELEASE;
  properties.app_env = APP_ENV;
  return true;
}

/** V8 stack line: "    at fn (file:1:2)", "    at file:1:2", "    at async fn (file:1:2)". */
const V8_FRAME = /^\s*at (?:(.+?) \((.+?):(\d+):(\d+)\)|(.+?):(\d+):(\d+))$/;

/** Parses a V8 (Node/Chrome) `error.stack` into PostHog raw frames, oldest call first as PostHog expects. */
export function parseV8Stack(stack: string | undefined, platform = "node:javascript"): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    const m = V8_FRAME.exec(line);
    if (!m) continue;
    const filename = m[2] ?? m[5];
    frames.push({
      platform,
      filename,
      function: m[1]?.replace(/^async /, "") ?? "?",
      lineno: Number(m[3] ?? m[6]),
      colno: Number(m[4] ?? m[7]),
      in_app: !filename.includes("node_modules") && !filename.startsWith("node:"),
    });
  }
  return frames.reverse();
}

/**
 * Non-Error throwables as Errors. Plain objects with a `message` (a Supabase
 * PostgrestError, say) keep it, plus their `code`; anything else is JSON.
 */
function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  const obj = value as { name?: unknown; message?: unknown; code?: unknown } | null;
  if (obj && typeof obj.message === "string") {
    const err = new Error(obj.code ? `${obj.message} (code ${String(obj.code)})` : obj.message);
    if (typeof obj.name === "string" && obj.name) err.name = obj.name;
    return err;
  }
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return new Error(text);
}

/** `$exception_list` for an error and up to three `cause`s, the way posthog-js builds it. */
export function exceptionList(error: unknown, mechanism: Record<string, unknown>): ExceptionEntry[] {
  const list: ExceptionEntry[] = [];
  let current: unknown = error;
  while (current != null && list.length < 4) {
    const err = toError(current);
    list.push({
      type: err.name || "Error",
      value: err.message,
      mechanism: { ...mechanism, synthetic: !(current instanceof Error) },
      stacktrace: { type: "raw", frames: parseV8Stack(err.stack) },
    });
    current = current instanceof Error ? current.cause : undefined;
  }
  return list;
}
