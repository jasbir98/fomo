/**
 * Fomo onsale-alerts — pure selection/dedupe logic.
 *
 * Deliberately zero Deno/Supabase imports so it can be exercised by a plain
 * `node`/`tsx` fixture script without a live Supabase instance or the Deno
 * runtime — same testability rationale as lib/happenings/book-early.ts's own
 * module doc. `index.ts` (the actual Edge Function) does all the I/O
 * (fetching rows, calling web-push, writing push_notification_log) and
 * treats this module as: given the world right now, which notifications
 * should be attempted, and with a description of what to send.
 *
 * TWO SEPARATE TRIGGERS, PER THE TASK BRIEF — NOT MUTUALLY EXCLUSIVE:
 *   - "opt_in": a user has an onsale_alerts row for this happening (they
 *     tapped Notify me). Fires once, when booking_opens_at falls inside the
 *     trailing "opening now" window.
 *   - "big_alert": a user has big_onsale_alerts = true and the happening's
 *     sellout_risk is 'high'. Fires for every such user, independent of
 *     whether they *also* opted in individually — a user who did both gets
 *     two notifications with two different `reason`s (the push_notification_log
 *     unique constraint is keyed on (user, happening, reason), so this is
 *     intentional, not a bug). In practice the Service Worker's `tag` (the
 *     happening id — see public/sw.js) collapses two pushes for the same
 *     happening into one visible notification, so this is a soft
 *     duplication at worst.
 *   - "opt_in_24h": optional heads-up, opt-in users only, ~24h before
 *     booking_opens_at.
 *
 * DEDUPE: the real guard is index.ts's insert-into-push_notification_log-
 * first-then-send-only-on-success pattern (a unique-constraint race is safe
 * because only one concurrent insert can win). `alreadyLogged` here is a
 * cheap pre-filter against rows index.ts already fetched, so an obviously-
 * already-sent candidate doesn't even get attempted — narrowing the set that
 * has to race on insert, not a substitute for it.
 */

export type SelloutRisk = "high" | "medium" | "low" | null;

export interface HappeningForAlerts {
  id: string;
  title: string;
  /** ISO timestamp. Only happenings with a non-null booking_opens_at are ever candidates. */
  booking_opens_at: string;
  sellout_risk: SelloutRisk;
  sellout_note: string | null;
}

export interface OptInAlertRow {
  userId: string;
  happeningId: string;
}

export type NotificationReason = "opt_in" | "big_alert" | "opt_in_24h";

export interface NotificationCandidate {
  userId: string;
  happeningId: string;
  reason: NotificationReason;
  title: string;
  body: string;
  /** Relative path — index.ts resolves it against the deployed app's own origin isn't available server-side, so this is embedded in the push payload as-is and public/sw.js's notificationclick resolves it against `self.location.origin`. */
  url: string;
}

export interface SelectAlertsInput {
  now: Date;
  /** Live happenings with a non-null booking_opens_at — caller's job to pre-filter by `status = 'live'`; this module doesn't re-check it. */
  happenings: HappeningForAlerts[];
  /** Every onsale_alerts row not yet marked notified_at, for ANY happening — this module does its own windowing. */
  optInAlerts: OptInAlertRow[];
  /** user_ids with profiles.big_onsale_alerts = true. */
  bigAlertUserIds: string[];
  /** `${userId}|${happeningId}|${reason}` keys already present in push_notification_log — see the module doc's DEDUPE note. */
  alreadyLogged: ReadonlySet<string>;
  /** Trailing window for "opening now" — booking_opens_at in [now - openingWindowMinutes, now]. Default 30, matching the task brief. */
  openingWindowMinutes?: number;
  /** How far ahead the heads-up fires. Default 24h, per the task brief. */
  headsUpHours?: number;
  /** Half-width of the heads-up window around exactly `headsUpHours` ahead — sized to comfortably straddle the 5-minute cron cadence so a happening isn't missed between two runs. Default 5. */
  headsUpToleranceMinutes?: number;
}

export function logKey(userId: string, happeningId: string, reason: NotificationReason): string {
  return `${userId}|${happeningId}|${reason}`;
}

function minutesToMs(minutes: number): number {
  return minutes * 60_000;
}

function openingNowLabel(h: HappeningForAlerts): { title: string; body: string } {
  const title = `Tickets on sale now: ${h.title}`;
  const body = h.sellout_note ?? "Tickets just opened — grab yours before they're gone.";
  return { title, body };
}

function headsUpLabel(h: HappeningForAlerts): { title: string; body: string } {
  const title = `Tickets open tomorrow: ${h.title}`;
  const body = h.sellout_note ? `Booking opens in 24 hours · ${h.sellout_note}` : "Booking opens in 24 hours.";
  return { title, body };
}

/** Given the current world, the full list of notifications to attempt this run. Pure — no I/O, no mutation of its inputs. */
export function selectOnsaleAlerts(input: SelectAlertsInput): NotificationCandidate[] {
  const {
    now,
    happenings,
    optInAlerts,
    bigAlertUserIds,
    alreadyLogged,
    openingWindowMinutes = 30,
    headsUpHours = 24,
    headsUpToleranceMinutes = 5,
  } = input;

  const nowMs = now.getTime();
  const openingWindowMs = minutesToMs(openingWindowMinutes);
  const headsUpTargetMs = nowMs + minutesToMs(headsUpHours * 60);
  const headsUpToleranceMs = minutesToMs(headsUpToleranceMinutes);

  const optInsByHappening = new Map<string, string[]>();
  for (const row of optInAlerts) {
    const list = optInsByHappening.get(row.happeningId) ?? [];
    list.push(row.userId);
    optInsByHappening.set(row.happeningId, list);
  }

  const out: NotificationCandidate[] = [];

  for (const h of happenings) {
    const opensAtMs = new Date(h.booking_opens_at).getTime();
    if (Number.isNaN(opensAtMs)) continue;

    const isOpeningNow = opensAtMs <= nowMs && opensAtMs >= nowMs - openingWindowMs;
    const isHeadsUpWindow = Math.abs(opensAtMs - headsUpTargetMs) <= headsUpToleranceMs;

    if (isOpeningNow) {
      const { title, body } = openingNowLabel(h);
      const url = `/happening/${h.id}`;

      for (const userId of optInsByHappening.get(h.id) ?? []) {
        const key = logKey(userId, h.id, "opt_in");
        if (alreadyLogged.has(key)) continue;
        out.push({ userId, happeningId: h.id, reason: "opt_in", title, body, url });
      }

      if (h.sellout_risk === "high") {
        for (const userId of bigAlertUserIds) {
          const key = logKey(userId, h.id, "big_alert");
          if (alreadyLogged.has(key)) continue;
          out.push({ userId, happeningId: h.id, reason: "big_alert", title, body, url });
        }
      }
    }

    if (isHeadsUpWindow) {
      const { title, body } = headsUpLabel(h);
      const url = `/happening/${h.id}`;
      for (const userId of optInsByHappening.get(h.id) ?? []) {
        const key = logKey(userId, h.id, "opt_in_24h");
        if (alreadyLogged.has(key)) continue;
        out.push({ userId, happeningId: h.id, reason: "opt_in_24h", title, body, url });
      }
    }
  }

  return out;
}
