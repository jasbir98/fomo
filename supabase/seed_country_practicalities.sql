-- Roameo v1.2 (Accounts) — Phase 7 "Practicalities" seed data
-- (plan-v1.2-accounts.md §E.3). Hand-authored, Japan + UK only (the same
-- curated-coverage countries as seed_arrival_tips.sql — this table replaces
-- that one as the app's read path; see add_practicalities.sql's header
-- comment). Run after add_practicalities.sql. Idempotent via a delete+insert
-- per country (small, hand-edited table — safe to fully replace on re-run).
--
-- `arrival_tips` fold-in (plan §E.4): arrival_tips' four JP/GB rows are
-- reconciled into the six-topic set below rather than duplicated verbatim.
-- The one genuine overlap is GB connectivity — arrival_tips' GB row
-- ("Get a local SIM or eSIM sorted first... Coverage drops fast outside
-- city centres, especially in the Highlands") is folded whole into this
-- file's GB `connectivity` row below, so there is exactly one GB
-- connectivity row, not two near-duplicates. JP's arrival_tips rows (Suica/
-- Pasmo card advice, 7-Eleven ATM advice) are folded into JP `transit` and
-- `money` respectively. The jet-lag/"eat before 8pm, sleep early" and
-- "kitchens stop serving by 9pm" mood-copy from arrival_tips has no home in
-- the fixed connectivity|money|transit|power|water|tipping|safety topic
-- set and is deliberately dropped, not force-fit into an unrelated topic.
--
-- Deliberately no `safety` row for either country: entry/visa requirements
-- (Japan's Visit Japan Web, the UK's ETA) change and being wrong about them
-- is expensive in a way being wrong about plug sockets is not. Per the plan:
-- "Do NOT let a model generate these rows unreviewed." Left out entirely.
--
-- Windows: every row's `applies_from_days` is -14 (the column default) so
-- the whole set — connectivity/money/transit/power/water/tipping — is
-- already visible a full two weeks out, not just connectivity. Verified by
-- hand for the phase's own required trace: a JP trip 5 days out resolves
-- `daysFromTripStart === -5` (lib/db/practicalities.ts), and
-- `-14 <= -5 <= applies_to_days` holds for every row below, so all six
-- surface together. `applies_to_days` varies by how long each stays
-- relevant once you've landed — short for the two you act on immediately
-- (connectivity, money), longer for the ones you'd still reference mid-trip.

delete from country_practicalities where country_code in ('JP', 'GB');

insert into country_practicalities
  (country_code, city, topic, headline, detail, chat_seed, applies_from_days, applies_to_days, priority)
values
  -- ============================================================ JAPAN ====
  ('JP', null, 'connectivity',
   'Sort your eSIM before you land',
   'Airalo or your carrier''s own eSIM installs in minutes and activates the moment you land — data from the airport is otherwise a scramble. A physical SIM needs a passport and a counter queue; skip it.',
   'Getting an eSIM sorted for Japan', -14, 2, 90),

  ('JP', null, 'money',
   'Cash still matters here',
   'Bring some yen and don''t assume cards work everywhere. A 7-Eleven ATM is the reliable one for foreign cards — most other machines, and plenty of smaller shops, still don''t take them.',
   'Getting cash and ATMs sorted in Japan', -14, 5, 80),

  ('JP', null, 'transit',
   'Get a Suica or Pasmo card',
   'Grab one from the ticket machine, not the staffed counter — same card, no queue. Add it to Apple Wallet before you land and you can tap through gates and pay at konbini with your phone.',
   'Setting up Suica or Pasmo for Japan transit', -14, 7, 70),

  ('JP', null, 'power',
   'Type A plugs, 100V',
   'Same flat two-pin shape as North America, just lower voltage — most phone and laptop chargers handle it fine, but check anything with a motor or heating element before you plug it in.',
   'Power adapters and voltage for Japan', -14, 7, 60),

  ('JP', null, 'water',
   'Tap water is fine to drink',
   'You don''t need to buy bottled water — tap water across Japan is safe and tastes fine. Restaurants will bring it to your table unasked.',
   'Is tap water safe to drink in Japan', -14, 7, 50),

  ('JP', null, 'tipping',
   'Don''t tip — really',
   'Tipping isn''t expected anywhere in Japan and can come across as confusing or even rude — good service is its own reward here. The price you see is the price you pay.',
   'Do you tip in Japan', -14, 7, 40),

  -- ================================================================ GB ====
  ('GB', null, 'connectivity',
   'Sort an eSIM before you land',
   'Coverage drops fast outside city centres, especially in the Highlands — an eSIM (Airalo, Holafly, or your carrier''s own) gets you connected the moment you land, before you''re relying on patchy signal to find one.',
   'Getting an eSIM sorted for the UK', -14, 2, 90),

  ('GB', null, 'money',
   'Contactless works almost everywhere',
   'Tap your card or phone for nearly everything, from buses to market stalls — cash is rarely needed. Contactless limits are generous, so a big purchase won''t get declined either.',
   'Do I need cash in the UK', -14, 5, 80),

  ('GB', null, 'transit',
   'Tap in, tap out on transit',
   'Contactless card or phone works directly on buses, the Tube, and most trains — no ticket needed, and it auto-caps at the day rate. For longer trips, ScotRail advance fares booked ahead are noticeably cheaper than turning up on the day.',
   'How transit ticketing works in the UK', -14, 7, 70),

  ('GB', null, 'power',
   'Type G plugs, 230V',
   'The three-pin rectangular plug — bring an adapter if you''re not already packing one. Most phone/laptop chargers handle 230V natively, but double-check anything with a heating element.',
   'Power adapters and voltage for the UK', -14, 7, 60),

  ('GB', null, 'water',
   'Tap water is fine everywhere',
   'Tap water is safe and free across the UK — ask for it in a pub or restaurant and you''ll get an odd look if you don''t. No need to buy bottled.',
   'Is tap water safe to drink in the UK', -14, 7, 50),

  ('GB', null, 'tipping',
   'Round up, or about 10%',
   'Tipping isn''t automatic — check your bill first, since many restaurants already add a service charge. If not, about 10% is normal at a sit-down meal; rounding up is fine at a pub, and it isn''t expected for a quick coffee.',
   'How much to tip in the UK', -14, 7, 40);
