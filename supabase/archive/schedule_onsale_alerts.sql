-- Fomo — schedule the onsale-alerts Edge Function every 5 minutes.
--
-- Vercel Hobby's cron is daily-only, which can't drive a "check every 5
-- minutes for tickets that just opened" job — so the schedule lives here
-- instead, inside Supabase itself: pg_cron fires on a timer, pg_net makes
-- the actual HTTP call to the deployed Edge Function.
--
-- RUN THIS AFTER: supabase/add_happenings_booking.sql, then
-- supabase/add_push_alerts.sql, then `supabase functions deploy onsale-alerts`
-- and `supabase secrets set CRON_SECRET=... VAPID_...` (see
-- docs/push-notifications.md for the exact commands).
--
-- Idempotent — `cron.schedule` with an existing job name updates it in
-- place rather than erroring or duplicating.

-- Both extensions usually live in the `extensions` schema on Supabase
-- projects already; `create extension if not exists` is a no-op if so.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- ============================================================================
-- RECOMMENDED FORM — secret stored in Supabase Vault, read at call time via
-- vault.decrypted_secrets, so CRON_SECRET never sits in plaintext in this
-- file or in `cron.job`'s stored command text.
--
-- One-time setup (run once, in the SQL editor, then don't commit the value
-- anywhere):
--   select vault.create_secret('<paste the same value you set as the
--     onsale-alerts function''s CRON_SECRET secret>', 'onsale_alerts_cron_secret');
--
-- Then schedule using that secret:
-- ============================================================================
select cron.schedule(
  'onsale-alerts',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/onsale-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'onsale_alerts_cron_secret'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ============================================================================
-- SIMPLER FORM (inline secret) — only if Vault isn't available on your plan
-- or you want to get going fast; the tradeoff is CRON_SECRET then sits in
-- plaintext in `cron.job`'s stored command (visible to anyone with SQL
-- access to this project, same exposure as any other admin-only table).
-- Comment out the `cron.schedule` call above and use this instead if so —
-- don't run both, the job name is the same and the second call would just
-- overwrite the first anyway.
-- ============================================================================
-- select cron.schedule(
--   'onsale-alerts',
--   '*/5 * * * *',
--   $$
--   select net.http_post(
--     url := 'https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/onsale-alerts',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <YOUR-CRON-SECRET>'
--     ),
--     body := '{}'::jsonb
--   );
--   $$
-- );

-- To inspect scheduled runs later:
--   select * from cron.job where jobname = 'onsale-alerts';
--   select * from cron.job_run_details order by start_time desc limit 20;
-- To unschedule:
--   select cron.unschedule('onsale-alerts');
