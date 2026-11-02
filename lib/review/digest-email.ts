/**
 * The digest email: plain, one card per deal, big Approve / Reject buttons.
 * Pure (the caller supplies the signing function), so the script can dry-run
 * it and the tests can read the output. Single column, inline styles only,
 * built for a phone.
 */
import { EXPIRE_AFTER_DAYS, evidenceQuote, isUnconfirmedSource, pageUnconfirmedDetail, safeHttpUrl, topReasons, type StagedDeal } from "./digest";
import type { ReviewAction } from "./token";

export type DigestEmailInput = {
  items: StagedDeal[];
  /** Deals still waiting after expiry, whether or not they are in this email. */
  waitingTotal: number;
  /** Rows expired by this run. */
  expiredCount: number;
  /** The age limit that expiry used, in days (default EXPIRE_AFTER_DAYS), so the header states the real number. */
  maxAgeDays?: number;
  /** Origin of the site, no trailing slash. */
  baseUrl: string;
  sign: (id: string, action: ReviewAction) => string;
};

export type DigestEmail = { subject: string; html: string; text: string };

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function reviewUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/review/${token}`;
}

function headline(input: DigestEmailInput): string {
  const { items, waitingTotal, expiredCount } = input;
  const shown = items.length === waitingTotal ? "" : ` Showing the best ${items.length}.`;
  const expired = ` ${expiredCount} expired today (not reviewed within ${input.maxAgeDays ?? EXPIRE_AFTER_DAYS} days).`;
  return `${plural(waitingTotal, "deal is", "deals are")} waiting for review.${shown}${expired}`;
}

function priceLine(d: StagedDeal): string | null {
  return d.saving_label?.trim() || d.price_text?.trim() || null;
}

export function renderDigestEmail(input: DigestEmailInput): DigestEmail {
  const { items, baseUrl, sign } = input;
  const subject = `Fomo deals to review: ${items.length} today, ${input.waitingTotal} waiting`;
  const lead = headline(input);

  const cards = items.map((d, i) => {
    const approve = reviewUrl(baseUrl, sign(d.id, "approve"));
    const reject = reviewUrl(baseUrl, sign(d.id, "reject"));
    return {
      d,
      n: i + 1,
      approve,
      reject,
      price: priceLine(d),
      reasons: topReasons(d),
      quote: evidenceQuote(d),
      source: safeHttpUrl(d.source_url) ?? safeHttpUrl(d.booking_url),
      unconfirmed: isUnconfirmedSource(d),
      pageNote: pageUnconfirmedDetail(d),
    };
  });

  // --- plain text ---
  const textParts = [lead, ""];
  for (const c of cards) {
    textParts.push(`${c.n}. ${c.d.title}`);
    if (c.d.venue_name) textParts.push(`   ${c.d.venue_name}`);
    if (c.price) textParts.push(`   ${c.price}`);
    textParts.push(`   Score: ${c.d.quality_score ?? "n/a"}`);
    for (const r of c.reasons) textParts.push(`   - ${r}`);
    if (c.unconfirmed) textParts.push("   UNCONFIRMED: from social media or a newsletter, not checked against the venue's own page.");
    if (c.pageNote) textParts.push(`   SOURCE PAGE NOT CONFIRMED: we could not read it (${c.pageNote}). Open the link before approving.`);
    if (c.quote) textParts.push(`   "${c.quote}"`);
    if (c.source) textParts.push(`   Source: ${c.source}`);
    textParts.push(`   Approve: ${c.approve}`);
    textParts.push(`   Reject: ${c.reject}`);
    textParts.push("");
  }
  textParts.push("Each link opens a page that asks you to confirm. Links work for 7 days.");

  // --- html ---
  const btn = (href: string, label: string, bg: string, fg: string) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 22px;margin:0 8px 8px 0;border-radius:12px;background:${bg};color:${fg};font-weight:700;font-size:16px;text-decoration:none">${label}</a>`;

  const cardHtml = cards
    .map((c) => {
      const lines: string[] = [];
      lines.push(`<div style="font-size:18px;line-height:24px;font-weight:700;color:#0b1c30">${c.n}. ${escapeHtml(c.d.title)}</div>`);
      const meta = [c.d.venue_name, c.price].filter(Boolean).map((s) => escapeHtml(String(s)));
      if (meta.length) lines.push(`<div style="margin-top:4px;font-size:15px;color:#44474e">${meta.join(" &middot; ")}</div>`);
      lines.push(`<div style="margin-top:8px;font-size:14px;color:#1b365d;font-weight:700">Score ${escapeHtml(String(c.d.quality_score ?? "n/a"))}</div>`);
      if (c.reasons.length) {
        lines.push(
          `<ul style="margin:6px 0 0;padding-left:18px;font-size:14px;line-height:20px;color:#44474e">${c.reasons
            .map((r) => `<li>${escapeHtml(r)}</li>`)
            .join("")}</ul>`
        );
      }
      if (c.unconfirmed) {
        lines.push(
          `<div style="margin-top:8px;font-size:14px;font-weight:700;color:#c2410c">Unconfirmed: from social media or a newsletter, not checked against the venue's own page.</div>`
        );
      }
      if (c.pageNote) {
        lines.push(
          `<div style="margin-top:8px;font-size:14px;font-weight:700;color:#c2410c">Source page not confirmed: we could not read it (${escapeHtml(c.pageNote)}). Open the link before approving.</div>`
        );
      }
      if (c.quote) {
        lines.push(
          `<div style="margin-top:8px;padding-left:10px;border-left:3px solid #c4c6cf;font-size:14px;line-height:20px;color:#44474e;font-style:italic">&ldquo;${escapeHtml(c.quote)}&rdquo;</div>`
        );
      }
      if (c.source) {
        lines.push(
          `<div style="margin-top:8px;font-size:14px"><a href="${escapeHtml(c.source)}" style="color:#2c5282">View the source page</a></div>`
        );
      }
      lines.push(`<div style="margin-top:14px">${btn(c.approve, "Approve", "#1b365d", "#ffffff")}${btn(c.reject, "Reject", "#ffdad6", "#93000a")}</div>`);
      return `<div style="margin:0 0 14px;padding:16px;background:#ffffff;border-radius:16px">${lines.join("")}</div>`;
    })
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f8f9ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:20px 16px">
<div style="font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#031632">fomo</div>
<p style="margin:12px 0 18px;font-size:16px;line-height:24px;color:#0b1c30">${escapeHtml(lead)}</p>
${cardHtml}
<p style="margin:8px 0 0;font-size:13px;line-height:18px;color:#74777f">Each button opens a page that asks you to confirm, so nothing changes until you tap there. Links work for 7 days.</p>
</div></body></html>`;

  return { subject, html, text: textParts.join("\n") };
}
