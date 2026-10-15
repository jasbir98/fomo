/**
 * Fomo — GET /api/cron/weekly-email
 *
 * Vercel Cron (vercel.json, `0 15 * * 4`) calls this on Thursday; it asks
 * GitHub to run `.github/workflows/weekly-content.yml` with
 * `action=email-send`, which runs scripts/fomo-friday.mjs --send. The email
 * itself still sends from Actions (it needs `npm ci` and the script's own
 * env); this route only replaces Actions' `schedule` trigger, which landed
 * 4–7 hours late and broke the "Thursday by 6pm" promise. A
 * workflow_dispatch run starts within a minute or two.
 *
 * Timing: Vercel Hobby fires anywhere in the cron's hour, so 15:00–15:59 UTC
 * — 16:00–16:59 BST, 15:00–15:59 GMT — with the email a few minutes later.
 * Under 6pm in both seasons, no edit needed when the clocks change.
 *
 * Auth: Vercel sends `Authorization: Bearer $CRON_SECRET` on cron calls.
 * proxy.ts lets /api/cron through without a session; this check is the gate.
 * 503 until CRON_SECRET or GITHUB_DISPATCH_TOKEN is set, so the Vercel cron
 * log shows it failing instead of silently doing nothing.
 *
 * Env (Vercel production): CRON_SECRET, GITHUB_DISPATCH_TOKEN (fine-grained
 * token, jasbir98/fomo only, Actions: read and write). See docs/content-loop.md.
 */
import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const REPO = "jasbir98/fomo";
const WORKFLOW = "weekly-content.yml";
const REF = "main";

function isAuthorised(header: string | null, secret: string): boolean {
  const got = Buffer.from(header ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const token = process.env.GITHUB_DISPATCH_TOKEN ?? "";
  if (!secret || !token) {
    console.error("[api/cron/weekly-email] CRON_SECRET or GITHUB_DISPATCH_TOKEN not set");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  if (!isAuthorised(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: REF, inputs: { action: "email-send" } }),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[api/cron/weekly-email] dispatch -> ${res.status}: ${body}`);
    return NextResponse.json({ error: "Dispatch failed", status: res.status }, { status: 502 });
  }

  console.log("[api/cron/weekly-email] dispatched weekly-content.yml action=email-send");
  return NextResponse.json({ dispatched: true });
}
