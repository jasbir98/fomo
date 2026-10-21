"use client";

import { useState } from "react";

const BUTTON = "rounded-full border-[1.5px] border-primary px-4 py-2 text-left text-label-md font-semibold text-primary";

/** One button per capture path: error boundary, uncaught error, unhandled rejection, server render. */
export function ErrorsClient() {
  const [renderError, setRenderError] = useState(false);
  if (renderError) throw new Error("Fomo test: client render exception");

  return (
    <main className="flex flex-col gap-3 p-6">
      <h1 className="text-headline-sm text-primary">Exception test</h1>
      <p className="text-body-md text-on-surface-variant">Each button sends one `$exception` to PostHog.</p>
      <button type="button" className={BUTTON} onClick={() => setRenderError(true)}>
        Throw in render (app/error.tsx boundary)
      </button>
      <button
        type="button"
        className={BUTTON}
        onClick={() => {
          setTimeout(() => {
            throw new TypeError("Fomo test: uncaught client exception");
          });
        }}
      >
        Throw uncaught
      </button>
      <button type="button" className={BUTTON} onClick={() => void Promise.reject(new Error("Fomo test: unhandled rejection"))}>
        Reject a promise
      </button>
      <a className={BUTTON} href="/debug/errors?throw=server">
        Throw on the server
      </a>
    </main>
  );
}
