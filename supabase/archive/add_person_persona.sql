-- add_person_persona.sql
--
-- Created in Phase 4 (Onboarding + the real gate) of plan-v1.2-accounts.md,
-- even though the plan's own build-sequence table assigns this file to
-- Phase 5. Reason: `/onboarding/taste` and `/onboarding/rhythm` (built in
-- Phase 4) need somewhere to persist their answers, and these columns are
-- that somewhere — there's no way to ship those two screens without this
-- migration existing first.
--
-- Phase 5 will add `lib/taxonomy.ts`'s ranking-side mapping functions and
-- `lib/now/persona.ts`'s `resolvePersona()` on top of these same columns.
-- This file should be a no-op if Phase 5 re-runs it — every statement is
-- already `add column if not exists`, so re-running is safe by construction.
alter table travel_preferences
  add column if not exists budget_band    text,   -- shoestring | middle | treat
  add column if not exists walk_tolerance text,   -- high | medium | low
  add column if not exists interest_tags  text[] default '{}',
  add column if not exists cuisine_tags   text[] default '{}',
  add column if not exists day_rhythm     text,   -- early | steady | night
  add column if not exists pace           text;   -- packed | balanced | slow

-- ============================================================================
-- Phase 5 (Persona schema + taxonomy, plan-v1.2-accounts.md §C.2) — legacy
-- backfill. Every statement below is guarded to touch only rows where the
-- *new* column is still unset, so this is safe to re-run and never clobbers
-- an early tester's own Phase-4 onboarding answers. Legacy columns
-- (luxury_backpacker, mobility, interests) stay nullable/untouched — they're
-- dropped in Phase 8, not here.
-- ============================================================================

-- luxury_backpacker is a 1-5 slider (1 = luxury, 5 = backpacker). The middle
-- value carries no strong signal and is deliberately left unmapped, per plan
-- §C.2: "middle values (3) should map to null/unset ... not forced into a
-- band."
update travel_preferences
set budget_band = case
  when luxury_backpacker <= 2 then 'treat'
  when luxury_backpacker >= 4 then 'shoestring'
end
where budget_band is null
  and luxury_backpacker is not null
  and luxury_backpacker <> 3;

-- mobility was a free-text chip array from the old /setup/travel-dna form
-- (removed in Phase 4 — TasteForm.tsx doesn't write it anymore, so this is
-- purely a read of old data). Matched case-insensitively/by substring since
-- the exact old label strings aren't preserved anywhere in the current
-- codebase to check against verbatim.
update travel_preferences
set walk_tolerance = 'low'
where walk_tolerance is null
  and exists (
    select 1 from unnest(mobility) as m(label)
    where m.label ilike '%low walking%' or m.label ilike '%no stairs%'
  );

-- interests[] -> interest_tags[], via the old 18-label list in
-- lib/interests.ts (INTERESTS), many-to-one onto the 12 new InterestTag
-- values in lib/taxonomy.ts. Judgment calls, so documented here rather than
-- left to infer from the CASE alone:
--   History              -> history      (as-is)
--   Museums              -> history      (exhibits skew historical/cultural;
--                                          the dedicated "Art" label already
--                                          covers art museums/galleries)
--   Art                  -> art          (as-is)
--   Architecture         -> history      (appreciation of historic
--                                          buildings/landmarks — mirrors
--                                          castle/cathedral/abbey -> history
--                                          in lib/taxonomy.ts)
--   Food & Dining        -> food         (as-is)
--   Nightlife            -> nightlife    (as-is)
--   Shopping             -> shopping     (as-is)
--   Nature & Outdoors    -> nature       (as-is)
--   Hiking               -> outdoors     (active, not passive nature)
--   Beach                -> outdoors     (no dedicated tag; outdoor activity)
--   Wellness & Spa       -> wellness     (as-is)
--   Music                -> music        (as-is)
--   Photography          -> views        (photography tourism chases
--                                          viewpoints/vistas)
--   Anime & Pop Culture  -> popculture   (as-is)
--   Adventure Sports     -> outdoors     (as-is)
--   Local Culture        -> history      (heritage/culture umbrella)
--   Wildlife             -> nature       (as-is)
--   Festivals & Events   -> music        (most catalog "festival" events are
--                                          music-led — mirrors
--                                          EVENT_CATEGORY_TO_INTERESTS'
--                                          festival -> [music, popculture]
--                                          in lib/taxonomy.ts)
-- Unrecognized/legacy-drift labels map to null and are dropped by the
-- `filter (where mapped is not null)` below, never coerced into a bucket.
update travel_preferences
set interest_tags = coalesce(
  (
    select array_agg(distinct mapped)
    from unnest(interests) as raw(label)
    cross join lateral (
      select case raw.label
        when 'History' then 'history'
        when 'Museums' then 'history'
        when 'Art' then 'art'
        when 'Architecture' then 'history'
        when 'Food & Dining' then 'food'
        when 'Nightlife' then 'nightlife'
        when 'Shopping' then 'shopping'
        when 'Nature & Outdoors' then 'nature'
        when 'Hiking' then 'outdoors'
        when 'Beach' then 'outdoors'
        when 'Wellness & Spa' then 'wellness'
        when 'Music' then 'music'
        when 'Photography' then 'views'
        when 'Anime & Pop Culture' then 'popculture'
        when 'Adventure Sports' then 'outdoors'
        when 'Local Culture' then 'history'
        when 'Wildlife' then 'nature'
        when 'Festivals & Events' then 'music'
        else null
      end as mapped
    ) mapped_row
    where mapped is not null
  ),
  '{}'
)
where (interest_tags is null or interest_tags = '{}')
  and interests is not null
  and array_length(interests, 1) > 0;
