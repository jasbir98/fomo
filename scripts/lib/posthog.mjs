/**
 * posthog.mjs — tiny PostHog REST client + the visitor-counting HogQL shared
 * by scripts/posthog-dashboards.mjs and scripts/weekly-metrics.mjs.
 *
 * Reads POSTHOG_PERSONAL_API_KEY (a personal API key, phx_…, NOT the public
 * project token), POSTHOG_PROJECT_ID and POSTHOG_HOST from env. Plain Node
 * ESM, global fetch, no deps.
 *
 * How visitors are counted (see instrumentation-client.ts): every event
 * carries `consent_status`. "granted" visitors have a persistent cookie ID,
 * so `person_id` is a real person across days. Everyone else ("pending" —
 * never answered the cookie bar — or "denied") is captured cookieless and
 * PostHog's servers give them a distinct_id = hash(daily salt, IP, UA, …):
 * one ID per visitor per day. So daily counts are exact; for any window
 * longer than a day the cookieless side is only known as a range (low: the
 * busiest single day, high: the sum of every day's uniques).
 */

export function posthogConfig() {
  const key = process.env.POSTHOG_PERSONAL_API_KEY ?? "";
  const projectId = process.env.POSTHOG_PROJECT_ID ?? "286067";
  const host = (process.env.POSTHOG_HOST ?? "https://eu.posthog.com").replace(/\/$/, "");
  return { key, projectId, host, configured: Boolean(key) };
}

export function posthogClient(config = posthogConfig()) {
  const { key, projectId, host } = config;
  if (!key) throw new Error("POSTHOG_PERSONAL_API_KEY is not set");

  async function api(method, path, body) {
    const res = await fetch(`${host}/api/projects/${projectId}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  }

  /** Runs any query node (HogQLQuery, TrendsQuery, …) and returns the raw response. */
  function query(node, name = "fomo-script") {
    return api("POST", "query/", { query: node, name });
  }

  /** HogQL with test-account filters applied wherever the query says `{filters}`. Returns rows as objects. */
  async function hogql(sql) {
    const res = await query({ kind: "HogQLQuery", query: sql, filters: { filterTestAccounts: true } });
    return (res.results ?? []).map((row) => Object.fromEntries(res.columns.map((c, i) => [c, row[i]])));
  }

  return { api, query, hogql, projectId, host };
}

/** A cookieless (daily-hash) event: anything without a "granted" cookie identity. */
export const COOKIELESS = "properties.consent_status IN ('pending', 'denied')";
export const PERSISTENT = "properties.consent_status = 'granted'";

/**
 * Visitors per calendar week (Monday start): persistent visitors are exact;
 * the cookieless side gives the low/high range described above.
 */
export function weeklyVisitorsSql(weeks = 8) {
  const since = `toStartOfWeek(now(), 1) - INTERVAL ${weeks - 1} WEEK`;
  return `
SELECT
  p.week AS week,
  p.persistent AS persistent_visitors,
  p.persistent + d.max_daily_cookieless AS est_visitors_low,
  p.persistent + d.sum_daily_cookieless AS est_visitors_high,
  d.avg_daily_visitors AS avg_daily_visitors
FROM (
  SELECT toStartOfWeek(timestamp, 1) AS week, uniqIf(person_id, ${PERSISTENT}) AS persistent
  FROM events
  WHERE event = '$pageview' AND timestamp >= ${since} AND {filters}
  GROUP BY week
) AS p
LEFT JOIN (
  SELECT
    toStartOfWeek(day, 1) AS week,
    max(cookieless) AS max_daily_cookieless,
    sum(cookieless) AS sum_daily_cookieless,
    round(avg(visitors), 1) AS avg_daily_visitors
  FROM (
    SELECT
      toDate(timestamp) AS day,
      uniqIf(distinct_id, ${COOKIELESS}) AS cookieless,
      uniqIf(person_id, ${PERSISTENT}) + uniqIf(distinct_id, ${COOKIELESS}) AS visitors
    FROM events
    WHERE event = '$pageview' AND timestamp >= ${since} AND {filters}
    GROUP BY day
  )
  GROUP BY week
) AS d ON p.week = d.week
ORDER BY week DESC`;
}

/** Share of each day's visitors who have a persistent (consented) ID. */
export function consentShareSql(days = 30) {
  return `
SELECT
  toDate(timestamp) AS day,
  uniqIf(person_id, ${PERSISTENT}) + uniqIf(distinct_id, ${COOKIELESS}) AS visitors,
  round(100 * uniqIf(person_id, ${PERSISTENT}) / (uniqIf(person_id, ${PERSISTENT}) + uniqIf(distinct_id, ${COOKIELESS})), 1) AS pct_with_cookie
FROM events
WHERE event = '$pageview' AND timestamp >= today() - INTERVAL ${days} DAY AND {filters}
GROUP BY day
ORDER BY day DESC`;
}

/**
 * Headline numbers for one [start, end) window of whole UTC days
 * (YYYY-MM-DD strings) — what scripts/weekly-metrics.mjs prints.
 */
export function windowSummarySql(start, end) {
  const range = `timestamp >= toDateTime('${start} 00:00:00') AND timestamp < toDateTime('${end} 00:00:00')`;
  return `
SELECT
  (SELECT round(avg(v), 1) FROM (
    SELECT toDate(timestamp) AS day, uniqIf(person_id, ${PERSISTENT}) + uniqIf(distinct_id, ${COOKIELESS}) AS v
    FROM events WHERE event = '$pageview' AND ${range} AND {filters} GROUP BY day
  )) AS avg_daily_visitors,
  (SELECT uniqIf(person_id, ${PERSISTENT}) FROM events WHERE event = '$pageview' AND ${range} AND {filters}) AS persistent_visitors,
  (SELECT max(c) FROM (
    SELECT toDate(timestamp) AS day, uniqIf(distinct_id, ${COOKIELESS}) AS c
    FROM events WHERE event = '$pageview' AND ${range} AND {filters} GROUP BY day
  )) AS max_daily_cookieless,
  (SELECT sum(c) FROM (
    SELECT toDate(timestamp) AS day, uniqIf(distinct_id, ${COOKIELESS}) AS c
    FROM events WHERE event = '$pageview' AND ${range} AND {filters} GROUP BY day
  )) AS sum_daily_cookieless,
  (SELECT count() FROM events WHERE event = 'outbound_clicked' AND ${range} AND {filters}) AS outbound_clicks,
  (SELECT count() FROM events WHERE event = 'consent_choice' AND properties.choice = 'accepted' AND ${range} AND {filters}) AS consent_accepted,
  (SELECT count() FROM events WHERE event = 'consent_choice' AND properties.choice = 'declined' AND ${range} AND {filters}) AS consent_declined`;
}
