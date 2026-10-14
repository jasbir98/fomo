#!/usr/bin/env node
/**
 * posthog-dashboards.mjs — keeps the PostHog dashboard (default 980079) in
 * line with how visitors are actually counted (see scripts/lib/posthog.mjs
 * and instrumentation-client.ts): exact daily numbers, a weekly range,
 * retention/stickiness only for visitors with a persistent (consented) ID.
 *
 * Idempotent. Every insight below is matched to an existing tile on the
 * dashboard by name (or one of its `replaces` names) and PATCHed in place,
 * keeping its ID; missing ones are created. Before anything is written,
 * every query is run once against /query to prove it's valid.
 *
 * Also: sets the project's test-account filters (only askfomo.com traffic —
 * previews, staging and localhost all share the same project key), and with
 * --since adds an annotation + dashboard date floor at the day cookieless
 * counting went live (data before it is inflated: every page load was a new
 * "user").
 *
 * Usage:
 *   node --env-file=.env.local scripts/posthog-dashboards.mjs --dump        # print current tiles + queries
 *   node --env-file=.env.local scripts/posthog-dashboards.mjs --dry-run     # validate queries, print the plan
 *   node --env-file=.env.local scripts/posthog-dashboards.mjs               # apply
 *   node --env-file=.env.local scripts/posthog-dashboards.mjs --since 2026-10-15 --remove-unmanaged
 *
 * Options:
 *   --dashboard <id>      Dashboard to manage (default 980079).
 *   --since YYYY-MM-DD    Annotate + set the dashboard's default date range from this day.
 *   --remove-unmanaged    Take tiles this script doesn't manage off the dashboard
 *                         (the insights themselves are kept, never deleted).
 */

import { posthogClient, weeklyVisitorsSql, consentShareSql } from "./lib/posthog.mjs";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node --env-file=.env.local scripts/posthog-dashboards.mjs [options]

Keeps PostHog dashboard 980079 in line with how Fomo counts visitors.

Options:
  --dump                Print the dashboard's current tiles and queries, change nothing.
  --dry-run             Validate every query and print what would change.
  --dashboard <id>      Dashboard to manage (default 980079).
  --since YYYY-MM-DD    Annotate + set the dashboard's date floor at this day.
  --remove-unmanaged    Take unmanaged tiles off the dashboard (insights kept).
  --help                Show this message.
`);
  process.exit(0);
}

const DUMP = process.argv.includes("--dump");
const DRY_RUN = process.argv.includes("--dry-run");
const REMOVE_UNMANAGED = process.argv.includes("--remove-unmanaged");
const DASHBOARD_ID = Number(arg("--dashboard") ?? 980079);
const SINCE = arg("--since");
if (SINCE && !/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) {
  console.error("--since must be YYYY-MM-DD");
  process.exit(1);
}

const MANAGED = "[managed by scripts/posthog-dashboards.mjs]";
const SITE_HOSTS = ["askfomo.com", "www.askfomo.com"];
const ANNOTATION = "Cookieless counting on: visitor numbers before this are inflated (every page load was a new user)";

// --- insight definitions ---------------------------------------------------

const ev = (event, extra = {}) => ({ kind: "EventsNode", event, name: event, ...extra });
const prop = (key, value, operator = "exact") =>
  operator === "is_not_set" || operator === "is_set"
    ? { key, type: "event", operator }
    : { key, type: "event", value: Array.isArray(value) ? value : [value], operator };
const GRANTED = prop("consent_status", "granted");
const trends = (source) => ({
  kind: "InsightVizNode",
  source: { kind: "TrendsQuery", filterTestAccounts: true, interval: "day", dateRange: { date_from: "-30d" }, ...source },
});
const hogqlTable = (query) => ({
  kind: "DataVisualizationNode",
  source: { kind: "HogQLQuery", query, filters: { filterTestAccounts: true } },
  display: "ActionsTable",
});

/** `replaces`: names of existing tiles this insight takes over (case-insensitive), so it's fixed in place. */
const INSIGHTS = [
  {
    name: "Daily visitors",
    description:
      "Unique visitors per day, split by consent_status. Exact: cookie visitors (granted) by ID, everyone else by PostHog's daily hash.",
    replaces: ["Daily active users (DAUs)"],
    query: trends({
      series: [ev("$pageview", { math: "dau" })],
      breakdownFilter: { breakdown: "consent_status", breakdown_type: "event" },
      trendsFilter: { display: "ActionsBar" },
    }),
  },
  {
    name: "Daily visitors (7-day average)",
    description: "Same as Daily visitors, smoothed over 7 days. The headline traffic number.",
    replaces: [],
    query: trends({
      series: [ev("$pageview", { math: "dau" })],
      trendsFilter: { display: "ActionsLineGraph", smoothingIntervals: 7 },
    }),
  },
  {
    name: "Weekly visitors (range)",
    description:
      "Cookieless visitors get a new ID each day, so weekly uniques are a range: low = persistent + busiest day's cookieless, high = persistent + sum of every day's cookieless. persistent_visitors is exact.",
    replaces: ["Weekly active users (WAUs)"],
    query: hogqlTable(weeklyVisitorsSql(8)),
  },
  {
    name: "Cookie bar choices",
    description: "consent_choice events by choice, weekly. Visitors who never answer don't appear here — see 'Visitors with a cookie ID'.",
    replaces: [],
    query: trends({
      series: [ev("consent_choice")],
      interval: "week",
      dateRange: { date_from: "-8w" },
      breakdownFilter: { breakdown: "choice", breakdown_type: "event" },
      trendsFilter: { display: "ActionsBar" },
    }),
  },
  {
    name: "Visitors with a cookie ID (%)",
    description:
      "Share of each day's visitors who tapped OK (persistent ID). Retention, stickiness and session numbers only cover this group.",
    replaces: [],
    query: hogqlTable(consentShareSql(30)),
  },
  {
    name: "Signed-in visitors",
    description: "Daily unique visitors who are signed in (signed_in super property). Account totals live in Supabase (weekly-metrics.mjs).",
    replaces: [],
    query: trends({
      series: [ev("$pageview", { math: "dau", properties: [prop("signed_in", "true")] })],
      trendsFilter: { display: "ActionsLineGraph" },
    }),
  },
  {
    name: "New sign-ups",
    description: "signin_completed with is_new_user = true, weekly.",
    replaces: [],
    query: trends({
      series: [ev("signin_completed", { properties: [prop("is_new_user", "true")] })],
      interval: "week",
      dateRange: { date_from: "-8w" },
      trendsFilter: { display: "ActionsBar" },
    }),
  },
  {
    name: "Key funnel (same day)",
    description:
      "Pageview → card opened → outbound click within one day. One-day window because cookieless visitors' IDs only last a day.",
    replaces: ["Pageview → card_opened → outbound_clicked user conversion rate"],
    query: {
      kind: "InsightVizNode",
      source: {
        kind: "FunnelsQuery",
        filterTestAccounts: true,
        dateRange: { date_from: "-30d" },
        series: [ev("$pageview"), ev("card_opened"), ev("outbound_clicked")],
        funnelsFilter: { funnelWindowInterval: 1, funnelWindowIntervalUnit: "day", funnelVizType: "steps" },
      },
    },
  },
  {
    name: "Key funnel by source (same day)",
    description: "The key funnel broken down by utm_source.",
    replaces: [],
    query: {
      kind: "InsightVizNode",
      source: {
        kind: "FunnelsQuery",
        filterTestAccounts: true,
        dateRange: { date_from: "-30d" },
        series: [ev("$pageview"), ev("card_opened"), ev("outbound_clicked")],
        breakdownFilter: { breakdown: "utm_source", breakdown_type: "event" },
        funnelsFilter: { funnelWindowInterval: 1, funnelWindowIntervalUnit: "day", funnelVizType: "steps" },
      },
    },
  },
  {
    name: "Outbound clicks per visitor",
    description: "outbound_clicked ÷ daily visitors, 7-day smoothed. The key metric, per visitor.",
    replaces: [],
    query: trends({
      series: [ev("outbound_clicked"), ev("$pageview", { math: "dau" })],
      trendsFilter: { display: "ActionsLineGraph", formula: "A / B", smoothingIntervals: 7 },
    }),
  },
  {
    name: "Outbound clicks by host",
    description: "Where Fomo sends people, last 30 days.",
    replaces: [],
    query: trends({
      series: [ev("outbound_clicked")],
      breakdownFilter: { breakdown: "host", breakdown_type: "event", breakdown_limit: 15 },
      trendsFilter: { display: "ActionsBarValue" },
    }),
  },
  {
    name: "Saves + shares per visitor",
    description: "(save_added + share_completed) ÷ daily visitors, 7-day smoothed.",
    replaces: [],
    query: trends({
      series: [ev("save_added"), ev("share_completed"), ev("$pageview", { math: "dau" })],
      trendsFilter: { display: "ActionsLineGraph", formula: "(A + B) / C", smoothingIntervals: 7 },
    }),
  },
  {
    name: "Visitors by referrer",
    description: "Daily visitors by referring domain ($direct = typed/bookmarked/in-app).",
    replaces: ["Referring domain (last 14 days)"],
    query: trends({
      series: [ev("$pageview", { math: "dau" })],
      breakdownFilter: { breakdown: "$referring_domain", breakdown_type: "event", breakdown_limit: 8 },
      trendsFilter: { display: "ActionsBar" },
    }),
  },
  {
    name: "Visitors by utm_source",
    description: "Daily visitors arriving with a utm_source (campaign links).",
    replaces: [],
    query: trends({
      series: [ev("$pageview", { math: "dau", properties: [prop("utm_source", null, "is_set")] })],
      breakdownFilter: { breakdown: "utm_source", breakdown_type: "event" },
      trendsFilter: { display: "ActionsBar" },
    }),
  },
  {
    name: "Top pages",
    description: "Pageviews by path, last 30 days.",
    replaces: [],
    query: trends({
      series: [ev("$pageview")],
      breakdownFilter: { breakdown: "$pathname", breakdown_type: "event", breakdown_limit: 15 },
      trendsFilter: { display: "ActionsBarValue" },
    }),
  },
  {
    name: "PWA installs",
    description: "pwa_installed, weekly.",
    replaces: [],
    query: trends({
      series: [ev("pwa_installed")],
      interval: "week",
      dateRange: { date_from: "-8w" },
      trendsFilter: { display: "ActionsBar" },
    }),
  },
  {
    name: "Retention (cookie visitors)",
    description:
      "Weekly return rate for visitors who tapped OK (persistent ID). Cookieless visitors can't be followed across days, so they're excluded.",
    replaces: ["Retention"],
    query: {
      kind: "InsightVizNode",
      source: {
        kind: "RetentionQuery",
        filterTestAccounts: true,
        dateRange: { date_from: "-8w" },
        properties: [GRANTED],
        retentionFilter: {
          targetEntity: { id: "$pageview", type: "events", name: "$pageview" },
          returningEntity: { id: "$pageview", type: "events", name: "$pageview" },
          period: "Week",
          totalIntervals: 8,
          retentionType: "retention_first_time",
        },
      },
    },
  },
  {
    name: "Retention on outbound clicks (cookie visitors)",
    description: "Weekly: of cookie visitors who clicked out, how many click out again in later weeks.",
    replaces: [],
    query: {
      kind: "InsightVizNode",
      source: {
        kind: "RetentionQuery",
        filterTestAccounts: true,
        dateRange: { date_from: "-8w" },
        properties: [GRANTED],
        retentionFilter: {
          targetEntity: { id: "outbound_clicked", type: "events", name: "outbound_clicked" },
          returningEntity: { id: "outbound_clicked", type: "events", name: "outbound_clicked" },
          period: "Week",
          totalIntervals: 8,
          retentionType: "retention_first_time",
        },
      },
    },
  },
  {
    name: "Growth accounting (cookie visitors)",
    description:
      "New / returning / resurrecting / dormant each week, for visitors with a persistent ID. Cookieless visitors would all look new every day.",
    replaces: ["Growth accounting"],
    query: {
      kind: "InsightVizNode",
      source: {
        kind: "LifecycleQuery",
        filterTestAccounts: true,
        dateRange: { date_from: "-8w" },
        interval: "week",
        properties: [GRANTED],
        series: [ev("$pageview")],
      },
    },
  },
  {
    name: "Stickiness (cookie visitors)",
    description: "Days active in the last 30, for visitors with a persistent ID only.",
    replaces: [],
    query: {
      kind: "InsightVizNode",
      source: {
        kind: "StickinessQuery",
        filterTestAccounts: true,
        dateRange: { date_from: "-30d" },
        interval: "day",
        properties: [GRANTED],
        series: [ev("$pageview")],
      },
    },
  },
  {
    name: "Median session length (cookie visitors)",
    description: "Median session duration for visitors with a persistent ID — cookieless visits have no session ID.",
    replaces: [],
    query: trends({
      series: [ev("$pageview", { math: "median", math_property: "$session_duration", math_property_type: "session_properties" })],
      properties: [GRANTED],
      interval: "week",
      dateRange: { date_from: "-8w" },
      trendsFilter: { display: "ActionsLineGraph" },
    }),
  },
];

// --- helpers -----------------------------------------------------------------

const norm = (s) => (s ?? "").trim().toLowerCase();
const sourceOf = (query) => query.source ?? query;

async function validate(ph, def) {
  try {
    await ph.query(sourceOf(def.query), `validate: ${def.name}`);
    return null;
  } catch (err) {
    return String(err.message ?? err);
  }
}

async function ensureTestAccountFilters(ph) {
  const project = await ph.api("GET", "");
  const filters = project.test_account_filters ?? [];
  const hasHost = filters.some((f) => f.key === "$host");
  if (hasHost && project.test_account_filters_default_checked) {
    console.log("Test-account filters: already set");
    return;
  }
  const next = hasHost ? filters : [...filters, { key: "$host", type: "event", value: SITE_HOSTS, operator: "exact" }];
  console.log(`Test-account filters: ${hasHost ? "" : `add $host = ${SITE_HOSTS.join(" | ")}; `}default on`);
  if (!DRY_RUN) await ph.api("PATCH", "", { test_account_filters: next, test_account_filters_default_checked: true });
}

async function ensureSince(ph, dashboard) {
  if (!SINCE) return;
  const existing = await ph.api("GET", `annotations/?search=${encodeURIComponent("Cookieless counting on")}`);
  if ((existing.results ?? []).length) {
    console.log("Annotation: already exists");
  } else {
    console.log(`Annotation: add at ${SINCE}`);
    if (!DRY_RUN) {
      await ph.api("POST", "annotations/", { content: ANNOTATION, date_marker: `${SINCE}T00:00:00Z`, scope: "project" });
    }
  }
  if (dashboard.filters?.date_from === SINCE) {
    console.log("Dashboard date floor: already set");
  } else {
    console.log(`Dashboard date floor: ${SINCE}`);
    if (!DRY_RUN) await ph.api("PATCH", `dashboards/${DASHBOARD_ID}/`, { filters: { ...dashboard.filters, date_from: SINCE } });
  }
}

// --- main ----------------------------------------------------------------------

async function main() {
  const ph = posthogClient();
  const dashboard = await ph.api("GET", `dashboards/${DASHBOARD_ID}/`);
  const tiles = (dashboard.tiles ?? []).filter((t) => t.insight && !t.deleted);

  if (DUMP) {
    console.log(`Dashboard ${DASHBOARD_ID}: ${dashboard.name} (${tiles.length} insight tiles)\n`);
    for (const { insight } of tiles) {
      console.log(`#${insight.id} ${insight.name ?? insight.derived_name ?? "(unnamed)"}`);
      if (insight.description) console.log(`  ${insight.description}`);
      console.log(`  ${JSON.stringify(insight.query ?? insight.filters)}\n`);
    }
    return;
  }

  console.log(`${DRY_RUN ? "[dry run] " : ""}Dashboard ${DASHBOARD_ID}: ${dashboard.name}\n`);
  await ensureTestAccountFilters(ph);
  await ensureSince(ph, dashboard);
  console.log("");

  // Validate everything before writing anything.
  const failures = [];
  for (const def of INSIGHTS) {
    const error = await validate(ph, def);
    if (error) failures.push(`${def.name}: ${error}`);
  }
  if (failures.length) {
    console.error(`Invalid queries — nothing written:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }

  const claimed = new Set();
  for (const def of INSIGHTS) {
    const names = [def.name, ...def.replaces].map(norm);
    const tile = tiles.find((t) => !claimed.has(t.insight.id) && names.includes(norm(t.insight.name ?? t.insight.derived_name)));
    const body = { name: def.name, description: `${def.description} ${MANAGED}`, query: def.query, saved: true };
    if (tile) {
      claimed.add(tile.insight.id);
      const was = tile.insight.name ?? tile.insight.derived_name;
      console.log(`update  #${tile.insight.id} ${def.name}${norm(was) === norm(def.name) ? "" : `  (was "${was}")`}`);
      if (!DRY_RUN) await ph.api("PATCH", `insights/${tile.insight.id}/`, body);
    } else {
      console.log(`create  ${def.name}`);
      if (!DRY_RUN) await ph.api("POST", "insights/", { ...body, dashboards: [DASHBOARD_ID] });
    }
  }

  const unmanaged = tiles.filter((t) => !claimed.has(t.insight.id) && !(t.insight.description ?? "").includes(MANAGED));
  for (const { insight } of unmanaged) {
    const name = insight.name ?? insight.derived_name ?? "(unnamed)";
    if (REMOVE_UNMANAGED) {
      console.log(`remove  #${insight.id} ${name}  (off the dashboard; insight kept)`);
      if (!DRY_RUN) {
        await ph.api("PATCH", `insights/${insight.id}/`, {
          dashboards: (insight.dashboards ?? []).filter((id) => id !== DASHBOARD_ID),
        });
      }
    } else {
      console.log(`keep    #${insight.id} ${name}  (not managed; --remove-unmanaged takes it off)`);
    }
  }

  console.log(`\n${ph.host}/project/${ph.projectId}/dashboard/${DASHBOARD_ID}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
