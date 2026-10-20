# 2026-10-20 Families: a "With kids" lens, plus family supply

Approved 20 Oct 2026. Prompted by user feedback that parents would use Fomo if it surfaced kid-friendly deals and places.


## Context
Feedback: parents would love Fomo if it could pull out the deals and places that suit kids. Today Fomo can't:

**Data**
- The only family signal is the single-valued `category = 'family'`. Live counts (20 Oct): 16 of 354 live happenings, ~7 upcoming events.
- A family gig keeps `music`, so a kids filter can't see it. Keyword matching is noisy ("Junkie Kid", "Bushbaby" gigs).
- Places have no kid signal and few playgrounds, soft plays or farms.

**The pipeline throws kids' deals away**
- Edinburgh Leisure's extract hint says to leave out under-5s offers (`scraper/deal_sources/registry.py`, edinburgh-leisure-offers).
- `ELIGIBILITY_ENUM` has no family value.
- `annual.yaml` skips Kids Eat Free on purpose.
- There is one weekly "family activities" topic, priority 75, seeded only with rbge and nms.

**Product**
- Family items are excluded from Finds and the weekly email.
- "Family" shows only as a /whats-on chip.
- There's no "I've got kids" pref, the chat can't see happening categories, and Explore has no family category.

**Decisions (20 Oct):**
- Lens + test.
- Family content mixed in for everyone.
- Go wider on family sources than the original 3-source exception (your feedback on the first plan). No other new sources while the 30-day freeze runs.

**Why it's worth it:** parents plan ahead and share in WhatsApp and Facebook groups. "Free things to do with kids in Edinburgh" is a high-volume search. The Christmas holidays are the next planning peak, so /kids needs to be indexed by mid-November.

## 1. Data model
- **`family_fit text`**, null when not for kids or unknown. Added to `happenings`, `happenings_staging`, `events`, `places`, `places_staging`, with a partial index. Values:
  - `kids`: aimed at children (Bookbug, soft play, a kids' workshop).
  - `all_ages`: good with kids, but for anyone (free museums, Botanics, Christmas lights).
- **New eligibility value `family`** for offers that only someone with children can use: "kids eat free", "under-5s swim free", "child goes free with an adult", Kids for a Quid. Added in `lib/happenings/types.ts:34`, `lib/happenings/groups.ts` (WHO group `families`), `scraper/happenings_research.py:160` and `scraper/deal_sources/gate.py:67`. Rows with eligibility `family` get `family_fit = 'kids'`. This reuses the "You qualify" machinery (`hero.ts:197`, `for-you.ts:72`).
- SQL: `supabase/add_family_fit.sql`. Safe to re-run, and the code falls back when the column is missing (same pattern as `add_event_lifecycle.sql`).
- Types and loaders: `Happening`, `EventItem` and `Place` get `family_fit`, selected in `lib/db/{happenings,events}.ts` and the places loaders and carried onto `FeedCardData`. A new `lib/happenings/family.ts` exports `isKidFriendly(card)`, the single helper every filter uses.

## 2. Tagging what we already have
- **Events (rules, no LLM), in `scripts/sources/`:** use the signals adapters already read (Skiddle `KIDS`, JSON-LD `ChildrensEvent`, Festivals `imaginate` and its genre regex, Forever Edinburgh term 876), plus a new `classifyFamilyFit()` in `core/normalize.mjs`.
  - Positive cues: kids, children's, family, toddler, under 5s, Bookbug, half term.
  - Negative cues: 18+, club night, nightlife.
  - Proper-noun guards, tested against today's false positives.
  - A probe checks Ticketmaster `classifications[].family` and Skiddle `minage`; use them only if they're present.
- **Happenings and deals (LLM):** add `family_fit` to the tool schemas and prompts in `happenings_research.py`, `deal_sources/extract.py` and `weekly_edinburgh.py`. It needs a supporting quote, like eligibility (`gate.py`). Carry it through `upsert_happenings.py` and `promote-happenings.mjs`.
- **One-off backfill, `scripts/tag-family.mjs`** (dry-run by default, `--apply` writes):
  - Rules first. `category = 'family'` → `kids`. Edinburgh places by category: museum, gallery, park, garden, beach, zoo, farm, library, leisure centre, country park, castle → `all_ages`.
  - DeepSeek only for the live happenings the rules can't decide, via `scripts/sources/core/deepseek.mjs` (off-peak guard and cap are built in; about $0.05).
  - Prints a review table first.

## 3. Family supply (sources)
The probe (20 Oct) found no family site with JSON-LD events: nms, nationalgalleries, rbge, edinburghzoo, dynamicearth, edinburgh.gov.uk, HES and NTS all lack it. So supply goes through the two LLM channels that already read plain pages, with the evidence gates. Nothing new is built.

**A. Stop dropping kids' deals (existing sources)**
1. `edinburgh-leisure-offers`: remove the "leave out under-5s" instruction, and widen the sitemap pattern to `soft-play|holiday-activities|holiday-camps|family-days-out|under-5`. Pages confirmed in the sitemap: Clambers, Tumbles and Scrambles soft play, holiday activities, holiday camps, family days out, the under-5s Play & Try week. Under-5s swim free (long-standing, not re-confirmed for 2026) gets checked here.
2. `fort-kinnaird-offers` (kids-dining is already read) and `forever-edinburgh-offers` (carries "kids eat free at Malones Leith"-style posts): now tag with `family` eligibility instead of `anyone`.
3. `resident-rewards`: World Children's Day (Camera Obscura, child free with a paying EH adult, 20 Nov) becomes `family` as well as `local_resident`.

**B. New deal sources** (`scraper/deal_sources/registry.py`, kind `urls`, start in shadow, approved through the weekly report as usual). Chain offers use the existing `national_ok` + `national_venue` fields, so each is tied to a named Edinburgh branch.
4. **ScotRail family offers.** Kids for a Quid (up to 4 children, 5–15, £1 return off-peak with a paying adult) and Kids Visit Free. Kids Visit Free gives one child free entry with a Kids for a Quid ticket at Edinburgh Zoo, Camera Obscura and Royal Yacht Britannia. The school-holiday Family Pass also runs on dated windows. The exact page URLs are fixed at build time; the `/tickets/kids-visit-free` guess returned 404.
5. **Kids' cinema clubs at Edinburgh cinemas.** Odeon Kids (Lothian Road, Wester Hailes, Fort Kinnaird), Vue Mighty Mornings and Big Shorts (OMNi, Ocean Terminal), Cineworld Movies for Juniors (Fountainpark), Picturehouse Cameo Kids' Club. Weekends and school holidays, about £2.50–£4.
6. **Chain kids' meals with Edinburgh branches.** Asda £1 kids' meal (year-round), Morrisons café kid's meal free with an adult meal of £5 or more, IKEA Edinburgh kids' meals. Re-checked by the gate every run, because chains change terms often.

**C. Weekly research topics.** Replace the single "family activities" topic in `scraper/weekly_edinburgh.py:177` with seven family topics at priority 84–78. They then run before the low-priority seasonal and sports topics.

| Topic | Kind | Seeds |
|---|---|---|
| Edinburgh museum and gallery family activities | whats-on | nms.ac.uk, nationalgalleries.org, edinburghmuseums.org.uk |
| Edinburgh school-holiday activities for kids | calendar | edinburgh.gov.uk/familyholidayactivities, edinburghleisure.co.uk/holiday-activities |
| Bookbug and library children's sessions | whats-on | edinburgh.gov.uk/libraries/libraries-fives, nls.uk |
| Kids eat free in Edinburgh | offers | edinburgh.org/planning/offers-deals/, fortkinnaird.com |
| Children's theatre and family shows | whats-on | capitaltheatres.com, lyceum.org.uk, scottishstorytellingcentre.com |
| Family days out and kids-go-free at Edinburgh attractions | offers | edinburghzoo.org.uk, dynamicearth.co.uk, rbge.org.uk, historicenvironment.scot |
| Kids' cinema clubs in Edinburgh | offers | the cinema chains above |

- **Bookbug** gets the city-level collection the pipeline already builds for parkruns (`weekly_edinburgh.py:529`): one free, weekly "Bookbug at Edinburgh libraries" card (ages 0–4), keeping each branch's page as a verification target. That needs the family allow-list there extended.
- **School-holiday calendar**: add an `edinburgh_school_holidays` list to `deal_sources/annual.yaml`, so the kids-eat-free topic and the family sources run more often in the 3 weeks before each break (Christmas, February, Easter, summer, October). The dates come from the council's term-dates page at build time.
- **Events adapter:** `scripts/sources/adapters/jazzbar.mjs` reads its "Family and Kids shows" collection as `family_fit = 'kids'`. It's currently always `music`.

**D. Family places**: a one-off curated Edinburgh list into `places_staging` → `promote-places.mjs`, tagged on the way in. About 60–80 rows:
- Playparks (Inverleith, the Meadows, West Princes Street Gardens, Saughton, Portobello promenade…)
- Soft play (the three Edinburgh Leisure ones plus independents)
- Gorgie Farm, Lauriston Farm
- Museum of Childhood
- Central Children's Library and branch libraries
- Leisure pools

Built with the local prompt in `discover_and_extract_city.py` and a family brief.

**E. Not used, on purpose**
- eventslist.co.uk, Edinburgh for Under 5s, Happity, Kids Pass, Mumsnet: aggregators or competitors whose listings are their product.
- Groupon and Wowcher: later, as affiliate feeds, after the move to Vercel Pro.
- Edinburgh Festivals API: stays on the existing to-do (licence key). Imaginate and the Storytelling Festival arrive once it's live.

## 4. Product surfaces
- **"With kids" chip** (`isKidFriendly`, `?kids=1`):
  - /whats-on: `WhatsOnClient.tsx:324`
  - /weekend: `WeekendClient.tsx:132`
  - /free: `FreeAnyTimeFilters.tsx`
  - Deals: a "Families" WHO chip in `groups.ts` and `DealFilters.tsx`
  - Explore: a "Kids" category in `lib/explore/categories.ts` and `app/api/explore/route.ts`
- **"I've got kids" pref** in `MakeFomoYours.tsx`, stored as `fomo_kids` in `usePrefs.ts`. It also adds `families` to `fomo_who`, so `family` deals show "You qualify".
  - Kid-friendly cards get a boost in `score.ts` `personalBoost`, and For You shows the reason "Good with kids".
  - Opted-in visitors get an "Out with the kids" rail on Home that links to /kids.
- **Mixed in for everyone:** drop the `family` exclusion in `lib/finds/candidates.ts:42` and `scripts/lib/weekly-picks.mjs:80`, and update their tests. One guard in `hero.ts`: `kids`-only items never take the Home hero slot or lead the weekly email. `all_ages` items can.
- **Badge:** "Good with kids", next to the existing "Kids free" badge (`lib/happenings/format.ts:64`).
- **Ask Fomo** (`app/api/chat/route.ts`):
  - Add category, family fit and eligibility to the catalogue lines (:293 and the event lines).
  - Add a rule: when the user mentions kids, a baby or family, only show `kids`, `all_ages` or `family`-eligible items.
  - Add a starter prompt in `lib/fomo-ai.ts`: "Rainy day with the kids under £10?"
- **`/kids` page**, "Free and cheap things to do with kids in Edinburgh". It clones the `/weekend` pattern (`pageMetadata`, `revalidate = 120`, `loadFeedForPage`, `itemListJsonLd`, `opengraph-image.tsx`).
  - Sections: This weekend · Kids go free and kids eat free · Free any time (museums, parks, playparks) · School holidays coming up.
  - A human intro, an FAQ with FAQPage JSON-LD, and a SubscribeCard with `source: 'kids'`, which fills `email_subscribers.who = ['families']`.
  - Added to the sitemap and linked from the footer and /weekend.
- **Analytics:** `kids_filter_toggled` (with surface), `kids_pref_set`, plus /kids pageviews and outbound clicks. A "Families" insight on dashboard 980079 via `scripts/posthog-dashboards.mjs`.

## 5. Getting it to parents (goes into the to-do list)
- Post /kids and a shared weekend plan in 3–5 Edinburgh parent Facebook groups and on Mumsnet's Edinburgh board. Ask the person who gave the feedback to share it in their school or nursery WhatsApp.
- One IG receipt carousel: "A £0 Saturday with the kids".
- **Bar by 30 Nov:**
  - /kids gets ≥15% of non-internal sessions.
  - ≥20 visitors opt into the kids pref.
  - Kid-friendly cards' outbound rate is at least the site average.
- **On 30 Nov**, decide on a family weekend email and seasonal pages ("Christmas with kids under £10").

## Build order (one PR per step)
1. SQL, types, `family` eligibility, event rules and tests. Then the backfill dry-run for your review, then `--apply`.
2. Supply A + B + C: unblock the existing sources, add the 3 new deal sources in shadow, the family topics, the Bookbug collection, the holiday calendar and the Jazz Bar collection. Then run the deal sources and the weekly pipeline once; you review the staging batch.
3. Family places list → promote.
4. Filters, pref, scoring, badge, Finds and email inclusion with the hero guard, and chat.
5. /kids page, sitemap and analytics.

## Files most touched
- **New:** `supabase/add_family_fit.sql`, `lib/happenings/family.ts`, `scripts/tag-family.mjs`, `app/(shell)/kids/*`
- **lib:** `lib/happenings/{types,groups,hero,format}.ts` · `lib/db/{happenings,events}.ts` · `lib/explore/categories.ts` · `lib/personalise/{usePrefs,score,for-you}.ts` · `lib/finds/candidates.ts`
- **scraper:** `scraper/{happenings_research,weekly_edinburgh}.py` · `scraper/deal_sources/{registry,extract,gate}.py` + `annual.yaml`
- **scripts:** `scripts/sources/core/normalize.mjs` + the skiddle, ticketmaster, jsonld and jazzbar adapters · `scripts/lib/weekly-picks.mjs`
- **App:** `components/personalise/MakeFomoYours.tsx` · the `*Client.tsx` files for whats-on, weekend, free, deals and Home · `app/api/{chat,explore}/route.ts`

## Verification
- **Tests:** `npx tsx --test`, `node --test scripts`, `pytest scraper`.
  - `classifyFamilyFit` true and false positives.
  - The `family` eligibility round-trip through the extract tool schema → gate → upsert.
  - The Edinburgh Leisure under-5s fixture is now kept.
  - The Bookbug collection.
  - The finds and weekly-picks family inclusion.
  - The hero guard.
- **Backfill dry-run:** spot-check 20 rows. Target ≥60 kid-friendly live happenings and events and ≥150 Edinburgh places.
- **Supply:** the first run of the deal sources and weekly topics lands in staging. Read the weekly report: aim for ≥40 new verified family rows, each with its quote, and ≥10 `family`-eligibility deals. Approve as usual.
- **Preview:**
  - Each "With kids" chip filters and survives a reload with `?kids=1`.
  - The pref shows the Home rail and "You qualify" on kids-free deals.
  - /kids renders on the server with valid ItemList and FAQPage JSON-LD and an OG image.
  - Ask Fomo, asked "something for a 4-year-old this Saturday", returns only kid-friendly items.
  - Check at 375px.
- **After you approve:** save to `docs/plans/2026-10-20-families-lens.md`, add the index row, and add the SQL, review and distribution to-dos to `docs/README.md`.
