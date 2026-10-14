#!/usr/bin/env node
/**
 * weekly-metrics.mjs — Monday summary of key metrics for the last 7 days vs
 * the previous 7 days (14 days total).
 *
 * Plain Node ESM (no deps; uses global fetch). Reads NEXT_PUBLIC_SUPABASE_URL
 * and SUPABASE_SERVICE_ROLE_KEY from env. Hits PostgREST with apikey +
 * Authorization Bearer headers.
 *
 * Output: plain text with aligned columns and week-over-week deltas (+/-).
 * Supports --json flag to print JSON instead.
 *
 * Metrics:
 * - New sign-ups (profiles created_at)
 * - Saves (saved_items created_at) + top 5 saved subject_ids by count
 * - Email: new subscribers, total active, unsubscribes
 * - Email events: counts by type + open/click rates
 * - Tips/feedback: new this week, split [Feedback] vs tips, titles (max 10)
 * - Chat: rows this week + distinct user_id count
 * - Catalogue: live happenings, upcoming events
 * - Visitors (PostHog, only when POSTHOG_PERSONAL_API_KEY is set): avg daily
 *   visitors, weekly visitor range, outbound clicks, cookie-bar choices —
 *   see scripts/lib/posthog.mjs for why weekly visitors are a range
 *
 * Usage:
 *   node --env-file=.env.local scripts/weekly-metrics.mjs           # text output
 *   node --env-file=.env.local scripts/weekly-metrics.mjs --json    # JSON output
 *   node --env-file=.env.local scripts/weekly-metrics.mjs --help
 */

import { posthogClient, posthogConfig, windowSummarySql } from "./lib/posthog.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node --env-file=.env.local scripts/weekly-metrics.mjs [options]

Print a Monday summary of Fomo metrics for the last 7 days vs the previous
7 days.

Options:
  --json      Print JSON instead of aligned text.
  --help      Show this message.
`);
  process.exit(0);
}

const JSON_OUTPUT = process.argv.includes("--json");

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "[weekly-metrics] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
      "Run with: node --env-file=.env.local scripts/weekly-metrics.mjs"
  );
  process.exit(1);
}

const headers = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

async function rest(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const reqHeaders = { ...headers };
  if (opts.countExact) {
    reqHeaders["Prefer"] = "count=exact";
  }
  if (opts.range !== undefined) {
    reqHeaders["Range"] = opts.range;
  }
  const res = await fetch(url, { headers: reqHeaders });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} -> ${res.status}: ${body}`);
  }
  const text = await res.text();
  return {
    data: text ? JSON.parse(text) : [],
    contentRange: res.headers.get("content-range"),
  };
}

/**
 * Parse ISO date range for last N days (UTC).
 * Returns { startISO, endISO } for a time range.
 */
function getDateRange(startDaysAgo, endDaysAgo) {
  // UTC day boundaries; `end` is exclusive, so endDaysAgo = -1 includes today.
  const day = (offset) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString().split("T")[0];
  };
  return { startISO: day(startDaysAgo), endISO: day(endDaysAgo) };
}

/**
 * Extract count from PostgREST content-range header (e.g. "0-10/100" -> 100).
 */
function parseContentRange(contentRange) {
  if (!contentRange) return 0;
  const match = contentRange.match(/\d+-\d+\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Fetch count for a table with optional filters, using PostgREST count=exact.
 */
async function fetchCount(path) {
  const result = await rest(path, { countExact: true, range: "0-0" });
  return parseContentRange(result.contentRange);
}

// --- main -----------------------------------------------------------------

async function main() {
  const now = new Date();
  const todayISO = now.toISOString().split("T")[0];

  // Last 7 days including today (0-6 days ago) vs the 7 days before (7-13).
  const thisWeek = getDateRange(6, -1);
  const lastWeek = getDateRange(13, 6);

  const metrics = {
    generatedAt: todayISO,
    thisWeek: { start: thisWeek.startISO, end: thisWeek.endISO },
    lastWeek: { start: lastWeek.startISO, end: lastWeek.endISO },
  };

  try {
    // --- sign-ups ---
    const signupsThisWeek = await fetchCount(
      `profiles?created_at=gte.${thisWeek.startISO}&created_at=lt.${thisWeek.endISO}`
    );
    const signupsLastWeek = await fetchCount(
      `profiles?created_at=gte.${lastWeek.startISO}&created_at=lt.${lastWeek.endISO}`
    );
    metrics.signups = {
      thisWeek: signupsThisWeek,
      lastWeek: signupsLastWeek,
      delta: signupsThisWeek - signupsLastWeek,
    };
  } catch (err) {
    metrics.signups = { thisWeek: null, lastWeek: null, error: String(err.message ?? err).slice(0, 160) };
  }

  try {
    // --- saves ---
    const savesThisWeek = await fetchCount(
      `saved_items?created_at=gte.${thisWeek.startISO}&created_at=lt.${thisWeek.endISO}`
    );
    const savesLastWeek = await fetchCount(
      `saved_items?created_at=gte.${lastWeek.startISO}&created_at=lt.${lastWeek.endISO}`
    );

    // Top 5 saved items this week
    let topSaves = [];
    try {
      const result = await rest(
        `saved_items?created_at=gte.${thisWeek.startISO}&created_at=lt.${thisWeek.endISO}&select=subject_type,subject_id&order=subject_id.asc`
      );
      const data = result.data || [];

      // Count by subject_id + subject_type
      const counts = new Map();
      for (const row of data) {
        const key = `${row.subject_type}:${row.subject_id}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }

      // Sort by count desc, take top 5
      topSaves = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([key, count]) => {
          const [type, id] = key.split(":");
          return { subject_type: type, subject_id: id, count };
        });
    } catch {
      // If the query fails, just leave topSaves empty — don't error the whole metric
    }

    metrics.saves = {
      thisWeek: savesThisWeek,
      lastWeek: savesLastWeek,
      delta: savesThisWeek - savesLastWeek,
      topFive: topSaves,
    };
  } catch (err) {
    metrics.saves = { thisWeek: null, lastWeek: null, error: String(err.message ?? err).slice(0, 160) };
  }

  try {
    // --- email subscribers ---
    const emailSubsThisWeek = await fetchCount(
      `email_subscribers?created_at=gte.${thisWeek.startISO}&created_at=lt.${thisWeek.endISO}`
    );
    const emailSubsLastWeek = await fetchCount(
      `email_subscribers?created_at=gte.${lastWeek.startISO}&created_at=lt.${lastWeek.endISO}`
    );
    const totalActiveSubs = await fetchCount(`email_subscribers?unsubscribed_at=is.null`);
    const unsubsThisWeek = await fetchCount(
      `email_subscribers?unsubscribed_at=gte.${thisWeek.startISO}&unsubscribed_at=lt.${thisWeek.endISO}`
    );

    metrics.emailSubscribers = {
      newThisWeek: emailSubsThisWeek,
      newLastWeek: emailSubsLastWeek,
      newDelta: emailSubsThisWeek - emailSubsLastWeek,
      totalActive: totalActiveSubs,
      unsubsThisWeek: unsubsThisWeek,
    };
  } catch (err) {
    metrics.emailSubscribers = { error: String(err.message ?? err).slice(0, 160) };
  }

  try {
    // --- email events ---
    const eventsResult = await rest(
      `email_events?created_at=gte.${thisWeek.startISO}&created_at=lt.${thisWeek.endISO}&select=type,resend_email_id`
    );
    const events = eventsResult.data || [];

    const eventCounts = new Map();
    for (const e of events) {
      const type = e.type || "unknown";
      eventCounts.set(type, (eventCounts.get(type) || 0) + 1);
    }

    // Convert to object
    const eventsByType = {};
    for (const [type, count] of eventCounts) {
      eventsByType[type] = count;
    }

    // Calculate rates
    const delivered = eventsByType["email.delivered"] || 0;
    const opened = eventsByType["email.opened"] || 0;
    const clicked = eventsByType["email.clicked"] || 0;

    const openRate = delivered > 0 ? ((opened / delivered) * 100).toFixed(1) : 0;
    const clickRate = delivered > 0 ? ((clicked / delivered) * 100).toFixed(1) : 0;

    metrics.emailEvents = {
      eventsByType,
      openRate: parseFloat(openRate),
      clickRate: parseFloat(clickRate),
      delivered,
      opened,
      clicked,
    };
  } catch (err) {
    metrics.emailEvents = { error: String(err.message ?? err).slice(0, 160) };
  }

  try {
    // --- tips & feedback ---
    const tipsResult = await rest(
      `tips?created_at=gte.${thisWeek.startISO}&created_at=lt.${thisWeek.endISO}&select=title,status&order=created_at.desc&limit=10`
    );
    const tips = tipsResult.data || [];

    const feedbackTips = [];
    const regularTips = [];
    for (const t of tips) {
      const isFeedback = (t.title || "").startsWith("[Feedback]");
      const truncated = (t.title || "").substring(0, 80);
      if (isFeedback) {
        feedbackTips.push(truncated);
      } else {
        regularTips.push(truncated);
      }
    }

    const totalTipsThisWeek = await fetchCount(
      `tips?created_at=gte.${thisWeek.startISO}&created_at=lt.${thisWeek.endISO}`
    );
    const totalTipsLastWeek = await fetchCount(
      `tips?created_at=gte.${lastWeek.startISO}&created_at=lt.${lastWeek.endISO}`
    );

    metrics.tips = {
      totalThisWeek: totalTipsThisWeek,
      totalLastWeek: totalTipsLastWeek,
      delta: totalTipsThisWeek - totalTipsLastWeek,
      feedbackCount: feedbackTips.length,
      tipsCount: regularTips.length,
      feedback: feedbackTips,
      tips: regularTips,
    };
  } catch (err) {
    metrics.tips = { error: String(err.message ?? err).slice(0, 160) };
  }

  try {
    // --- chat ---
    const chatResult = await rest(
      `chat_messages?created_at=gte.${thisWeek.startISO}&created_at=lt.${thisWeek.endISO}&select=user_id`
    );
    const chatRows = chatResult.data || [];
    const chatRowsCount = await fetchCount(
      `chat_messages?created_at=gte.${thisWeek.startISO}&created_at=lt.${thisWeek.endISO}`
    );

    const uniqueUsers = new Set();
    for (const row of chatRows) {
      if (row.user_id) uniqueUsers.add(row.user_id);
    }

    metrics.chat = {
      messagesThisWeek: chatRowsCount,
      uniqueUsersThisWeek: uniqueUsers.size,
    };
  } catch (err) {
    metrics.chat = { error: String(err.message ?? err).slice(0, 160) };
  }

  try {
    // --- catalogue health: live happenings ---
    const liveHappenings = await fetchCount(`happenings?status=eq.live`);
    metrics.liveHappenings = liveHappenings;
  } catch {
    metrics.liveHappenings = null;
  }

  try {
    // --- catalogue health: upcoming events ---
    const nowISO = now.toISOString();
    const upcomingEvents = await fetchCount(`events?starts_at=gte.${nowISO}`);
    metrics.upcomingEvents = upcomingEvents;
  } catch {
    metrics.upcomingEvents = null;
  }

  if (posthogConfig().configured) {
    try {
      // --- visitors (PostHog) ---
      const ph = posthogClient();
      const [thisWeekVisitors] = await ph.hogql(windowSummarySql(thisWeek.startISO, thisWeek.endISO));
      const [lastWeekVisitors] = await ph.hogql(windowSummarySql(lastWeek.startISO, lastWeek.endISO));
      metrics.visitors = { thisWeek: thisWeekVisitors, lastWeek: lastWeekVisitors };
    } catch (err) {
      metrics.visitors = { error: String(err.message ?? err).slice(0, 160) };
    }
  }

  // --- output ---
  if (JSON_OUTPUT) {
    console.log(JSON.stringify(metrics, null, 2));
  } else {
    printTextReport(metrics);
  }
}

function printTextReport(m) {
  const lines = [];

  lines.push(`Fomo weekly: ${m.thisWeek.start} to ${m.thisWeek.end}`);
  lines.push("(vs previous week " + m.lastWeek.start + " to " + m.lastWeek.end + ")");
  lines.push("");

  // Table header
  lines.push(
    `${"Metric".padEnd(30)} ${"This Week".padStart(12)} ${"Last Week".padStart(12)} ${"Delta".padStart(10)}`
  );
  lines.push("-".repeat(64));

  // Visitors (PostHog)
  if (m.visitors && !m.visitors.error) {
    const t = m.visitors.thisWeek;
    const l = m.visitors.lastWeek;
    const row = (label, a, b) =>
      `${label.padEnd(30)} ${String(a ?? 0).padStart(12)} ${String(b ?? 0).padStart(12)} ${formatDelta(Math.round(((a ?? 0) - (b ?? 0)) * 10) / 10).padStart(10)}`;
    const range = (v) => `${(v.persistent_visitors ?? 0) + (v.max_daily_cookieless ?? 0)}-${(v.persistent_visitors ?? 0) + (v.sum_daily_cookieless ?? 0)}`;
    lines.push(row("Avg daily visitors", t.avg_daily_visitors, l.avg_daily_visitors));
    lines.push(`${"  Weekly visitors (range)".padEnd(30)} ${range(t).padStart(12)} ${range(l).padStart(12)}`);
    lines.push(row("  With cookie ID (exact)", t.persistent_visitors, l.persistent_visitors));
    lines.push(row("Outbound clicks", t.outbound_clicks, l.outbound_clicks));
    lines.push(row("Cookie bar: OK", t.consent_accepted, l.consent_accepted));
    lines.push(row("Cookie bar: No thanks", t.consent_declined, l.consent_declined));
  } else if (m.visitors) {
    lines.push(`Visitors (PostHog): n/a — ${m.visitors.error}`);
  }
  if (m.visitors) lines.push("");

  // Sign-ups
  if (m.signups && m.signups.thisWeek !== null) {
    const delta = formatDelta(m.signups.delta);
    lines.push(
      `${"New sign-ups".padEnd(30)} ${String(m.signups.thisWeek).padStart(12)} ${String(m.signups.lastWeek).padStart(12)} ${delta.padStart(10)}`
    );
  } else {
    lines.push(
      `${"New sign-ups".padEnd(30)} ${"n/a".padStart(12)} ${"n/a".padStart(12)} ${"n/a".padStart(10)}`
    );
  }

  // Saves
  if (m.saves && m.saves.thisWeek !== null) {
    const delta = formatDelta(m.saves.delta);
    lines.push(
      `${"Saves".padEnd(30)} ${String(m.saves.thisWeek).padStart(12)} ${String(m.saves.lastWeek).padStart(12)} ${delta.padStart(10)}`
    );
    if (m.saves.topFive && m.saves.topFive.length > 0) {
      lines.push("  Top saved items:");
      for (const item of m.saves.topFive) {
        lines.push(`    ${item.subject_type} ${item.subject_id} (${item.count}x)`);
      }
    }
  } else {
    lines.push(
      `${"Saves".padEnd(30)} ${"n/a".padStart(12)} ${"n/a".padStart(12)} ${"n/a".padStart(10)}`
    );
  }

  lines.push("");

  // Email
  lines.push("Email");
  if (m.emailSubscribers && m.emailSubscribers.newThisWeek !== undefined) {
    const newDelta = formatDelta(m.emailSubscribers.newDelta);
    lines.push(
      `${"  New subscribers".padEnd(30)} ${String(m.emailSubscribers.newThisWeek).padStart(12)} ${String(m.emailSubscribers.newLastWeek).padStart(12)} ${newDelta.padStart(10)}`
    );
    lines.push(
      `${"  Total active".padEnd(30)} ${String(m.emailSubscribers.totalActive).padStart(12)} ${"".padStart(12)} ${"".padStart(10)}`
    );
    lines.push(
      `${"  Unsubscribes this week".padEnd(30)} ${String(m.emailSubscribers.unsubsThisWeek).padStart(12)} ${"".padStart(12)} ${"".padStart(10)}`
    );
  } else {
    lines.push("  n/a");
  }

  if (m.emailEvents && !m.emailEvents.error) {
    lines.push("  Email events:");
    for (const [type, count] of Object.entries(m.emailEvents.eventsByType)) {
      lines.push(`    ${type}: ${count}`);
    }
    lines.push(
      `    Open rate: ${m.emailEvents.openRate}% (${m.emailEvents.opened}/${m.emailEvents.delivered})`
    );
    lines.push(
      `    Click rate: ${m.emailEvents.clickRate}% (${m.emailEvents.clicked}/${m.emailEvents.delivered})`
    );
  }

  lines.push("");

  // Tips
  if (m.tips && m.tips.totalThisWeek !== null) {
    const delta = formatDelta(m.tips.delta);
    lines.push(
      `${"Tips & feedback".padEnd(30)} ${String(m.tips.totalThisWeek).padStart(12)} ${String(m.tips.totalLastWeek).padStart(12)} ${delta.padStart(10)}`
    );
    if (m.tips.feedbackCount > 0) {
      lines.push(`  Feedback (${m.tips.feedbackCount}):`);
      for (const f of m.tips.feedback) {
        lines.push(`    - ${f}`);
      }
    }
    if (m.tips.tipsCount > 0) {
      lines.push(`  Tips (${m.tips.tipsCount}):`);
      for (const t of m.tips.tips) {
        lines.push(`    - ${t}`);
      }
    }
  } else {
    lines.push(
      `${"Tips & feedback".padEnd(30)} ${"n/a".padStart(12)} ${"n/a".padStart(12)} ${"n/a".padStart(10)}`
    );
  }

  lines.push("");

  // Chat
  if (m.chat && m.chat.messagesThisWeek !== undefined) {
    lines.push(
      `${"Chat messages".padEnd(30)} ${String(m.chat.messagesThisWeek).padStart(12)} ${"".padStart(12)} ${"".padStart(10)}`
    );
    lines.push(
      `${"  Unique users".padEnd(30)} ${String(m.chat.uniqueUsersThisWeek).padStart(12)} ${"".padStart(12)} ${"".padStart(10)}`
    );
  } else {
    lines.push("Chat: n/a");
  }

  lines.push("");

  // Catalogue
  lines.push("Catalogue");
  if (m.liveHappenings !== null) {
    lines.push(`${"  Live happenings".padEnd(30)} ${String(m.liveHappenings).padStart(12)}`);
  } else {
    lines.push(`${"  Live happenings".padEnd(30)} ${"n/a".padStart(12)}`);
  }
  if (m.upcomingEvents !== null) {
    lines.push(`${"  Upcoming events".padEnd(30)} ${String(m.upcomingEvents).padStart(12)}`);
  } else {
    lines.push(`${"  Upcoming events".padEnd(30)} ${"n/a".padStart(12)}`);
  }

  console.log(lines.join("\n"));
}

function formatDelta(delta) {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `${delta}`;
  return "—";
}

main().catch((err) => {
  console.error("[weekly-metrics] FAILED:", err.stack || err);
  process.exit(1);
});
