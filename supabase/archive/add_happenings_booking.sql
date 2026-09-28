-- Fomo: "Happenings" — booking/sell-out extension. Adds the three columns
-- the "Book early" Home section (see plan-v1-home-pivot / the Home rebuild
-- brief) needs on top of supabase/add_happenings.sql: when a booking window
-- opens, and how likely/fast a thing sells out. Run after
-- add_happenings.sql. Idempotent — safe to re-run.
--
-- VOCAB NOTE (extends, does not replace, the comments in add_happenings.sql):
--   `kind` was documented there as exactly three values (deal | free_access |
--   festival). It is now six: deal | free_access | festival | activity |
--   tour | event — added to cover recurring locals-only things (parkruns,
--   free walking tours) and paid/bookable things (concerts, Tattoo, big
--   festivals) that are neither a discount nor a free-entry row. Still no
--   DB CHECK — enforced in the `HappeningKind` TS union in
--   lib/happenings/types.ts, same convention as before.
--   `category` gains three values: wellness | outdoors | tours — same
--   reasoning, same enforcement point (`HappeningCategory` in
--   lib/happenings/types.ts).
--
-- These three new columns are deliberately NOT required and have no CHECK
-- constraint, matching every other content-facing taxonomy column in
-- add_happenings.sql (kind/category/eligibility): enforced in TS unions,
-- not Postgres, so a pipeline change never needs a migration to loosen a
-- CHECK. A row with no booking story at all (a standing deal, a permanently
-- free museum) simply leaves all three null — that is the common case, not
-- an error state.

-- null = already on sale / no booking needed (the vast majority of rows:
-- standing deals, free-access, anything you can just turn up to). Only
-- set when a source states a specific release moment for tickets that
-- are not yet on general sale.
alter table happenings add column if not exists booking_opens_at timestamptz;

-- high | medium | low | null. Null means "no sell-out evidence found" —
-- NOT "low risk". Never inferred from venue popularity or vibes; only ever
-- set when sellout_note below cites a real source for it (see rule 5 in
-- happenings_research.py's book-early prompt).
alter table happenings add column if not exists sellout_risk text;

-- Display copy that carries its own source, e.g. "Sold out within 10 days
-- in 2025" or "Presale sold out in under an hour (Ticketmaster, Sep 2025)".
-- Never populated without sellout_risk also being set, and never invented —
-- same "prefer null over guessing" rule as every other happenings field.
alter table happenings add column if not exists sellout_note text;

alter table happenings_staging add column if not exists booking_opens_at timestamptz;
alter table happenings_staging add column if not exists sellout_risk text;
alter table happenings_staging add column if not exists sellout_note text;

-- Book-early is the section most likely to be read sorted/filtered by
-- release timing ("what just went on sale", "what opens for booking this
-- week") — mirrors happenings_dates_idx's reasoning in add_happenings.sql.
create index if not exists happenings_booking_opens_at_idx
  on happenings (booking_opens_at);
