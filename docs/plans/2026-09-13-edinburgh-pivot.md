# Miles — strip the trip layer, become an Edinburgh cheap-things app

## Context

Roameo was built as a post-arrival travel companion: you create a trip with a destination
and dates, and the app ranks "what should I do right now" against your itinerary. That
framing is being abandoned. The new app answers one question for one city:

> **What can I do in Edinburgh right now that's free, cheap, or discounted?**

The motivating failure: National Cinema Weekend ran 5–6 September 2026 — £4 tickets at 530
UK cinemas — and the user missed it. Nothing in the app could have surfaced it. The same is
true of Doors Open Days (free entry to ~1000 Scottish venues, Edinburgh 26–27 Sept), the
Real Mary King's Close St Andrew's Day free tickets (code `STANDREWS`), Forever Edinburgh's
Resident Rewards Days, and every pub's Monday 2-for-1. These aren't ticketed events, so no
events API returns them.

Two jobs, one branch: **remove the trip layer**, and **add the content type the app exists
for**.

### Decisions locked with the user

| | |
|---|---|
| **Surfaces kept** | Places + Map, Reels, ticketed events (Skiddle + Ticketmaster), Viator experiences, Miles chat, translator, taste preferences |
| **Removed** | Trips, itineraries, the Plan tab, disruption, draft-day, TripSwitcher, onboarding |
| **Accounts** | Auth + `profiles` stay so a shortlist follows you across devices. No trips. |
| **City** | Edinburgh, hardcoded behind one config module |
| **Home** | Hero + chronological feed hybrid — one ranked card with a causal reason, then a dated feed |
| **"Cheap"** | **Hard filter on the feed. Everything on the Map.** Two contracts, each honest. |
| **First run** | Straight to the feed. No onboarding; preferences move to Profile. |
| **Nav** | Feed · Reels · [Miles FAB] · Saved · Map |
| **Content hunted** | Offers/discounts, permanently-free things, recurring cheap nights, concession deals, free festival strands |
| **Rename** | Roameo **and** Miles → **Fomo** (see amendment 1). DB table names, env vars and the repo folder stay. |

---

## Amendments after the design hand-off (2026-09-12)

The Stitch mockups and `DESIGN.md` arrived after this plan was approved. They confirmed most
of it — the nav, the three date windows, the filter chips, the hero-with-causal-reason, the
date-bucketed feed, the "Free Any Time" floor zone, provenance on every card, and even the
three Ask-Fomo seed questions all match what was already specified. Four things changed.

**1. The app is Fomo, not Miles.** Every mockup is branded Fomo (F-with-arrow logo, "Ask
Fomo", "Fomo Insights", "Fomo Pick"), confirmed by the user. So the rename target changes,
and the partial *Miles* rename already sitting in the working tree
(`app/(shell)/miles/`, `lib/miles-ai.ts`, `components/miles/Card.tsx`) gets redone as Fomo.
`buildAskMilesHref` → `buildAskFomoHref`, `MilesCard` → `FomoCard`, route `/miles` → `/fomo`.

**2. Design system swap, and it is nearly free.** `app/globals.css` currently holds
**Celestial Glass Light** — the amber palette that is the *other* folder in the design
download. The new system is **Modern Maritime Edinburgh** (navy). Because it uses the same
Material 3 token names the app already had, and the same Plus Jakarta Sans, and the same
Material Symbols icon set, the palette was a pure value replacement. Done — see the commented
rationale in `app/globals.css`. Notes:
- The design doc's YAML frontmatter and its prose **disagree on hex values**; the frontmatter
  wins, verified by counting hex occurrences across the mockups' compiled `code.html`. In
  frontmatter terms the prose's "Primary" is `primary-container` (`#1b365d`), which is why
  that token carries the dominant navy.
- `md`/`lg`/`xl` radii were **already identical** to the new spec. Only `sm` (4px) and a new
  `base` (8px) tier were added. `2xl`/`3xl` are held over from the glass design and marked
  legacy — the re-skin should migrate them to `xl`, then delete them.
- The type scale is **tighter** than before (every tier drops 1–4px, label tiers gain
  weight), and adds `body-sm` + `label-lg`. Class names are unchanged, so ~20 screens
  re-tune in place. That is the intended effect of a full re-skin, not an accident.
- Added: `--spacing-*` tokens, navy-tinted `--shadow-level-1/2/3`, and
  `--color-hairline{,-strong}` (the design's boundaries are navy at low alpha, not `outline`).

**3. Re-skin scope is now full.** All ~20 screens get a deliberate pass, not just the four
designed ones.

**4. Schema gains four field groups the mockups require**, all now in
`supabase/add_happenings.sql`:
- `saving_amount` + `currency` — "FREE (Save £21.00)", "Usually £21.00", the map's "Pass
  Value £21.00", and the Saved screen's **"ESTIMATED SAVINGS £42.50 across saved items"**,
  which cannot exist without a numeric field.
- `district` — "Old Town", "Leith Shore"; on the feed hero, every map pin, every saved card.
  `places` has no district column either, so the Map work needs one derived or added there.
- `redemption_note` + `allowance_note` — "No code needed · auto applied", "Box office at
  door", "up to 2 complimentary tickets per verified resident household".
- `editorial_tag` + `cta_label` — "St Andrew's Day Special", "Civic Highlight"; and per-row
  CTAs that genuinely vary ("Claim Offer", "View Screenings", "Explore 40+ Venues", "Guide Map").

**Still open from the mockups**, not yet specified anywhere:
- The Map's category counts (Free Sights 412 · Pubs & Bars 894 · Music Venues 189 ·
  Museums 68 · Cheap Eats 740) must be derivable from `places.category`. The column exists;
  whether its values across the 3,369 rows map onto those five buckets is unverified.
- The Map bottom sheet shows **"Unfiltered Rank #3 of 3,369"** — that is `places.mention_count`
  surfaced as a visible rank, which needs a computed ordinal, not just the raw count.
- Three of the four `screen.png` exports are 28-byte failures; only the feed screen and the
  logo rendered. `code.html` is intact for all five and is the authoritative spec.

### One tension I could not resolve for you

You kept **Viator experiences**, and you chose a **hard cheap filter on the feed**. Viator
products under £10 barely exist, so experiences have almost nowhere to appear. Options, in
my order of preference:

1. **Discount-filtered** — surface only Viator products with a real promotional discount, as
   a `deal`-kind row in the feed. Gives experiences a legitimate home under the cheap
   promise. Needs a check of whether the Viator response exposes a list-vs-sale price.
2. Reachable from the Map and a "Worth booking" link, absent from the feed.
3. Accept that Viator is dormant for now and leave the code in place.

**This plan assumes (1), and falls back to (2) if Viator's payload has no discount field.**
Flagging rather than deciding, since it's the one place the two answers conflict.

---

# Part A — Remove the trip layer

This is the deep half. Everything content-related currently hangs off `trips.destination`,
and `RankContext` is built almost entirely from a `Trip`.

## A1. Eight generators lose their inputs

[lib/now/generators.ts](lib/now/generators.ts) has eleven candidate generators. Without an
itinerary, these eight have no inputs and get **deleted**, not stubbed:

`gap_filler` · `near_next` · `leave_by` · `arrival` · `current_activity` · `last_day` ·
`weather_swap` (needs an outdoor *anchor* to collide with) · `experience_leadtime`

These survive, re-centred on "cheap in Edinburgh":

| Generator | Change |
|---|---|
| `happening` | **New.** The feature's core. See Part B. |
| `event_tonight` | Now filters to free / under-threshold events only |
| `closing_soon` | Unchanged — needs only coords + `places.opening_hours` |
| `indoor_pick` | Unchanged — weather-driven |
| `reel_echo` | Unchanged |
| `saved_pick` | Unchanged |
| `local_pick` | The floor. Curated places by `mention_count`, now cheap-filtered |
| `family_pick` | Unchanged — persona-driven |

`practicality` is also deleted. It serves country-level arrival tips ("how SIM cards work
here"), which is meaningless in a single-city app for people who live there.

## A2. `RankContext` → `FeedContext`

`lib/now/types.ts`. The trip, `tripDay`, `tripPhase`, `todaysItems`, `planDensity`,
`currentItem`, `gaps`, `nextAnchor`, `nextAnchorCoords` and `practicalities` all go:

```ts
export interface FeedContext {
  at: Date;
  coords: Coordinates | null;
  coordsAreLive: boolean;           // keep — widens proximityDecay's flat radius when stale
  city: CityConfig;                 // hardcoded Edinburgh, see A3
  weather: DayForecast | null;
  prefs: TravelPreferences | null;  // preferences survive, trips don't
  signals: CardSignal[];
  savedItems: SavedItem[];
  candidateHappenings: Happening[];
  candidatePlaces: Place[];
  candidateEvents: EventItem[];
  candidateExperiences: Experience[];
}
```

[lib/now/context.ts](lib/now/context.ts) `buildRankContext` → `buildFeedContext`, losing its
first `Promise.all` (items/prefs/signals/saved/practicalities) down to prefs/signals/saved,
and keeping the second (places/events/experiences/forecast) plus happenings.

## A3. The city config — the one place Edinburgh is named

New `lib/city.ts` (no `server-only`; both client and server need it):

```ts
export interface CityConfig {
  slug: string;          // "edinburgh"
  name: string;          // "Edinburgh"
  region: string;        // "Scotland"
  countryCode: string;   // "GB"
  timezone: string;      // "Europe/London" — replaces trip.timezone everywhere
  center: Coordinates;   // 55.9533, -3.1883
  currencySymbol: string;
  localPostcodePrefix: string;  // "EH" — drives resident-only eligibility copy
}

export const CITY: CityConfig = { /* Edinburgh */ };
```

Every `trip.destination` / `trip.timezone` / `trip.lat,lng` read collapses to `CITY`. This
deletes `app/api/trips/resolve/route.ts`, the Mapbox `geocodeDestination` call path for
destinations, and `scripts/backfill-trip-geo.mjs`'s reason to exist.

Keeping it as one module (rather than inlining "Edinburgh") is what makes the second city a
config change rather than an archaeology project.

## A4. Deletions

**Pages / routes**

```
app/(shell)/plan/page.tsx
app/plan/{add,new-trip}/page.tsx
app/plan/{disruption/[id],item/[id]}/page.tsx
app/onboarding/**                        (page.tsx already deleted in the working tree)
app/setup/trip-*                          (keep travel-dna + always-remember, see A5)
app/api/now/{day,draft-day}/route.ts
app/api/disruption/route.ts
app/api/trips/resolve/route.ts
```

**Components / libs**

```
components/shell/TripSwitcher.tsx
lib/disruption.ts
lib/now/{dayplan,draftDay}.ts
lib/now/rails.ts                          (see A6 — the hero is all that survives)
lib/db/{trips,items}.ts
scripts/backfill-trip-geo.mjs
```

**Nav** — [components/shell/BottomNav.tsx](components/shell/BottomNav.tsx) is a fixed 4+1.
Swap the Plan slot for Saved: `Feed · Reels · [Miles FAB] · Saved · Map`. Minimal edit.

## A5. Preferences and first run

Preferences stay, onboarding goes. [app/setup/travel-dna](app/setup/travel-dna/page.tsx) and
[app/setup/always-remember](app/setup/always-remember/page.tsx) survive as **Profile-reachable
screens**, not a first-run gate. `travel_preferences` and `roameo_rules` keep their rows and
RLS; the feed simply ranks unpersonalised until you set them.

Dietary and mobility stay **hard filters**, per the existing `passesHardFilters`
([lib/now/rank.ts:108-118](lib/now/rank.ts:108)) — a vegetarian should never see a discount
on a steakhouse ranked at all.

## A6. Home: hero + feed

[app/(shell)/page.tsx](app/(shell)/page.tsx) today renders a hero plus N themed rails.
Rails were an itinerary idea ("2h 50m before dinner"); without one they have nothing to be
about. So:

- **Hero** — one ranked card, kept because its causal-reason copy is the best thing in the
  app: *"Free entry at Mary King's Close on Saturday — and it won't come round again this
  year."* Scoring stays (`baseScore × urgencyMultiplier × proximityDecay × noveltyDecay ×
  prefFit`), minus the deleted generators.
- **Feed** — a chronological, date-bucketed list below it. Not rails.
- `lib/now/rails.ts` is deleted; `RAIL_REGISTRY`, `RailSpec` and `GeneratorId`'s rail
  plumbing go with it. `selectHeroAndPool` reduces to "pick the hero".

`GET /api/now` keeps its `hero` and drops `rails[]`, `chips[]` and `next`. The five
`QUICK_ACTIONS` tiles ([page.tsx:36-42](app/(shell)/page.tsx:36)) shrink to the ones that
still exist.

## A7. Dropping the tables — deliberately last, and by hand

`saved_items.trip_id` and `card_signals.trip_id` are FKs to `trips`, and both tables have
live rows.

**Do the code removal first and ship it.** Only then, in a follow-up, run
`supabase/remove_trips.sql`:

```sql
alter table saved_items  drop column if exists trip_id;
alter table card_signals drop column if exists trip_id;
drop table if exists itinerary_items;
drop table if exists trips;
```

Dropping tables while code might still reference them is the one genuinely unrecoverable
step here, and there's no reason to couple it to the refactor. Unused tables cost nothing.

**One migration could not be deferred** — `supabase/decouple_chat_from_trips.sql`, written
during the refactor. `chat_messages.trip_id` is `uuid NOT NULL references trips(id)`
([schema.sql:102](supabase/schema.sql:102)), so once nothing creates trips there is no id to
supply and every chat insert fails. There is no code-only way around a NOT NULL column, so
chat — which the user chose to keep — would simply have broken.

It drops the NOT NULL and the FK, leaving the column in place, nullable and unused, to be
dropped later with the others. Chat becomes **user-scoped**, which is what it now is: one
conversation per person about one city. `user_id` already exists on the table with an
`own_rows` RLS policy ([harden_rls.sql:163](supabase/harden_rls.sql:163)), so RLS does the
scoping — the same pattern `lib/db/saved.ts` uses.

This does not violate the defer-the-destructive-step rule above: relaxing a constraint and
dropping an FK destroys no data and is reversible by re-adding both. Verified against the
live database first — `chat_messages` holds **0 rows**, so there is nothing to backfill or
orphan either.

---

# Part B — Happenings

## B1. Its own table — and the real reason why

Not rows in `events`. Four reasons, ranked by actual damage:

1. **Cache-TTL poisoning — this alone is disqualifying.**
   [lib/events/getForDestination.ts:96-106](lib/events/getForDestination.ts:96) computes cache
   freshness from `newestFetch` across *whatever `listUpcomingEvents` returned*. A single
   curated row with a recent `fetched_at` makes the whole destination look fresh and
   **suppresses the live Skiddle/Ticketmaster fan-out for six hours.** Curated rows would
   silently starve live events.
2. `events.starts_at` is `NOT NULL` ([add_events.sql:22](supabase/add_events.sql:22)).
   "2-for-1 every Monday" and "£5 off year-round with EHDISCOUNT" have no start time.
3. The documented purge is `delete from events where starts_at < now() - interval '7 days'`
   — that deletes an annual fixture's row, which is *next year's row*.
4. `events`' `limit` is applied in SQL ordered by `starts_at`, so curated rows crowd real
   events out of the page.

## B2. Schema — `supabase/add_happenings.sql`

Idempotent, run by hand in the Supabase SQL editor. Full column list, with the four fields
that matter most called out:

```sql
create table if not exists happenings (
  id uuid primary key default gen_random_uuid(),
  slug text not null,                  -- "uk-national-cinema-weekend-2026"; prefix carries geography
  title text not null,                 -- <= 8 words
  summary text,

  -- THREE kinds, not five: `seasonal`/`one_off` duplicate what `recurrence` encodes and
  -- `free_entry` duplicates `is_free`. These three map 1:1 to filter chips AND to
  -- staleness budgets.  deal | free_access | festival
  kind text not null,
  category text,                       -- reuses the /events chip vocabulary

  -- SCOPE IS LOAD-BEARING. National Cinema Weekend is UK-wide; Doors Open Days is
  -- Scotland-wide; both have city = null. Without `scope`, a city read that ORs
  -- city/address ilike '%Edinburgh%' matches neither and they never render.
  -- venue | city | region | national
  scope text not null default 'city',

  saving_label text,                   -- "£4 tickets" | "2-for-1" | "Free" — source's own figure
  is_free boolean,                     -- the filterable boolean; saving_label is display copy
  promo_code text,                     -- VERBATIM from source, exact case. Never constructed.

  -- anyone | local_resident | student | under_26 | over_60 | member | cardholder
  eligibility text not null default 'anyone',
  eligibility_note text,               -- "EH postcodes only, proof of address on the day"

  starts_at timestamptz,               -- both null for recurring / always-on
  ends_at timestamptz,
  recurrence jsonb not null default '{"type":"once"}'::jsonb,
  time_note text,                      -- "doors 10am-4pm" — DISPLAY ONLY, never parsed

  venue_name text, address text,
  city text, region text,              -- null at wider scopes
  country_code text not null,          -- ISO-2
  lat double precision, lng double precision,
  place_id uuid references places(id),

  image_url text,
  image_quality text default 'thin',   -- 'thin' by default ON PURPOSE: heroEligible requires
                                       -- 'ok' (lib/now/rank.ts:302-316), so a discount can
                                       -- never become the page's photo-hero. Correct.
  booking_url text,                    -- where you redeem; distinct from source_url
  source_name text not null,           -- "Forever Edinburgh" — rendered on every card
  source_url text not null,            -- the page that states the terms
  verified_at timestamptz not null,
  confidence text default 'medium',

  -- LIFECYCLE ONLY: live | dormant | retired.
  --   dormant = dated window passed but the row recurs (next year's row)
  --   retired = the offer genuinely no longer exists
  -- Staleness is DERIVED from verified_at at read time, never stored — there is no cron
  -- in this app, so a stored staleness flag is wrong whenever the sweep hasn't run.
  status text not null default 'live',

  priority int default 50,             -- 50 neutral; lets a curator lift Doors Open Days
                                       -- above a pub's 7.5% off without code changes
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- PLAIN (non-partial) unique index — a partial index cannot be a PostgREST on_conflict
-- target (Postgres 42P10), the trap documented at add_events.sql:40-45.
create unique index if not exists happenings_slug_key on happenings (slug);
create index if not exists happenings_city_status_idx on happenings (city, status);
create index if not exists happenings_country_scope_idx on happenings (country_code, scope, status);
create index if not exists happenings_window_idx on happenings (starts_at, ends_at);
create index if not exists happenings_verified_idx on happenings (verified_at);
```

Three repo conventions this must respect, each learned the hard way:

- **RLS**: write the select policy `to anon, authenticated` **from the start**, and add **no
  write policy** — writes go through `supabaseAdmin()`. See
  [add_practicalities.sql:27-41](supabase/add_practicalities.sql:27) and the
  "don't forget the re-grant" note at [harden_rls.sql:46-48](supabase/harden_rls.sql:46).
  Add `happenings` to `harden_rls.sql`'s catalog re-grant list so a future re-run can't
  narrow it.
- **No CHECK constraints** on taxonomy columns — TS unions instead
  ([add_practicalities.sql:20-25](supabase/add_practicalities.sql:20)). The one exception is
  `happenings_staging.extraction_status`, a pipeline state machine, matching
  `city_foods_staging`.
- **Never delete a row.** `sweep-happenings.mjs` flips `status`; nothing purges this table.

Also: `happenings_staging` (content columns + `batch_id`, `research_mode`, `source_urls[]`,
`field_sources jsonb`, `extraction_status` with its CHECK, `approved`, `promoted_at`,
`happening_id`), and `happening_sources` for per-field provenance, mirroring
[place_sources](supabase/add_japan_places_pipeline.sql:44).

## B3. Recurrence → occurrences

`lib/happenings/occurrence.ts`. **No `import "server-only"`** — the feed is a client
component. Same deliberate exclusion as [lib/events/format.ts:1-5](lib/events/format.ts:1).

```ts
export type Recurrence =
  | { type: "once" }                                                  // use starts_at/ends_at
  | { type: "always" }                                                // EHDISCOUNT, free museums
  | { type: "weekly"; days: number[]; until?: string }                 // 0=Sun..6=Sat
  | { type: "annual"; month: number; day: number; endDay?: number; until?: string }
  | { type: "dates"; dates: string[] };                               // Resident Rewards Days
```

`{ type: "dates" }` is the variant the obvious design misses and Forever Edinburgh's
Resident Rewards Days needs exactly: four fixed dates a year, announced individually, with
no formula. Without it those become four fake-annual rows or one wrong row.

**The key simplification: calendar days, not instants.** Recurring happenings have no clock
time, and synthesising one ("every Monday at 00:00 Europe/London") is where the bugs live
and buys nothing, since the feed sorts by day.

```ts
export interface Occurrence {
  happeningId: string;
  dayDate: string;        // "YYYY-MM-DD" in CITY.timezone — the primary sort key
  startsAt: string | null; // only when the row has a real starts_at
  endsAt: string | null;
  lastDayDate: string;    // === dayDate for single-day spans
  exact: boolean;         // false when generated from a recurrence rule
}

export const MAX_OCCURRENCES_PER_HAPPENING = 8;

export function nextOccurrences(h: Happening, from: Date, to: Date): Occurrence[];
export function localDayDate(at: Date, timeZone: string): string;
```

The occurrence cap is what makes a 12-month window usable: a weekly offer over a year is 52
occurrences, and 40 such rows would be 2,080 cards.

Timezone comes from `CITY.timezone` via `Intl.DateTimeFormat` — **do not add a date
library.** `package.json` has no date-fns/luxon/dayjs, and this repo hand-rolled a geohash
rather than take a dependency for one call site
([lib/events/geohash.ts](lib/events/geohash.ts)).

`time_note` is display-only and never parsed. Parsing "doors 10am-4pm" is where a correct
system starts inventing times.

## B4. Trust — the part that makes or breaks this

A stale deal is worse than no deal. `lib/happenings/format.ts` (also no `server-only`, so
server read path and client card share one implementation and cannot drift):

```ts
export const STALENESS_BUDGET_DAYS: Record<HappeningKind, number> = {
  deal: 21,          // pub/chain offers turn over monthly
  free_access: 60,   // Doors Open Days terms don't move weekly
  festival: 120,     // festival dates are announced and stable
};

// Anything happening within 7 days must have been verified within 14, regardless of kind.
// A wrong date inside a week is the one failure that destroys trust outright.
export const IMMINENT_DAYS = 7;
export const IMMINENT_BUDGET_DAYS = 14;

export type Freshness = "fresh" | "aging" | "stale";
export function freshness(h, nextOccurrenceDayDate, now?): Freshness;
```

**Two tiers, not one cliff.** `aging` (1–2× budget) still shows, with "last checked 5 weeks
ago — worth confirming". `stale` (past 2×) is hidden from both feed and hero. A hard cliff
at 21 days throws away a Wetherspoon offer that is almost certainly still running.

**The read path is authoritative** — it filters `status !== 'retired'` and
`freshness !== 'stale'` on every request. There is no cron in this app (`add_events.sql`
documents its own purge as manual), so a sweep-only design would be correct only on days
someone remembers to run it.

`scripts/sweep-happenings.mjs` does the two things a read path structurally can't:

- flips `live` → `dormant` where `recurrence.type === 'once'` and `ends_at < now()`
  (non-`once` rows are never flipped — that's the "next year's row" rule)
- `--emit-worklist` outputs rows past 1× budget, grouped by `source_name`, to feed
  `--mode verify`

`--dry-run` by default. Never deletes, never sets `retired` — retirement is a human judgment
after seeing a dead source page.

**Provenance on every card, non-optional:** `"Forever Edinburgh · checked 3 days ago"`, with
`source_url` as the link.

## B5. The feed

`lib/feed.ts` — one merged, date-ordered list. **Cheap is a hard filter here**, per your
decision:

| Source | Feed rule |
|---|---|
| Happenings | Always eligible — they *are* offers |
| Events | `priceSignalForEvent(e) === "cheap"` |
| Experiences | Discounted products only — see the flagged tension above |
| Places | **Not in the dated feed** (they have no dates) — they anchor the "Any time" zone |

**Reuse, don't reinvent the thresholds.** [lib/now/price.ts](lib/now/price.ts) already owns
"is this cheap": `priceSignalForEvent` (free, or `price_from <= 15`), `priceSignalForPlace`
(`price_level <= 1`), `priceSignalForExperience` (`price_from <= 20`). Its header explains it
was deliberately split out of `rank.ts` so there is exactly one band-fit formula rather than
two drifting copies — so the feed filter calls these, it does not declare its own numbers.

Note this resolves what looked like a conflict with the mockup's **"Under £10"** chip. Those
are two different things, and the design is right to separate them:
- **Feed eligibility** = "free, cheap, or discounted" → the `priceSignal === "cheap"` bands
  above. A £12 comedy night belongs in a cheap-things app.
- **"Under £10"** = a stricter *user-applied* chip, sitting alongside `All` and `Free`. It
  needs one new constant (£10) and nothing else.

Because `lib/now/price.ts` is `server-only`, the eligibility filter runs server-side in the
read path — which is where it belongs anyway.

**Two zones, because not everything has a date:**

1. **Dated feed** — happenings with real occurrences + cheap events, chronological, grouped
   under date-bucket headers (Today / This weekend / Next week / Later).
2. **"Free any time"** — a trailing, ranked (not dated) section of `recurrence: always` rows
   and permanently-free places: free national museums, galleries, viewpoints, walking
   routes.

Zone 2 is why you selected "permanently free things": it's the feed's **floor**, and it's
what stops a quiet February week from rendering empty. Without it, `{ type: "always" }` rows
would have to pin themselves to "today" every single day and crowd out the genuinely
time-limited things — the exact failure the app exists to prevent.

```ts
export type FeedRow =
  | { kind: "happening"; key: string; dayDate: string; happening: Happening; occurrence: Occurrence }
  | { kind: "event";     key: string; dayDate: string; event: EventItem }
  | { kind: "experience"; key: string; dayDate: string; experience: Experience };

// `key` MUST be `happening:{id}:{dayDate}` — a weekly offer produces 8 rows and a bare id
// collides in React's reconciler.
export function buildFeed(...): {
  sections: { dayDate: string; label: string; rows: FeedRow[] }[];
  anyTime: FeedRow[];
};
```

**Filter chips**, single-select, flat namespace so selection state stays unambiguous
(`festival` is both a `kind` and an `EventCategory`):

`All · Free · Under £10 · Deals · Festivals · Food & Drink · Music · Arts · Family`

**Date windows** — three, not four; `SegmentedControl` is cramped at 375px:
`Now` (→ end of tomorrow) · `This month` (+31d) · `Coming up` (+12 months). "Coming up" is
the National Cinema Weekend fix. The events fetch clamps its own `to` at +60 days regardless
— providers return nothing useful beyond that, and happenings carry the long tail.

**Pagination:** load happenings once, in full (one city is ~40–80 rows, a few kB) and hold
them in `useState`. Paginate events only, via the existing
[useInfiniteList](lib/useInfiniteList.ts) and its over-fetch-and-slice adapter. A `useMemo`
re-merges the whole array on every append, so happenings re-slot into place automatically —
no two-cursor reconciliation anywhere.

This interleaves **stably**, and I verified the assumption it rests on:
[lib/db/events.ts:33](lib/db/events.ts:33) orders `starts_at` ascending and
[lib/events/getForDestination.ts:205](lib/events/getForDestination.ts:205) re-sorts ascending
on every return path including the synthetic fallback. Since the adapter slices a growing
prefix of an ordered list, page N is always later-dated than page N−1.

**The Map keeps everything** — all 3,369 places, full price range, no cheap filter. Two
different contracts, each stated in its own UI.

## B6. Read path

`lib/db/happenings.ts` (`server-only`). Because Edinburgh is hardcoded, the city read is far
simpler than the events equivalent — but it needs the **scope rule**:

```
(city ilike '%Edinburgh%' or region = 'Scotland' or scope = 'national')
and status <> 'retired'
```

Without the scope arm, National Cinema Weekend (`city = null`, `scope = 'national'`) and
Doors Open Days (`region = 'Scotland'`) never render. This is the single easiest thing to
get wrong.

`lib/happenings/getForDestination.ts` — **a cache read only.** No provider fan-out, no TTL,
no upsert-on-read. Do not mirror the 200-line shape of `lib/events/getForDestination.ts`;
this is curated data.

`app/api/happenings/route.ts` — mirrors `/api/events`' param clamps. Unlike `/api/events` it
*can* do real offset pagination, being a plain DB read. No `listHappeningsNearby` — the app
is one city, so bbox+haversine would be dead code.

## B7. Hero generator

One generator, `happening`. Two would be wrong: the distinction that matters (urgent vs not)
is a *score*, not a *source*.

**`urgencyMultiplier` does not work here as-is.**
[lib/now/rank.ts:19-26](lib/now/rank.ts:19) only fires inside **90 minutes** of `validUntil`.
"Doors Open Days is this Saturday, last chance this year" gets ×1.0 and scores like a
permanent £5-off code — the exact miss this feature exists to prevent. Fix it in the
generator, not in `rank.ts`, tiering the base score by days-to-last-chance (same shape as the
existing `practicalityScore(index)`):

```
74 — last chance today/tomorrow   (above event_tonight's 70: a once-a-year free-entry
                                   weekend genuinely outranks a gig you could see next month)
64 — within 7 days
54 — within 31 days
44 — further out / always-on      (just above local_pick's 40)
then ±6 from `priority` (50 neutral)
```

**`distanceKm: null` and `coords: null` on every happening candidate, even when the venue has
real coordinates.** `proximityDecay` returns 1.0 on null
([rank.ts:78](lib/now/rank.ts:78)) — that's how the old city-wide `practicality` type
survived — but `WALK_BUDGET.low.zero = 1.6` km and `if (distanceKm >= zero) return 0`. A
venue happening 3 km away with real coords **scores exactly 0 and disappears**, and rain
shrinks that radius to 0.96 km. "£4 cinema tickets, the Odeon is 3 km away" must still show.
Distance goes in the copy instead. Add a comment next to the literal, or someone will
helpfully "fix" it.

One candidate per happening (the *next* occurrence only — never two cards for one deal),
skip anything `freshness() === "stale"`.

## B8. Cards, detail page, saved

`components/happenings/HappeningCard.tsx`, modelled on
[EventCard](components/events/EventCard.tsx): `list` + `carousel` variants, variant-specific
widths (not `w-full` + override, per its cascade note at `:42-45`), and `role="button"` on
the root rather than `<button>`/`<Link>` because it contains a `Chip`, which is itself a
`<button>` (`:20-27`).

Renders in order: `saving_label` as the lead, `title`, when, `venue_name`, a `kind` chip, an
**eligibility badge whenever `eligibility != 'anyone'`** ("Locals only" / "Students" / "60+"),
the `promo_code`, and `source_name · checked N days ago`.

`app/(shell)/happening/[id]/page.tsx` mirrors
[event/[id]](app/(shell)/event/[id]/page.tsx): `use(params)`, direct `getHappening(db, id)`
read (no API route), `PageHeader` / `PhotoCarousel` / `StatusPill`. Happening-specific: the
occurrence list, a **copy-to-clipboard promo code**, the eligibility note in full,
`source_name` as an outbound link plus "checked on", and the booking CTA.

**Subject type.** Adding `"happening"` to `CardSubjectType`
([lib/types.ts:338](lib/types.ts:338)) makes `lib/db/saved.ts` work with zero changes — it's
fully type-agnostic. TypeScript then points at the three `Record<CardSubjectType, …>` maps:
`CATEGORY_BY_SUBJECT` and `CATEGORY_GLYPH`
([Card.tsx:35-54](components/miles/Card.tsx:35)) and `QUESTIONS_BY_TYPE`
([chat-seed.ts:50-57](lib/chat-seed.ts:50)).

Two sites TS **won't** catch, which are therefore the ones that break:

- [app/api/saved/route.ts:89-188](app/api/saved/route.ts:89) `resolveCandidates` — an
  if/else chain that **silently skips** unhandled types, so a saved deal would just vanish
  from `/saved`. Add `listHappeningsByIds` and a branch.
- [lib/now/generators.ts:838-923](lib/now/generators.ts:838) `savedPick` — its own copy of
  that same chain.

`QUESTIONS_BY_TYPE.happening` is where chat earns its keep: *"Do I need a code?"*, *"Am I
actually eligible?"*, *"Is this still on?"*

---

# Part C — The research pipeline

Sourcing is Claude + web_search with provenance, following
[scraper/discover_and_extract_city.py](scraper/discover_and_extract_city.py) convention for
convention: `scraper/.env` (not the app's `.env.local`), `DEFAULT_MODEL = "claude-haiku-4-5"`,
server-side `web_search` in an open agentic loop, then **one forced tool-use call** for
structured output, per-field `field_sources`, and a validation pass that drops unsourced rows.

```
scraper/happenings/{__init__,base}.py
scraper/happenings/cities/{__init__,edinburgh}.py
scraper/happenings_research.py
scraper/upsert_happenings.py
```

New package rather than extending `scraper/countries/scotland.py`: `CountryConfig` is
contractually "a complete, non-overlapping partition of the country's admin units" for the
city-discovery loop, and is imported by three scripts. A per-city source list is a different
axis entirely.

**`known_fixtures` is what makes this reliable** — named search targets vastly outperform
open-ended "find deals in Edinburgh", and it's the direct fix for the Cinema Weekend miss:

```
Doors Open Days Edinburgh · National Cinema Weekend UK · Forever Edinburgh Resident Rewards
Days · Edinburgh's Hogmanay · Edinburgh Science Festival · Edinburgh International Film
Festival · St Andrew's Day free entry Scotland · Burns Night Edinburgh · Museums at Night /
late openings · Historic Environment Scotland free entry days · Free Fringe · Young Scot £1
Edinburgh Castle
```

Sources, split by mode (all verified to exist):

| Mode | Sources |
|---|---|
| `calendar` | `doorsopendays.org.uk`, `edinburgh.org/whats-on/`, `edinburgh.org/residentrewards/`, `edinburghfestivalcity.com`, `list.co.uk`, `whatsoninedinburgh.co.uk`, `nms.ac.uk`, `nationalgalleries.org` |
| `offers` | `edinburgh.org/planning/offers-deals/`, `5pm.co.uk`, `designmynight.com/edinburgh`, `realmarykingsclose.com` |
| `national` | `odeon.co.uk`, `cineworld.co.uk`, `nts.org.uk`, `historicenvironment.scot` |

**Three modes**, because they have different *failure modes* and therefore different truth
standards — calendar mode's catastrophic error is a hallucinated date; offers mode's is a
hallucinated promo code:

| Mode | Horizon | Target | Cadence | Emphasis |
|---|---|---|---|---|
| `--mode calendar` | 12 months | ~40 rows | quarterly | never invent a date; walks `known_fixtures` by name |
| `--mode offers` | rolling | ~30 rows | weekly | verbatim codes, explicit eligibility; `starts_at` usually null |
| `--mode verify` | — | worklist | weekly | re-checks `sweep --emit-worklist` rows, bumps `verified_at` |

**Build `--mode verify` in v0.** Without it, "checked 3 days ago" degrades into "checked 4
months ago" and the entire trust story in B4 collapses.

**System prompt rules** (mirroring the "prefer false when uncertain" bias in
[classify_reels.py:43-73](scraper/classify_reels.py:43)):

1. **Never invent a date.** No exact date in the source → `starts_at` null, describe timing
   in `recurrence` + `time_note`. A date copied from last year's page *is* an invented date.
2. **Promo codes verbatim**, exact case. Never construct, guess, normalise or complete one.
   A discount described without a printed code → `promo_code: null`.
3. **Eligibility must be explicit.** Anything other than `anyone` only when the source states
   who qualifies. Never infer "probably residents only".
4. Prefer `null` over guessing, every field.
5. **Savings are the source's own figure**, verbatim. Never round, never convert a percentage
   into an amount.
6. No expired one-offs — *unless* it's an annual fixture, recorded as `recurrence: annual`
   with no `starts_at`.
7. `field_sources` maps every populated factual field to the URL supporting it. No
   `source_urls` or no `field_sources` → row discarded.
8. `source_url` states the terms; `booking_url` is where you redeem. Never conflate them.
9. A permanent menu price is not a happening. A permanently-free museum *is*, if free entry
   is the notable fact.
10. Never cite an aggregator that only links elsewhere without stating the terms itself.

Python-side drops in `build_full_record`: no sources → drop; taxonomy outside its union →
drop; invalid `recurrence` → coerce to `once` if dated else drop; past-dated `once` → drop;
placeholder-looking `promo_code` (`^[<\[{X*]|CODE|XXXX`) → null the code but **keep** the row.

**Tail:** `scraper/upsert_happenings.py` copying
[upsert_supabase.py](scraper/upsert_supabase.py) (raw `requests`, `ALLOWED_COLUMNS`
whitelist, `Prefer: resolution=merge-duplicates`, `on_conflict=slug`), then
`scripts/promote-happenings.mjs` modelled on
[promote-japan-places.mjs](scripts/promote-japan-places.mjs) — raw Supabase REST, **not**
`@supabase/supabase-js` (its mandatory Realtime init throws under plain Node 20, see that
file's header), idempotent via approved-and-not-yet-promoted, paged at 1000 rows.
**One deliberate deviation: use `SUPABASE_SERVICE_ROLE_KEY`, not the anon key** —
`happenings` has no write policy by design, unlike `places`.

## Deferred: the Edinburgh Festivals Listings API

`api.edinburghfestivalcity.com/events` is real — free, self-service key, HMAC-SHA1 signed,
covering film/jazz/book/international/tattoo/art/hogmanay/science/imaginate/mela/storytelling
(Fringe needs approval). **Defer it**, for four reasons: HMAC request signing is unlike
anything in this repo (Skiddle/Ticketmaster/Mapbox are all plain `?key=`); it returns
individual *shows within* a festival, which is `events`' job, not happenings' (~8 festival
rows a year come free from `--mode calendar`); Fringe gating makes the v0 slice the least
valuable; and key registration is a manual human step that blocks the build. Revisit it as a
**third provider in `searchEvents`' fan-out**, not as a happenings adapter.

---

# Part D — Finish the rename

Mechanical, ~55 files, no behaviour change. Do it **first**, so everything after is written
in one vocabulary.

**The blocker:** `components/roameo/` was never renamed and still holds three live
components. `git mv` them into `components/miles/` and fix the three importers:

- `AvatarCropModal.tsx` — [app/(shell)/profile/page.tsx:29](app/(shell)/profile/page.tsx:29)
- `LanguagePicker.tsx` — [app/miles/translator/page.tsx:16](app/miles/translator/page.tsx:16)
- `LanguagesMultiPicker.tsx` — [components/onboarding/TasteForm.tsx:6](components/onboarding/TasteForm.tsx:6)

| What | Change |
|---|---|
| User-facing strings (26) | "Roameo" → "Miles" ("Roameo Rules" → "Miles Rules", "Roameo's Tips" → "Miles' Tips") |
| Log prefixes (17) | `[roameo]` → `[miles]` |
| JSDoc headers (~50) | "Roameo <Feature> —" → "Miles <Feature> —" |
| Identifier | `showAskRoameo` → `showAskMiles` ([Card.tsx:265,409](components/miles/Card.tsx:265)) |
| TS types | `RoameoRules{,Insert,Update}` → `MilesRules{,Insert,Update}` |
| Stale paths in prose | `README.md:86,113,117`, `app/(shell)/plan/page.tsx:509`, `app/api/practicalities/dismiss/route.ts:10` |
| Tooling | `.claude/launch.json:5` `roameo-dev` → `miles-dev`; regenerate `package-lock.json` (still `"name": "roameo"`) |

**Deliberately NOT renamed** — add a one-line comment at each site:

- **`roameo_rules` table** — a migration against live data for zero user benefit. TS types get
  renamed; `lib/db/rules.ts` notes the mismatch.
- **localStorage keys** `roameo_onboarding_already_there`, `roameo_reel_sound_on`,
  `roameo_reel_likes` — renaming silently resets liked reels and sound preference.
- **`roameo-shell-v1`** SW cache name — the version suffix *is* the cache-bust mechanism.

---

# Verification

1. `npx tsc --noEmit` clean. `grep -ri roameo app components lib` returns only the three
   documented exceptions.
2. **No test runner exists** (`package.json` has no vitest/jest). Verify `nextOccurrences`
   with a throwaway node script in the scratchpad — do not commit a test file.
3. Run `supabase/add_happenings.sql` by hand; confirm `happenings_slug_key` exists and is
   **not** partial.
4. `python scraper/happenings_research.py --city edinburgh --mode calendar --batch-id edi-2026-09-12 --dry-run`
   → inspect `scraper/out/<batch>/edinburgh-happenings.json`. **Acceptance bar:** National
   Cinema Weekend, Doors Open Days (26–27 Sept 2026), and Mary King's Close St Andrew's Day
   (`promo_code: "STANDREWS"`) all present, each with a `source_url` that states the offer,
   and **no row carrying a date its source didn't give**.
5. Upsert → approve in the Supabase dashboard → `node --env-file=.env.local scripts/promote-happenings.mjs`.
6. Dev server via the Browser pane (`preview_start`, never Bash). On Home: one hero with a
   causal reason, a date-bucketed cheap feed, a "Free any time" zone at the bottom, eligibility
   badges on resident-only rows, and `source · checked N days ago` on every happening card.
7. **Scope check** — confirm National Cinema Weekend (`city = null`, `scope = 'national'`) and
   Doors Open Days (`region = 'Scotland'`) both appear. This is the most likely silent failure.
8. **Distance check** — confirm a venue happening ~3 km out still appears in the hero pool
   (the `WALK_BUDGET.low.zero = 1.6` km trap).
9. Save a happening → open `/saved`. This is the branch that silently drops unknown subject
   types.
10. Set a `deal`'s `verified_at` back 60 days → `node scripts/sweep-happenings.mjs` → confirm
    it reads `stale`, leaves the feed, and is **not deleted**.
11. Map still shows the full 3,369-place Edinburgh layer, unfiltered by price.

---

# Sequencing

```
D (rename) ─► A (strip trips) ─► B1/B2 (schema) ─┬─► B3/B4 (pure logic) ─┬─► B6 ─┬─► B5 (feed)
                                                  │                       │      └─► B7 (hero)
                                                  │                       └─► B8 (cards/saved)
                                                  └─► C (pipeline) ──────────────────► promote
```

| Phase | Depends on | Delegable | Notes |
|---|---|---|---|
| **D** Rename | — | yes | Mechanical. Do first. |
| **A** Strip trips | D | yes | Largest diff. Ship and verify **before** dropping tables (A7). |
| **B1–B2** Schema | — | writes yes, **runs by hand** | Supabase SQL editor |
| **B3–B4** Occurrence + trust | B2 | yes (Haiku) | Pure functions, no DB, no network. Best first hand-off. |
| **B6** Read path + API | B2, B3 | yes | The scope rule is the thing to get right |
| **B5** Feed | B6 | yes | Parallel with B7/B8 |
| **B7** Hero generator | B6, A | yes | Parallel with B5 |
| **B8** Cards + saved + detail | B6 | yes | Parallel with B5 |
| **C** Pipeline | B2 only | yes | **Fully parallel with B3–B8** — different language, different directory. Longest wall-clock (real web searches). |

**Needs a human, not an agent:** running `add_happenings.sql` and `remove_trips.sql` in the
Supabase editor, and approving staging rows before promotion — human approval is the entire
point of a staging table.
