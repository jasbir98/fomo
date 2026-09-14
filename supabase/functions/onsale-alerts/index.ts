// Fomo — onsale-alerts Supabase Edge Function.
//
// Invoked every 5 minutes by pg_cron + pg_net (supabase/schedule_onsale_alerts.sql).
// Finds happenings whose booking just opened (or opens in ~24h) and pushes
// the right users, per lib/happenings/book-early.ts's rules and this
// folder's own select.ts (the pure part of this logic — read that file's
// doc comment first, it explains the two trigger paths and the dedupe
// contract this file implements around it).
//
// Auth: a shared secret header, not Supabase's own JWT verification — this
// function is invoked by pg_net from inside the same project, not by an
// end-user session, so there's no user JWT to check. See
// supabase/schedule_onsale_alerts.sql for how CRON_SECRET is threaded
// through.
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import {
  selectOnsaleAlerts,
  logKey,
  type HappeningForAlerts,
  type OptInAlertRow,
  type NotificationCandidate,
} from "./select.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

// Bounds the happenings query so it's a narrow index scan, not a table scan —
// covers both the trailing "opening now" window and the forward "24h
// heads-up" window with margin either side. Kept in sync with select.ts's
// own defaults; if those defaults ever change, widen this range to match.
const QUERY_PAST_MINUTES = 40; // > 30 min opening window, small buffer
const QUERY_FUTURE_HOURS = 25; // > 24h heads-up, small buffer

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (!CRON_SECRET) {
    return jsonResponse({ error: "CRON_SECRET not configured" }, 500);
  }
  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Supabase service-role env vars not configured" }, 500);
  }
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    return jsonResponse({ error: "VAPID env vars not configured" }, 500);
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const now = new Date();
  const rangeFrom = new Date(now.getTime() - QUERY_PAST_MINUTES * 60_000).toISOString();
  const rangeTo = new Date(now.getTime() + QUERY_FUTURE_HOURS * 3_600_000).toISOString();

  try {
    const [happeningsRes, bigAlertRes] = await Promise.all([
      supabase
        .from("happenings")
        .select("id, title, booking_opens_at, sellout_risk, sellout_note")
        .eq("status", "live")
        .not("booking_opens_at", "is", null)
        .gte("booking_opens_at", rangeFrom)
        .lte("booking_opens_at", rangeTo),
      supabase.from("profiles").select("user_id").eq("big_onsale_alerts", true),
    ]);

    if (happeningsRes.error) throw happeningsRes.error;
    if (bigAlertRes.error) throw bigAlertRes.error;

    const happenings = (happeningsRes.data ?? []) as HappeningForAlerts[];
    const bigAlertUserIds = (bigAlertRes.data ?? []).map((r: { user_id: string }) => r.user_id);

    if (happenings.length === 0) {
      return jsonResponse({ checked: 0, candidates: 0, sent: 0, failed: 0, deletedSubscriptions: 0 });
    }

    const happeningIds = happenings.map((h) => h.id);

    const [optInRes, logRes] = await Promise.all([
      supabase
        .from("onsale_alerts")
        .select("user_id, happening_id, notified_at")
        .in("happening_id", happeningIds),
      supabase
        .from("push_notification_log")
        .select("user_id, happening_id, reason")
        .in("happening_id", happeningIds),
    ]);
    if (optInRes.error) throw optInRes.error;
    if (logRes.error) throw logRes.error;

    // notified_at only ever gates the "opt_in" (opening-now) reason — see
    // this function's own dedupe note and select.ts's module doc. Rows
    // already notified for opt_in are excluded up front so a stale/duplicate
    // onsale_alerts read can't even produce a candidate for that reason;
    // opt_in_24h dedupe relies entirely on push_notification_log below.
    const optInAlerts: OptInAlertRow[] = (optInRes.data ?? [])
      .filter((r: { notified_at: string | null }) => r.notified_at == null)
      .map((r: { user_id: string; happening_id: string }) => ({ userId: r.user_id, happeningId: r.happening_id }));

    const alreadyLogged = new Set<string>(
      (logRes.data ?? []).map((r: { user_id: string; happening_id: string; reason: string }) =>
        logKey(r.user_id, r.happening_id, r.reason as NotificationCandidate["reason"])
      )
    );

    const candidates = selectOnsaleAlerts({
      now,
      happenings,
      optInAlerts,
      bigAlertUserIds,
      alreadyLogged,
    });

    let sent = 0;
    let failed = 0;
    let deletedSubscriptions = 0;
    const notifiedOptInHappeningByUser: { userId: string; happeningId: string }[] = [];

    for (const candidate of candidates) {
      // Dedupe source of truth: insert into push_notification_log first,
      // only proceed if the insert actually landed (a concurrent run for
      // the same (user, happening, reason) loses the unique-constraint race
      // and its insert errors with 23505 — that's the expected, safe
      // outcome, not a failure to log).
      const { error: logError } = await supabase.from("push_notification_log").insert({
        user_id: candidate.userId,
        happening_id: candidate.happeningId,
        reason: candidate.reason,
      });
      if (logError) {
        if ((logError as { code?: string }).code === "23505") continue; // already sent by another run
        console.error("[onsale-alerts] log insert failed", logError);
        failed++;
        continue;
      }

      const { data: subs, error: subsError } = await supabase
        .from("push_subscriptions")
        .select("id, endpoint, p256dh, auth, failure_count")
        .eq("user_id", candidate.userId);
      if (subsError) {
        console.error("[onsale-alerts] subscriptions read failed", subsError);
        failed++;
        continue;
      }

      let anySent = false;
      for (const sub of subs ?? []) {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            JSON.stringify({
              title: candidate.title,
              body: candidate.body,
              url: candidate.url,
              tag: candidate.happeningId,
            })
          );
          anySent = true;
          sent++;
          await supabase
            .from("push_subscriptions")
            .update({ last_success_at: new Date().toISOString(), failure_count: 0 })
            .eq("id", sub.id);
        } catch (err) {
          const statusCode = (err as { statusCode?: number } | null)?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await supabase.from("push_subscriptions").delete().eq("id", sub.id);
            deletedSubscriptions++;
          } else {
            console.error("[onsale-alerts] send failed", candidate.userId, statusCode, err);
            failed++;
            await supabase
              .from("push_subscriptions")
              .update({ failure_count: (sub.failure_count ?? 0) + 1 })
              .eq("id", sub.id);
          }
        }
      }

      if (candidate.reason === "opt_in" && anySent) {
        notifiedOptInHappeningByUser.push({ userId: candidate.userId, happeningId: candidate.happeningId });
      }
    }

    // Fast-path skip flag for next run — see the onsale_alerts table's own
    // doc comment (supabase/add_push_alerts.sql). Best-effort: failing to
    // set this doesn't cause a re-send, since push_notification_log already
    // blocked it above.
    await Promise.all(
      notifiedOptInHappeningByUser.map(({ userId, happeningId }) =>
        supabase
          .from("onsale_alerts")
          .update({ notified_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("happening_id", happeningId)
      )
    );

    return jsonResponse({
      checked: happenings.length,
      candidates: candidates.length,
      sent,
      failed,
      deletedSubscriptions,
    });
  } catch (err) {
    console.error("[onsale-alerts] run failed", err);
    return jsonResponse({ error: String(err) }, 500);
  }
});
