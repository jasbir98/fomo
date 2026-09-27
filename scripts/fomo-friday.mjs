#!/usr/bin/env node
/**
 * fomo-friday.mjs — the "Fomo Friday" weekly digest email.
 *
 * Renders the same weekly picks scripts/lib/weekly-picks.mjs builds (~10
 * free/cheap things this weekend + up to 5 genuine deals) as a mobile-first,
 * table-based HTML email (inline styles only — email clients strip <style>
 * blocks and ignore most CSS) plus a plain-text part, and either writes them
 * to disk for review or sends them via Resend's HTTP API.
 *
 * --dry-run (DEFAULT): writes scripts/out/fomo-friday-<date>.html and .txt,
 *   and prints the subscriber COUNT only — never an email address. Reads
 *   `email_subscribers` (unsubscribed_at is null) with the service-role key
 *   just to report that count; writes nothing to the DB.
 *
 * --send: sends via Resend (https://resend.com/docs/api-reference/emails/
 *   send-batch — batches of up to 100 recipients per request), one
 *   personalised unsubscribe link per recipient. Requires RESEND_API_KEY,
 *   FOMO_FROM_EMAIL, and SENDER_ADDRESS (UK PECR/GDPR: every marketing email
 *   needs a physical postal address) — refuses to send if any are missing.
 *
 * --to=<email>: sends a single test email to that address instead of the
 *   subscriber list (still requires RESEND_API_KEY/FOMO_FROM_EMAIL/
 *   SENDER_ADDRESS — a test send is still a real send).
 *
 * Uses the Supabase REST API directly (not @supabase/supabase-js), same
 * reasoning as scripts/sweep-happenings.mjs (that client's mandatory
 * Realtime/WebSocket init throws under plain Node 20).
 *
 * Usage:
 *   node --env-file=.env.local scripts/fomo-friday.mjs                # dry run
 *   node --env-file=.env.local scripts/fomo-friday.mjs --send         # send to every subscriber
 *   node --env-file=.env.local scripts/fomo-friday.mjs --to=me@x.com  # test send, one address
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY always;
 * RESEND_API_KEY / FOMO_FROM_EMAIL / SENDER_ADDRESS only for --send/--to.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getWeeklyPicks } from "./lib/weekly-picks.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node --env-file=.env.local scripts/fomo-friday.mjs [options]

Renders the weekly "Fomo Friday" digest (HTML + text) from live happenings/
events/deals and either writes it to scripts/out/ (dry run, default) or
sends it via Resend.

Options:
  --dry-run       Write scripts/out/fomo-friday-<date>.{html,txt}, print the
                   subscriber count only. Default when neither --dry-run nor
                   --send is given.
  --send          Send to every subscriber via Resend. Requires
                   RESEND_API_KEY, FOMO_FROM_EMAIL, SENDER_ADDRESS.
  --to=<email>    Send a single test email to this address instead of the
                   subscriber list. Still requires the same env vars.
`);
  process.exit(0);
}

const SEND = process.argv.includes("--send");
const toArg = process.argv.find((a) => a.startsWith("--to="));
const TEST_TO = toArg ? toArg.slice("--to=".length).trim() : null;
const DRY_RUN = !SEND && !TEST_TO;

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
// A bare address shows its local part ("hello") as the sender name in inboxes.
const RAW_FROM = (process.env.FOMO_FROM_EMAIL ?? "").trim();
const FOMO_FROM_EMAIL = RAW_FROM && !RAW_FROM.includes("<") ? `Fomo <${RAW_FROM}>` : RAW_FROM;
const SENDER_ADDRESS = process.env.SENDER_ADDRESS ?? "";
const FOMO_REPLY_TO = process.env.FOMO_REPLY_TO || "support@askfomo.com";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "[fomo-friday] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
      "Run with: node --env-file=.env.local scripts/fomo-friday.mjs"
  );
  process.exit(1);
}

if (!DRY_RUN) {
  const missing = [];
  if (!RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!FOMO_FROM_EMAIL) missing.push("FOMO_FROM_EMAIL");
  if (!SENDER_ADDRESS) missing.push("SENDER_ADDRESS");
  if (missing.length > 0) {
    console.error(`[fomo-friday] --send/--to refused: missing env var(s): ${missing.join(", ")}.`);
    console.error("[fomo-friday] Set them in .env.local, or run without --send/--to for a dry run.");
    process.exit(1);
  }
}

const headers = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} -> ${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

// --- date / subject ----------------------------------------------------

const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

function subjectFor(picks) {
  // Only claims what the data proves: unknown-price picks are not "cheap".
  const freeCount = picks.filter((p) => p.price === "FREE").length;
  if (freeCount === picks.length) return `${freeCount} free things to do in Edinburgh this weekend`;
  if (freeCount > 0) return `${picks.length} things to do in Edinburgh this weekend (${freeCount} free)`;
  return `${picks.length} things to do in Edinburgh this weekend`;
}

// --- HTML rendering (inline styles, table layout — email-client safe) ----

const NAVY = "#1b365d";
const FONT_STACK =
  "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function itemRowHtml(item) {
  const meta = [item.when, item.venue].filter(Boolean).map(escapeHtml).join(" · ");
  const img = item.image_url
    ? `<td width="88" style="padding:0 12px 0 0;vertical-align:top;">
         <img src="${escapeHtml(item.image_url)}" width="88" height="88" alt="" style="display:block;border-radius:8px;object-fit:cover;width:88px;height:88px;background:#eef1f6;" />
       </td>`
    : "";
  return `
  <tr>
    <td style="padding:14px 0;border-bottom:1px solid #e6e9f0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          ${img}
          <td style="vertical-align:top;">
            <a href="${escapeHtml(item.url)}" style="color:${NAVY};text-decoration:none;font-weight:700;font-size:16px;line-height:1.3;">${escapeHtml(item.title)}</a>
            <div style="color:#5b6472;font-size:13px;margin-top:4px;">${meta}</div>
          </td>
          <td width="72" style="vertical-align:top;text-align:right;white-space:nowrap;">
            ${item.price ? `<span style="display:inline-block;background:${item.price === "FREE" ? "#1e7d4c" : NAVY};color:#ffffff;font-size:12px;font-weight:700;padding:4px 8px;border-radius:999px;">${escapeHtml(item.price)}</span>` : ""}
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function renderHtml({ picks, deals, unsubscribeUrl }) {
  const pickRows = picks.map(itemRowHtml).join("\n");
  const dealRows = deals.map(itemRowHtml).join("\n");
  const dealsSection =
    deals.length > 0
      ? `
      <tr><td style="padding:28px 24px 4px;">
        <div style="font-size:12px;font-weight:800;letter-spacing:0.08em;color:${NAVY};text-transform:uppercase;">This week's deals</div>
      </td></tr>
      <tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${dealRows}</table></td></tr>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Fomo Friday</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f8;font-family:${FONT_STACK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f8;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
  <tr>
    <td style="background:${NAVY};padding:24px;text-align:center;">
      <div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:0.02em;">FOMO</div>
      <div style="color:#c7d2e3;font-size:13px;margin-top:4px;">Edinburgh, free & cheap</div>
    </td>
  </tr>
  <tr>
    <td style="padding:24px 24px 4px;">
      <div style="font-size:12px;font-weight:800;letter-spacing:0.08em;color:${NAVY};text-transform:uppercase;">This weekend</div>
    </td>
  </tr>
  <tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${pickRows}</table></td></tr>
  ${dealsSection}
  <tr>
    <td style="padding:28px 24px 8px;text-align:center;">
      <a href="https://askfomo.com/weekend" style="display:inline-block;background:${NAVY};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:999px;">See the full list</a>
    </td>
  </tr>
  <tr>
    <td style="padding:24px 24px 28px;text-align:center;color:#8b93a3;font-size:11px;line-height:1.6;">
      You're getting this because you signed up for the Fomo Friday digest at askfomo.com.<br />
      {{SENDER_ADDRESS}}<br />
      <a href="${escapeHtml(unsubscribeUrl)}" style="color:#8b93a3;text-decoration:underline;">Unsubscribe</a>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function renderText({ picks, deals, unsubscribeUrl }) {
  const lines = [];
  lines.push("FOMO FRIDAY — Edinburgh, free & cheap");
  lines.push("");
  lines.push("THIS WEEKEND");
  for (const p of picks) {
    lines.push(`- ${p.title}${p.price ? ` [${p.price}]` : ""}${p.when ? ` — ${p.when}` : ""}${p.venue ? ` — ${p.venue}` : ""}`);
    lines.push(`  ${p.url}`);
  }
  if (deals.length > 0) {
    lines.push("");
    lines.push("THIS WEEK'S DEALS");
    for (const d of deals) {
      lines.push(`- ${d.title}${d.price ? ` [${d.price}]` : ""}${d.venue ? ` — ${d.venue}` : ""}`);
      lines.push(`  ${d.url}`);
    }
  }
  lines.push("");
  lines.push("Full list: https://askfomo.com/weekend");
  lines.push("");
  lines.push("You're getting this because you signed up for the Fomo Friday digest at askfomo.com.");
  lines.push("{{SENDER_ADDRESS}}");
  lines.push(`Unsubscribe: ${unsubscribeUrl}`);
  return lines.join("\n");
}

// --- Resend send ---------------------------------------------------------

async function resendSendBatch(messages) {
  const res = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(messages),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend batch send -> ${res.status}: ${body}`);
  }
  return res.json();
}

function buildMessage({ to, subject, html, text }) {
  return {
    from: FOMO_FROM_EMAIL,
    reply_to: FOMO_REPLY_TO,
    to: [to],
    subject,
    html,
    text,
    headers: {
      "List-Unsubscribe": `<${html.match(/href="([^"]*unsubscribe[^"]*)"/i)?.[1] ?? "https://askfomo.com/unsubscribe"}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

// --- main -----------------------------------------------------------------

async function main() {
  const { picks, deals, window, excludedEndedDeals, counts } = await getWeeklyPicks({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
  });

  if (picks.length === 0) {
    console.error("[fomo-friday] No picks found for the window — refusing to render an empty digest.");
    process.exit(1);
  }

  const subject = subjectFor(picks);
  console.log(`[fomo-friday] Window: ${window.fridayDayDate} 17:00 -> ${window.sundayDayDate} 23:59 Europe/London`);
  console.log(
    `[fomo-friday] Picks: ${picks.length} (${counts.datedFromHappenings} dated happenings, ` +
      `${counts.datedFromEvents} dated events, ${counts.evergreen} evergreen), deals: ${deals.length}`
  );
  console.log(`[fomo-friday] Subject: ${subject}`);
  if (excludedEndedDeals.length > 0) {
    console.log(`[fomo-friday] Excluded ${excludedEndedDeals.length} deal(s) as ended (data to clean up):`);
    for (const d of excludedEndedDeals) console.log(`[fomo-friday]   - ${d.title}: ${d.reason}`);
  }

  if (TEST_TO) {
    console.log(`[fomo-friday] --to=${TEST_TO}: test send`);
  } else if (SEND) {
    const subscribers = await rest(`email_subscribers?unsubscribed_at=is.null&select=email,unsubscribe_token`);
    console.log(`[fomo-friday] Subscribers: ${subscribers.length}`);
    if (subscribers.length === 0) {
      console.log("[fomo-friday] No subscribers — nothing to send.");
      return;
    }
    const BATCH_SIZE = 100;
    let sent = 0;
    for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
      const batch = subscribers.slice(i, i + BATCH_SIZE);
      const messages = batch.map((s) => {
        const unsubscribeUrl = `https://askfomo.com/unsubscribe?token=${s.unsubscribe_token}`;
        const html = renderHtml({ picks, deals, unsubscribeUrl }).replace(/\{\{SENDER_ADDRESS\}\}/g, SENDER_ADDRESS);
        const text = renderText({ picks, deals, unsubscribeUrl }).replace(/\{\{SENDER_ADDRESS\}\}/g, SENDER_ADDRESS);
        return buildMessage({ to: s.email, subject, html, text });
      });
      await resendSendBatch(messages);
      sent += batch.length;
      console.log(`[fomo-friday] Sent batch ${i / BATCH_SIZE + 1}: ${sent}/${subscribers.length}`);
    }
    console.log(`[fomo-friday] Done. Sent to ${sent} subscribers.`);
    return;
  } else {
    // --dry-run: report subscriber count only (never emails).
    const subscribers = await rest(`email_subscribers?unsubscribed_at=is.null&select=id`);
    console.log(`[fomo-friday] Subscriber count (unsubscribed_at is null): ${subscribers.length}`);
  }

  // Preview unsubscribe link uses a placeholder token in dry-run/test mode
  // — never a real subscriber's token unless actually sending to them.
  const previewUnsubscribeUrl = "https://askfomo.com/unsubscribe?token=00000000-0000-0000-0000-000000000000";
  const html = renderHtml({ picks, deals, unsubscribeUrl: previewUnsubscribeUrl });
  const text = renderText({ picks, deals, unsubscribeUrl: previewUnsubscribeUrl });

  if (DRY_RUN) {
    const outDir = path.join(process.cwd(), "scripts", "out");
    await mkdir(outDir, { recursive: true });
    const htmlPath = path.join(outDir, `fomo-friday-${todayIso}.html`);
    const textPath = path.join(outDir, `fomo-friday-${todayIso}.txt`);
    await writeFile(htmlPath, html.replace(/\{\{SENDER_ADDRESS\}\}/g, SENDER_ADDRESS || "{{SENDER_ADDRESS — set SENDER_ADDRESS env var}}"), "utf8");
    await writeFile(textPath, text.replace(/\{\{SENDER_ADDRESS\}\}/g, SENDER_ADDRESS || "{{SENDER_ADDRESS — set SENDER_ADDRESS env var}}"), "utf8");
    console.log(`[fomo-friday] Wrote ${htmlPath}`);
    console.log(`[fomo-friday] Wrote ${textPath}`);
    if (!SENDER_ADDRESS) {
      console.warn(
        "[fomo-friday] SENDER_ADDRESS is not set — UK PECR/GDPR requires a physical postal address in every " +
          "marketing email. The dry-run output has a placeholder; --send will refuse to run without it."
      );
    }
    return;
  }

  if (TEST_TO) {
    const message = buildMessage({
      to: TEST_TO,
      subject,
      html: html.replace(/\{\{SENDER_ADDRESS\}\}/g, SENDER_ADDRESS),
      text: text.replace(/\{\{SENDER_ADDRESS\}\}/g, SENDER_ADDRESS),
    });
    await resendSendBatch([message]);
    console.log(`[fomo-friday] Test email sent to ${TEST_TO}`);
  }
}

main().catch((err) => {
  console.error("[fomo-friday] FAILED:", err.stack || err);
  process.exit(1);
});
