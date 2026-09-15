-- Roameo happenings: optional season/festival reverify-by date.
--
-- A row whose real-world offer is tied to an annual event/season (festival
-- concessions etc.) needs a date after which it must be reverified or moved
-- to dormant. Null = genuinely standing offer, no season attached.
--
-- Run in the Supabase SQL Editor (see supabase/README.md for the standard
-- apply process — this project has no DATABASE_URL/psql path configured).

alter table happenings add column if not exists season_valid_until date;

comment on column happenings.season_valid_until is 'Optional. For a row whose real-world offer is tied to an annual event/season (festival concessions etc.), the date after which it must be reverified or moved to dormant. Null = genuinely standing offer.';

create index if not exists happenings_season_valid_until_idx on happenings (season_valid_until);
