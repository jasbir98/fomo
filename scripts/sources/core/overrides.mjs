/**
 * Manual corrections for imported events. upsertEvents re-writes every scraped
 * row on each run, so editing a row in the database (or hiding a duplicate by
 * setting status='gone') is undone by the next run. An entry here is applied
 * to the scraped row just before it is upserted, so the correction sticks.
 *
 * Add an entry when a source gets a specific event wrong and nothing in the
 * adapter or validator can fix it generally: a missing price or time, a wrong
 * link, or a duplicate listing the cross-source dedupe can't catch (different
 * titles). Match is exact on provider + provider_event_id. Always give a reason
 * (what's wrong, how you verified it, and when). An entry for an event that has
 * ended does nothing useful and can be deleted.
 *
 *   { provider, provider_event_id, reason, hide?: true, set?: { ...columns } }
 *
 *   set   merges the given events columns over the scraped row (scraped values
 *         lose). Only the columns in OVERRIDABLE_COLUMNS are allowed.
 *   hide  keeps the row in the upsert (so last_seen_at still updates and
 *         retire.mjs doesn't misread it) but forces status 'gone'. No new
 *         status: events_status_check only allows active/cancelled/gone/expired.
 */

export const OVERRIDABLE_COLUMNS = [
  "name",
  "description",
  "category",
  "image_url",
  "ticket_url",
  "starts_at",
  "ends_at",
  "venue_name",
  "address",
  "lat",
  "lng",
  "is_free",
  "price_from",
  "currency",
  "place_id",
];

export const EVENT_OVERRIDES = [
  {
    provider: "allevents",
    provider_event_id: "https://allevents.in/edinburgh/europes-biggest-thrift-festival-edinburgh/100001998209339926",
    reason:
      "AllEvents has no price or times. Verified on the organiser page 2026-10-09: cheapest ticket is last-hour entry, £2 + 20% VAT + £0.06 fee = £2.46; event runs 11:00-17:00 BST.",
    set: {
      price_from: 2.46,
      is_free: false,
      currency: "GBP",
      starts_at: "2026-10-18T10:00:00+00:00",
      ends_at: "2026-10-18T16:00:00+00:00",
      ticket_url: "https://www.clothescyclemarkets.co.uk/event-details/europes-biggest-thrift-festival-edinburgh",
    },
  },
  {
    provider: "allevents",
    provider_event_id: "https://allevents.in/edinburgh/uks-largest-thrift-market-edinburgh/200030430205138",
    reason: "Duplicate AllEvents listing of the same ClothesCycle event (same venue, date, 11:00-17:00); the titles differ so the dedupe can't catch it.",
    hide: true,
  },
  {
    provider: "allevents",
    provider_event_id: "https://allevents.in/edinburgh/edinburgh-oktoberfest-2026/200029610581325",
    reason:
      "AllEvents has no price and the wrong times. Verified on tickets.edinburgh-oktoberfest.co.uk 2026-10-09: runs Thu 8 Oct 16:00 to Sat 10 Oct 23:30 BST; the £5 Friday-lunch admission has passed, cheapest still on sale is £15 general admission (+£2.90 per order).",
    set: {
      price_from: 15,
      is_free: false,
      currency: "GBP",
      starts_at: "2026-10-08T15:00:00+00:00",
      ends_at: "2026-10-10T22:30:00+00:00",
      ticket_url: "https://edinburgh-oktoberfest.co.uk/tickets/",
    },
  },
];

/** Throws on a malformed entry or a `set` key that isn't a real events column. */
export function validateOverrides(overrides) {
  for (const o of overrides) {
    const id = `${o?.provider}/${o?.provider_event_id}`;
    if (!o || typeof o.provider !== "string" || typeof o.provider_event_id !== "string" || !o.provider || !o.provider_event_id) {
      throw new Error(`event override ${id}: provider and provider_event_id are required strings`);
    }
    if (!o.hide && !(o.set && Object.keys(o.set).length > 0)) {
      throw new Error(`event override ${id}: needs hide: true or a non-empty set`);
    }
    for (const key of Object.keys(o.set ?? {})) {
      if (!OVERRIDABLE_COLUMNS.includes(key)) {
        throw new Error(
          `event override ${id}: "${key}" is not an overridable events column (allowed: ${OVERRIDABLE_COLUMNS.join(", ")})`
        );
      }
    }
  }
}

validateOverrides(EVENT_OVERRIDES);

/**
 * Pure: apply `overrides` to `rows`. Returns { rows, applied } where applied is
 * [{ provider, provider_event_id, hide, setKeys }] for each entry that matched
 * a row. Rows without an entry are returned as-is; matched rows are copies.
 */
export function applyEventOverrides(rows, overrides = EVENT_OVERRIDES) {
  validateOverrides(overrides);
  const byKey = new Map(overrides.map((o) => [`${o.provider}\u0000${o.provider_event_id}`, o]));
  const applied = [];
  const out = rows.map((row) => {
    const o = byKey.get(`${row.provider}\u0000${row.provider_event_id}`);
    if (!o) return row;
    const next = { ...row, ...(o.set ?? {}) };
    if (o.hide) next.status = "gone";
    applied.push({ provider: o.provider, provider_event_id: o.provider_event_id, hide: !!o.hide, setKeys: Object.keys(o.set ?? {}) });
    return next;
  });
  return { rows: out, applied };
}
