/**
 * Asks GitHub to run the daily deals workflow in `promote` mode, so an
 * approved deal goes live now rather than at the next scheduled run.
 * Same call as app/api/cron/weekly-email/route.ts: workflow_dispatch with
 * GITHUB_DISPATCH_TOKEN (fine-grained token, jasbir98/fomo only, Actions:
 * read and write).
 *
 * Never throws. The approval is already saved by the time this runs, so a
 * missing token or a failed call only means "goes live with the next daily run".
 */

export const DISPATCH_REPO = "jasbir98/fomo";
export const DISPATCH_WORKFLOW = "daily-deals.yml";
export const DISPATCH_REF = "main";

export type DispatchResult = "dispatched" | "no-token" | "failed";

export async function dispatchPromote(
  opts: { token?: string; fetchImpl?: typeof fetch; log?: (msg: string) => void } = {}
): Promise<DispatchResult> {
  const token = opts.token ?? process.env.GITHUB_DISPATCH_TOKEN ?? "";
  const log = opts.log ?? ((msg: string) => console.error(msg));
  if (!token) return "no-token";
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`https://api.github.com/repos/${DISPATCH_REPO}/actions/workflows/${DISPATCH_WORKFLOW}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: DISPATCH_REF, inputs: { mode: "promote" } }),
      cache: "no-store",
    });
    if (!res.ok) {
      log(`[review] dispatch ${DISPATCH_WORKFLOW} mode=promote -> ${res.status}`);
      return "failed";
    }
    return "dispatched";
  } catch (err) {
    log(`[review] dispatch ${DISPATCH_WORKFLOW} mode=promote threw: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}
