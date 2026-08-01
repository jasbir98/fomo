-- Roameo v1: cold-start arrival tips (plan-v1-home-pivot.md §4.5).
-- Hand-authored, Japan + Scotland only (v1's curated-coverage countries).
-- Run after add_now_ranker_tables.sql. Idempotent via a delete+insert per
-- country (small, hand-edited table — safe to fully replace on re-run).

delete from arrival_tips where country in ('JP', 'GB');

insert into arrival_tips (country, city, headline, detail, applies_hours_from, applies_hours_to) values
  ('JP', null,
   'Don''t plan anything yet. Eat, then sleep early.',
   'Get a Suica or Pasmo from the ticket machine, not the staffed counter — same card, no queue. Eat something before eight if you can; your body thinks it''s the middle of the night, and food helps more than caffeine does right now.',
   0, 6),
  ('JP', null,
   'Settle in before you sightsee.',
   'Convenience stores (konbini) are genuinely good for a first meal and have everything you forgot to pack — a 7-Eleven or FamilyMart is never far. Cash still matters here; find an ATM inside a 7-Eleven if your card hasn''t worked elsewhere.',
   6, 24),
  ('GB', null,
   'Get a local SIM or eSIM sorted first.',
   'Coverage drops fast outside city centres, especially in the Highlands — sort connectivity before you need it, not after. If you''ve landed at Edinburgh or Glasgow, the airport-to-city tram/bus is cheaper and often faster than a taxi at rush hour.',
   0, 6),
  ('GB', null,
   'Everything shuts earlier than you''d expect.',
   'Kitchens in pubs often stop serving food by 9pm even if the bar stays open — eat on the earlier side tonight. Tap water is free and fine to drink everywhere; ask for it and you''ll get an odd look if you don''t.',
   6, 24);
