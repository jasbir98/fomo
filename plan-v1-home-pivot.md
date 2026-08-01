# Roameo v1 — post-arrival companion pivot

Implementation brief. Written against the codebase as of 2026-08-01. Sections are
self-contained enough to hand to a build agent individually; §9 (ranker) and §10
(schema) are prerequisites for everything else.

---

## 0. Decisions locked

| Question | Decision |
|---|---|
| Home's organising unit | A ranked "right now" moment, presented **photo-first** |
| Chat's role | A destination, reachable from every card via **Ask Roameo** with seeded context. It does **not** become the container |
| Depth (reasoning, full day, gap-filling) | Lives in **Plan**, not Home |
| Events + Experiences | Surfaced on Home as photo tiles, browsable via **intent chips** → picture grids. No Explore tab |
| Reels | Keeps its nav slot, unchanged internally, gains the shared action row |
| Navigation | Unchanged: Home · Reels · [Roameo FAB] · Plan · Map |
| Push notifications | **Designed for, not shipped.** Ranker must be server-side and time-addressable |
| Traveller types | Not a user setting — the ranker branches on **today's plan density**, recomputed daily |
| Voice | Commit to one recommendation, always with a causal reason attached |
| Best of the City | **v2.** v1's quiet-moment floor is curated places ranked by reel-mention frequency |
| Voice I/O, money features, full offline | v2 |

---

## 1. What changes, at a glance

**Replaced**

- `app/(shell)/page.tsx` — the 535-line stacked dashboard (nearby places / events /
  experiences shelves, distance-sorted). Rebuilt entirely per §4.
- `app/(shell)/90-minute-wins/page.tsx` — a hardcoded `QUICK_WINS` array of Tokyo
  mock data. Its concept survives as the **gap block** in Plan (§5), backed by real
  ranked candidates. Delete the route.
- `app/setup/connect-calendar/page.tsx` — mock calendar connect. Delete.
- `app/setup/trip-detected/page.tsx` — folded into trip creation. Delete.

**Extended**

- `lib/disruption.ts` — logic is sound and stays. What changes is where it surfaces:
  from a screen you navigate to (`app/plan/disruption/[id]`) into the lead block on
  Plan and a candidate for Home's hero.
- `app/(shell)/plan` — becomes the depth surface: timeline, gaps, inline swap.
- `app/api/chat` — accepts a seeded context payload.
- `app/(shell)/map` — unchanged core; place sheet adopts the shared action row.
- `app/(shell)/reels` — unchanged feed; reel cards gain the shared action row and
  feed the `mention_count` ranking signal.

**Moved**

- `app/setup/travel-dna` — out of the onboarding gate, into Profile as optional, plus
  learned from signals (§3).
- `app/setup/always-remember` — out of onboarding; Roameo offers to remember things
  mid-conversation instead.

**Unchanged**

- Translator, Experiences provider integration (Viator), Events providers
  (Skiddle/Ticketmaster), the curated places pipeline, `app/(shell)/social/[id]`.

---

## 2. Navigation and information architecture

Bottom nav stays exactly as `components/shell/BottomNav.tsx` defines it:

```
Home · Reels · [Roameo FAB] · Plan · Map
```

Profile remains off the nav (header avatar on Home, as today).

Surface ownership:

- **Home** — what's happening now, what's next, a few image-led options for the gap
  you're in. Shallow by design.
- **Plan** — the day and the trip. Timeline, gaps, swaps, reordering, reasoning in full.
- **Map** — geography. Unchanged.
- **Reels** — inspiration. Unchanged.
- **Roameo (FAB)** — conversation. Reachable from every card.

Events and Experiences have no tab. They appear as (a) tiles in Home's rails when
time-relevant, and (b) the contents of chip-opened picture grids (§6).

---

## 3. Onboarding

### Current flow (7 screens before the app does anything)

`app/onboarding` (3 slides) → `app/setup/connect-calendar` (mock) →
`app/setup/trip-detected` → `app/setup/travel-dna` (3 sliders + interests + dietary +
mobility + languages) → `app/setup/always-remember` → app.

### New flow (1 screen, 2 questions)

**Screen 1 — "Where are you going?"**

- Destination field, backed by the existing `app/api/geocode`.
- Below it: date range picker, plus a prominent secondary action **"I'm already there"**
  which sets `start_date = today` and drops the user straight into Home on day 1.
  This matters — post-arrival positioning means many installs happen mid-trip.

That's it. Writes a `trips` row and goes to Home.

**Cut from the gate entirely:**

| Screen | Where it goes |
|---|---|
| 3 intro slides | Deleted. The Home cold-start card (§4.4) does this job with real content |
| Calendar connect | Deleted. It was a mock |
| Trip detected | Deleted. Redundant with the destination question |
| Travel DNA | Optional card in Profile. Also **learned**: `interests` accrete from `card_signals` (§10) — saves, adds, and dismissals |
| Always remember (rules) | Roameo offers mid-chat: *"Want me to remember you're vegetarian?"* → writes `roameo_rules` |

**Progressive capture rules**

- Never block. Every prompt is dismissible and never re-asks more than twice.
- Dietary is the one preference worth asking early, because getting it wrong is
  actively harmful in food recommendations. Ask it the **first time a food card is
  tapped**, inline, one question: *"Anything you don't eat? It changes what I suggest."*
- Display name / avatar: never asked. Profile has the fields if someone wants them.

**Location permission** is asked on Home, in context, with the value already visible —
not at cold start where it gets denied (§12).

---

## 4. Home

### 4.1 Anatomy, top to bottom

```
┌──────────────────────────────────┐
│ status: clock · city · day n of m│
│ trip name                 avatar │
├──────────────────────────────────┤
│                                  │
│   HERO  (208px, photo)           │  ← ranked #1
│   [pill: Right now / Now · until]│
│   ORANGE CAUSAL REASON           │
│   Headline (≤ 8 words)           │
│   One line of detail             │
│   [primary] [Ask Roameo] [Nah]   │
│                                  │
├──────────────────────────────────┤
│ [thumb] NEXT · leave 19:05     › │  ← next anchor, or empty-plan prompt
│         The Gardener's Cottage    │
├──────────────────────────────────┤
│ (chip) (chip) (chip)             │  ← 3 intent chips, context-dependent
├──────────────────────────────────┤
│ Rail title              meta     │
│ [tile] [tile] [tile] →           │  ← horizontal photo rail, ranked #2–#6
└──────────────────────────────────┘
```

**Hard limits.** One hero. One next row. Three chips. One rail. Nothing else ships on
Home in v1. Every addition past this is a step back toward the dashboard.

### 4.2 The hero

Two modes, chosen by whether an itinerary item is currently in progress:

- **In progress** — pill reads `Now · until 14:30` on white. Content is the current
  activity: its photo, a useful line about being there, and a contextual primary action
  (directions inside, what to order, the thing most people miss).
- **Between things** — pill reads `Right now` on orange, or `Closing soon` when the
  lead candidate is time-gated. Content is the top-ranked suggestion.

**The reason line is mandatory and causal.** "Because the shutters go down at five" —
not "a popular local market." It is the mechanism that lets Roameo commit without being
obnoxious when it's wrong: the user can dismiss the reasoning, not just the result.

**Text budget above the fold:** reason line (≤ 6 words), headline (≤ 8 words), detail
(≤ 18 words). Anything longer belongs in Plan or in chat.

**Action row:** primary (contextual verb — "Add to today" / "Take me there" /
"Swap them"), "Ask Roameo", and a ghost **"Nah"**.

**"Nah"** is one tap, no dialog, no confirmation. It writes a `card_signals` row and
immediately re-renders the hero with the next candidate. This is the only negative
feedback channel in v1 and it does double duty as preference learning.

### 4.3 The rail

3–6 tiles, 128px wide, horizontal scroll. Each tile: photo, name, a one-line opinion in
orange (`"Queue starts at nine"`, `"Empty on a weekday"`), and a distance or time.

**Diversity constraint:** at most one tile per card type. This is the single rule that
prevents the rail collapsing back into "nearby places, nearby events, nearby
experiences." Enforce it in the ranker, not the component.

Rail title is written by the ranker and changes with context: `Near you now`, `For
after`, `Tonight nearby`, `Before you turn in`, `From your reels`.

### 4.4 States through a day (drifter day, no plan)

| Time | Hero | Next row | Rail |
|---|---|---|---|
| 08:10 | Top suggestion, morning-weighted | "Nothing booked today — tap to build one" | Near you now |
| 13:20 | Current activity, `Now · until 14:30` | Next anchor with leave-by | For after |
| 16:40 | `Closing soon` — hours-gated candidate | Evening anchor | Tonight nearby |
| 20:15 | Evening suggestion | Tomorrow's first gap | From your reels |

### 4.5 Cold start (day 1, no plan, no location, no history)

This is the state that decides the direction. It must be good.

- Hero reason: `Because you landed 40 minutes ago`
- Hero: arrival advice keyed to destination and arrival airport — practical, not
  aspirational. Suica from the machine not the counter; eat before eight because your
  body thinks it's the middle of the night.
- Primary action is **"Turn on location"** — the permission ask, in context, with the
  value already visible on screen.
- Rail title: `Guessing from your hotel until location's on`.
- One rail tile is always an empty-plan prompt: *"Nothing's on your plan yet. That's
  fine — tell me one thing you want to do and I'll build around it."*

Arrival content comes from a small per-destination `arrival_tips` set (§10), authored
once per covered country. Japan and Scotland only in v1; elsewhere the ranker falls
back to the generic drifter hero.

---

## 5. Plan

Plan becomes the reading surface. Three block types on one vertical timeline.

### 5.1 Disruption block (top, when triggered)

Full-width navy card, above the timeline. Content from `lib/disruption.ts`, unchanged
in logic, but argued at length rather than compressed:

> **Because your 3pm is outdoors**
> **Rain from two. Move Arthur's Seat to tomorrow morning.**
> 90% chance, heavy, and it doesn't clear before six. Tomorrow's dry until eleven — the
> walk is better then anyway, and your morning's empty. I'd put the National Museum in
> this afternoon instead: ten minutes from you, free, and you can stay as long as the
> rain does.
>
> [Swap them] [Other options] [Leave it]

"Swap them" mutates two `itinerary_items` rows and is undoable for the rest of the
session. `app/plan/disruption/[id]` stays initially as a deep-link target, then retires
once this block is live.

### 5.2 Timeline

Past items dimmed with a filled marker. Current item ringed in orange. Future items
normal. Each row: thumbnail, title, time, and one line of logistics (`Booked · leave
19:05, take the 26`).

Leave-by is computed from walking distance and, when it's raining or the walk exceeds
25 minutes, suggests transit instead.

### 5.3 Gap blocks

Any window over 90 minutes between anchors renders as a dashed block:

> **2h 50m free · rain**
> **Three ways to spend it, all indoors**
> [photo card] [photo card] [photo card]

This is `90-minute-wins` made real: gap-length aware, location aware, weather aware,
drawn from `places` rather than a hardcoded array. Each card carries the shared action
row.

**Empty-day case:** a day with no anchors renders as one full-day gap block —
*"Nothing on Thursday yet. Want me to draft it?"* — which generates a 3-item skeleton
the user can accept, edit, or ignore.

---

## 6. Chip result surface

One route, `app/(shell)/discover/[intent]`, rendering a two-column picture grid.

**Chips are context-dependent**, max three on screen:

| Chip | Intent | Query |
|---|---|---|
| Tonight | `tonight` | `events` where `starts_at` between now and 02:00 tomorrow, walkable, plus experiences bookable for tonight |
| Book something | `book` | `experiences`, tomorrow onward (Viator needs lead time) |
| Eat near me | `eat` | `places` where category is food, open now, ranked by `mention_count` then rating |
| A few hours | `gap` | Mixed, filtered to fit the current gap length. Only shown when a gap exists |
| Indoors near me | `indoors` | Same as `gap`, weather-filtered. Replaces "A few hours" when it's raining |

**Never a blank state.** The view arrives pre-filtered and pre-answered; the filter row
at the top lets you widen it. Header states the count and the constraint: *"Eleven
things, all within 25 min."*

Each tile: photo, a badge with time and price, name, and one line of opinion — *"They
teach the steps first"*, *"Be there before eight"*, *"Touristy, genuinely fun"*.

**Empty result copy** is written, not generic:

> Nothing much on in Kanazawa tonight — it's a quiet town on a Tuesday. Here's what's
> worth doing anyway.

…followed by the `local_pick` floor rather than a dead end.

---

## 7. Ask Roameo

Every card and detail screen carries an **Ask Roameo** action. It deep-links to chat
with a context payload:

```ts
type ChatSeed = {
  type: "place" | "event" | "experience" | "itinerary_item" | "reel";
  id: string;
  name: string;
  city: string | null;
  coords: { lat: number; lng: number } | null;
  returnTo: string;
};
```

Behaviour:

1. Chat opens with a compact **context card** pinned at the top (thumbnail, name,
   category, distance) so it's visually obvious what Roameo is talking about.
2. Three suggested questions render as chips, templated per `type` and category —
   never an empty input. Food: *"Is it worth the queue?"* / *"What do I order?"* /
   *"How do I get there?"*. Event: *"What's it actually like?"* / *"Do I need to book?"*
   / *"What do people wear?"*.
3. The seed is injected into the system context for the turn, not into the visible
   message list.
4. Closing returns to `returnTo`, not to the Roameo tab.

Chat retains its standalone entry via the FAB, unchanged.

---

## 8. The card primitive

One component, one action row, rendered identically everywhere — Home rail, Plan gap,
chip grid, Map sheet, chat results, Reels.

```
Actions:  [primary contextual verb]  Ask Roameo  Directions  Save
```

- **Primary verb** varies by type: `Add to today`, `Book`, `Take me there`, `Watch`.
- **Directions** hands off to the Map tab, not an external app.
- **Save** writes `saved_items` (§10) and is the only way to build a personal shortlist.
  There is currently no saved concept in the app; this closes the recall gap that a
  ranked, ephemeral Home otherwise creates.

This consistency — not chat — is what makes the six features feel like one product.
Every surface renders the same object with the same affordances.

---

## 9. The ranker

### 9.1 Placement

Server-side, `lib/now/`, mirroring the `lib/disruption.ts` / `lib/events/` pattern
(`import "server-only"`). **Not in the Home component.** The current distance sort lives
client-side in `app/(shell)/page.tsx`; that must move, because a v2 push job needs to
call the same function with a future `at` and a stored last-known location.

### 9.2 Inputs

```ts
type RankContext = {
  at: Date;                    // device local time, trip tz
  coords: Coordinates | null;  // live GPS → last known → hotel → destination centroid
  trip: Trip;
  tripDay: number;
  tripPhase: "arrival" | "early" | "mid" | "last-day" | "departure";
  todaysItems: ItineraryItem[];
  planDensity: "none" | "light" | "full";   // 0 / 1–2 / 3+
  currentItem: ItineraryItem | null;
  gaps: { startsAt: Date; endsAt: Date; minutes: number }[];
  nextAnchor: ItineraryItem | null;
  weather: DayForecast | null;              // lib/weather.ts
  coverage: "curated" | "live";             // curated place density near coords
  prefs: TravelPreferences | null;
  signals: CardSignal[];                    // dismissals, saves, opens
};
```

### 9.3 Candidate generators

Each emits zero or more candidates with a `baseScore`. Priority order is the tie-break.

| Generator | Fires when | Base |
|---|---|---|
| `weather_swap` | An outdoor anchor collides with rain/storm | 100 |
| `current_activity` | `currentItem != null` | 95 |
| `leave_by` | Next anchor's travel time means leaving within 20 min | 90 |
| `closing_soon` | Curated place near you closing within 90 min | 80 |
| `arrival` | `tripPhase === "arrival"` and < 6h since start | 78 |
| `event_tonight` | Event starts within 6h, walkable | 70 |
| `gap_filler` | An open gap over 90 min | 65 |
| `experience_leadtime` | Bookable experience fits an empty tomorrow, needs booking today | 60 |
| `last_day` | `tripPhase === "last-day"` | 58 |
| `local_pick` | Always — the floor | 40 |
| `reel_echo` | A saved/liked reel's place is within 30 min | 38 |

`local_pick` is curated `places` ranked by `mention_count` (§10), then rating, then
proximity. It guarantees the stack is never empty, in any city with curated coverage.

### 9.4 Scoring

```
score = baseScore
      × urgencyMultiplier   // 1.0 → 1.6 as a hard time cutoff approaches
      × proximityDecay      // 1.0 at 0 min walk → 0.4 at 25 min → 0 beyond, unless anchored
      × noveltyDecay        // 0.5 if shown today, 0.15 if dismissed, 0 if dismissed twice
      × prefFit             // 0.8 → 1.2 on interest overlap
      × coherence           // 0 if it clashes with a booked item's window
```

Dietary and mobility are **hard filters, not scores**. A vegetarian never sees a yakitori
counter ranked at all.

### 9.5 Selection

1. Highest score becomes the hero.
2. Remaining candidates fill the rail, **one per generator type** (the diversity
   constraint).
3. Rail title is derived from the dominant generator among the survivors.

### 9.6 API contract

```
GET /api/now?tripId=&deviceId=&lat=&lng=&at=
```

```jsonc
{
  "mode": "planner" | "drifter",
  "hero": {
    "cardType": "closing_soon",
    "subject": { "type": "place", "id": "…" },
    "pill": "Closing soon",
    "why": "Because the shutters go down at five",
    "headline": "Nakamise-dōri now, or not today",
    "detail": "6 min walk. Ningyō-yaki from the stall with the queue.",
    "primaryAction": { "label": "Take me there", "kind": "directions" },
    "image": { "url": "…", "quality": "ok" },
    "urgency": "high",
    "validFrom": "2026-10-14T16:00:00+09:00",
    "validUntil": "2026-10-14T17:00:00+09:00"
  },
  "next": { … } | null,
  "chips": [ { "intent": "tonight", "label": "Tonight" }, … ],
  "rail": { "title": "Tonight nearby", "meta": "6 things", "items": [ … ] },
  "degraded": "no-location" | "no-coverage" | null
}
```

`validFrom` / `validUntil` / `urgency` are the push-forward. In v1 the client requests
this on open and on significant location change. In v2 a cron calls the same function
per device and pushes any card with `urgency: "high"` — no rewrite.

### 9.7 Copy generation

Templates first, LLM second. Each generator owns a small set of causal reason templates
filled from real data (`Because the shutters go down at {closeTime}`). The **detail**
line is LLM-written per place at pipeline time and cached on the row — not generated per
request. This keeps Home's cost near zero per open and its latency near zero, which is
the whole reason this shape beats a conversation-first Home.

---

## 10. Data and schema

All migrations follow the existing convention: idempotent, run once in the Supabase SQL
editor, commented, anon RLS matching the surrounding table's policy shape.

### 10.1 `itinerary_items` — real times (blocking)

The single biggest schema debt. `time_label` is free text and `day_date` is a date, so
gaps, leave-by, and "current activity" cannot be computed reliably.

```sql
alter table itinerary_items add column if not exists starts_at timestamptz;
alter table itinerary_items add column if not exists duration_minutes int;
create index if not exists itinerary_items_starts_at_idx
  on itinerary_items (device_id, starts_at);
```

Backfill by parsing `time_label` against `day_date` with the trip's timezone; keep
`time_label` for display, since it carries user phrasing ("morning", "after lunch") that
a timestamp can't. Items that fail to parse get `starts_at = null` and are treated as
unscheduled — they appear on the day but don't create or close gaps.

### 10.2 `places` — structured hours and ranking signal

```sql
alter table places add column if not exists opening_hours jsonb;
alter table places add column if not exists mention_count int default 0;
alter table places add column if not exists mention_sources jsonb;
alter table places add column if not exists detail_line text;
alter table places add column if not exists image_quality text;
create index if not exists places_mention_count_idx on places (mention_count desc);
```

- `opening_hours` — persist Google Places `regularOpeningHours`. Required by
  `closing_soon`, which is one of the highest-value generators. Today's `hours` text
  column can't be compared against a clock.
- `mention_count` / `mention_sources` — populated by a script cross-referencing
  `social_posts` and the reels staging table against `places` by name + proximity. This
  is the v1 Best-of floor and the one ranking signal nobody else has.
- `detail_line` — the cached, LLM-written one-liner used by the hero and tiles.
- `image_quality` — see §11.

### 10.3 New tables

```sql
create table if not exists card_signals (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  trip_id uuid references trips(id) on delete cascade,
  card_type text not null,
  subject_type text not null,      -- place | event | experience | itinerary_item | reel
  subject_id text not null,
  action text not null,            -- shown | opened | dismissed | saved | planned
  created_at timestamptz default now()
);
create index if not exists card_signals_device_created_idx
  on card_signals (device_id, created_at desc);
create index if not exists card_signals_subject_idx
  on card_signals (device_id, subject_type, subject_id);

create table if not exists saved_items (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  trip_id uuid references trips(id) on delete cascade,
  subject_type text not null,
  subject_id text not null,
  note text,
  created_at timestamptz default now()
);
create unique index if not exists saved_items_unique
  on saved_items (device_id, subject_type, subject_id);

create table if not exists device_location (
  device_id text primary key,
  lat double precision,
  lng double precision,
  updated_at timestamptz default now()
);

create table if not exists arrival_tips (
  id uuid primary key default gen_random_uuid(),
  country text not null,
  city text,
  headline text not null,
  detail text not null,
  applies_hours_from int default 0,
  applies_hours_to int default 12
);
```

Each needs the `anon_all` RLS policy pattern used by the other device-scoped tables;
`arrival_tips` takes the shared-read `anon_select` pattern used by `places`.

`device_location` stores **coarse** coordinates only — round to 2 decimal places
(≈1.1 km) before writing. It exists for graceful degradation and for v2 push, not for
tracking, and it's written only while permission is granted. Delete the row when
permission is revoked.

### 10.4 Ranking floor script

`scripts/` gains a mention-crossref pass: for each `social_posts` / scraped reel row
with a resolvable location, match against `places` by fuzzy name within 300 m,
increment `mention_count`, append the source to `mention_sources`. Same shape as the
existing promote scripts. Run per destination, not globally.

---

## 11. Photography

An image-led Home is only as good as its worst tile, and this is a real new cost. The
existence of `supabase/fix_broken_images.sql` says broken images are already a known
problem.

**Rules**

1. `image_quality` is set at write time: `ok` (≥ 800px wide, loads, not a placeholder),
   `thin` (small or low-confidence), `none`.
2. **The hero requires `ok`.** A candidate with a `thin` or `none` image can win the
   ranking but renders in the **typographic fallback** — navy card, no photo, the reason
   line and headline set larger. This is the previous design pass demoted to a fallback,
   which is the right place for it.
3. Rail tiles accept `thin`; they never render `none` — those candidates drop to the
   next slot.
4. A validation pass runs over curated Japan/Scotland rows before launch, flagging every
   row that would fail the hero test. Expect this to be a meaningful chunk of the ~3,400
   Scotland rows.

Google Places photos are fetched through the existing `app/api/media-proxy`.

---

## 12. Permissions and offline

**Location.** Asked on Home, in context, as the hero's primary action on cold start —
never at app launch. Until granted, the ranker runs on the fallback chain (last known →
hotel/first item → destination centroid) and Home states it plainly: *"Guessing from
your hotel until location's on."* Degraded, not broken.

**Notifications.** Not requested in v1. No prompt anywhere.

**Offline slice** (non-negotiable, small). `public/sw.js` currently precaches
`/offline`, the manifest, and icons. Extend to cache:

- today's `itinerary_items` and their thumbnails,
- `saved_items` and their place rows,
- the last translator result.

Service worker + localStorage read-through. No sync, no offline writes, no offline maps.
This exists because post-arrival is exactly when connectivity fails — foreign SIM not
activated, Tokyo Metro platforms, the A82 north of Glencoe — and the translator dying
underground breaks the most-used feature at its highest-need moment.

---

## 13. Voice

### Rules

- Second person, present tense, contractions.
- **One recommendation, one reason.** Never a list of three options presented as
  equals — that's hedging with extra steps.
- The reason is causal and bound to time or place. *"Because the market shuts at five."*
  Not *"a popular local market."*
- **Specificity is the whole trick.** Name the street, the station, the dish, the stall.
  "The stall with the queue of grandmothers" reads as someone who's been there;
  "authentic local snacks" reads as a brochure.
- Banned: *discover, explore, immerse, hidden gem, must-see, vibrant, bustling*. No
  stacked exclamation marks.
- Admit limits rather than bluffing: *"I don't know Aviemore well yet — here's what I can
  actually see."*

### Examples

**Hero, closing soon**
> Because the shutters go down at five
> **Nakamise-dōri now, or not today**
> 6 min walk. Ningyō-yaki from the stall with the queue.

**Hero, mid-activity**
> You're here until half two
> **teamLab Planets**
> The water room's at the end — don't rush the first three.

**Hero, cold start**
> Because you landed 40 minutes ago
> **Don't plan anything yet. Eat, then sleep early.**
> Suica from the machine, not the counter — same card, no queue.

**Plan, disruption**
> Rain from two. Move Arthur's Seat to tomorrow morning. 90% chance, heavy, and it
> doesn't clear before six. Tomorrow's dry until eleven — the walk is better then
> anyway, and your morning's empty.

**Chat, seeded from a ramen place**
> User: is it actually worth queuing for
> Roameo: Honestly, yes — but not for an hour. It's karashibi miso: numbing Sichuan
> pepper and chilli, and you pick how much of each. You can't get that version at home,
> which is more than I'd say for Ichiran. Go now rather than at seven — the queue at 4:45
> is about ten minutes; by seven it's forty.

**Empty state, no events**
> Nothing much on in Kanazawa tonight — it's a quiet town on a Tuesday. Here's what's
> worth doing anyway.

**After "Nah"**
> Noted. Less of that.

**Notification (designed, shipped in v2)**
> Rain from 2pm — your 3pm walk will be miserable. Tap to move it.

Cap at two per day, `urgency: "high"` only.

---

## 14. Build sequence

| Phase | Scope | Notes |
|---|---|---|
| **P0** | Schema migrations (§10), `starts_at` backfill, `opening_hours` capture in the places route | No UI change. Blocks everything |
| **P1** | `lib/now/` ranker + `GET /api/now`, generators `current_activity`, `leave_by`, `closing_soon`, `local_pick`, `gap_filler` | Testable without UI. Ship behind a query flag |
| **P2** | Home rebuild — hero, next row, chips, rail, "Nah", typographic fallback | Replaces `app/(shell)/page.tsx` |
| **P3** | Plan rebuild — timeline, gap blocks, inline disruption. Delete `90-minute-wins` | Absorbs two existing screens |
| **P4** | Card primitive + action row rolled across Home, Plan, Map sheet, Reels, chip grids. `saved_items` | Cohesion phase |
| **P5** | Chip result surface (`/discover/[intent]`) + Ask Roameo seeding + suggested questions | |
| **P6** | Onboarding cut to one screen; delete `connect-calendar`, `trip-detected`; move DNA and rules | |
| **P7** | Mention-crossref script → `mention_count`; image validation pass; offline slice | Content and resilience |
| **v2** | Push, voice I/O, Best of the City editorial layer, money features, full offline | |

P0–P2 is the smallest sequence that demonstrates the pivot. P3 is what makes it cohere.

---

## 15. Known risks

1. **Chip discoverability.** Chips are less obvious than a labelled tab. Mitigated by
   plain-language labels and by the rail surfacing event/experience tiles so the
   connection is visible. Watch this with real users first.
2. **Image coverage.** Section 11's validation pass may find that a large share of
   curated rows can't carry a hero. The typographic fallback covers it, but if the
   fallback fires more than ~30% of the time, Home isn't image-led in practice and the
   direction needs revisiting.
3. **Ranker credibility.** Two bad calls in a row and users learn to scroll past the
   hero. `card_signals` is the instrumentation; check dismissal rate per generator early
   and retire generators that lose.
4. **`time_label` backfill.** Free-text parsing will fail on some rows. Failing safe
   (unscheduled) is correct, but a trip with many unparseable items gets a weaker Plan.
5. **Coverage cliff.** Outside Kanto and Scotland, `local_pick` has no curated floor and
   falls back to live Google results, which are generic. Roameo should say so rather
   than pretend — the voice rule about admitting limits exists for this.
