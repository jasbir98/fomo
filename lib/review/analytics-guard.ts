/**
 * Keeps the review token out of analytics. The token is in the page URL and
 * is a credential for 7 days, so it must not reach any analytics store.
 *
 *   PostHog         instrumentation-client.ts does not initialise on /review/*
 *                   (isReviewPath) and drops any event whose URL is a review URL.
 *   Vercel Web Analytics and Speed Insights
 *                   are mounted in the root layout and cannot be switched off
 *                   per page there, so the review page inlines
 *                   NO_ANALYTICS_SCRIPT, which registers their documented
 *                   `beforeSend` hook early (before either script loads) and
 *                   drops every event whose URL is a review URL.
 *
 * Plain strings and functions, no imports: used by a server component, the
 * client instrumentation file and the unit test.
 */

export const REVIEW_PATH_PREFIX = "/review/";

/** True for a pathname (or full URL) that carries a review token. */
export function isReviewPath(urlOrPath: string | null | undefined): boolean {
  if (!urlOrPath) return false;
  return urlOrPath.includes(REVIEW_PATH_PREFIX);
}

/**
 * Runs in the browser before hydration. `va` / `si` are the queue functions the
 * @vercel/analytics and @vercel/speed-insights packages create (`window.va`,
 * `window.si`); defining the same queue first is what their own initQueue does,
 * and it keeps entries made before their script loads.
 */
export const NO_ANALYTICS_SCRIPT = `(function(){try{var drop=function(e){return e&&typeof e.url==="string"&&e.url.indexOf(${JSON.stringify(
  REVIEW_PATH_PREFIX
)})!==-1?null:e};["va","si"].forEach(function(n){if(!window[n]){window[n]=function(){var q=n+"q";window[q]=window[q]||[];window[q].push(Array.prototype.slice.call(arguments))}}window[n]("beforeSend",drop)})}catch(e){}})();`;
