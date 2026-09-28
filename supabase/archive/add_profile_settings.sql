-- Notification / privacy toggles for the Profile screen's Account Settings
-- card. No Account Security columns needed — that panel only surfaces the
-- existing device_id / created_at.

alter table profiles
  add column if not exists notification_settings jsonb not null default
    '{"trip_reminders":true,"weekly_digest":false,"ai_suggestions":true}'::jsonb,
  add column if not exists privacy_settings jsonb not null default
    '{"personalized_recommendations":true,"precise_location":true,"share_usage_data":true}'::jsonb;
