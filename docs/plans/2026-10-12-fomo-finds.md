# "For you": hand-picked steals plus recommendations

> **Changed during the build (12 Oct):**
> - The in-app name is **"For you"**, at `/for-you`, with the badge reading "Picked for you". Code, the table and `/api/finds` keep the internal name `finds`. The Instagram series is still "Fomo Finds".
> - The tab also **recommends**. `lib/personalise/for-you.ts` builds two lists:
>   - **Picked for you:** the live Finds, re-ranked by the visitor's taste. Taste can beat one Fomo level but never two. Offers the visitor can't use drop to the bottom.
>   - **More for you:** up to 10 cards from the next 7 days. Each card's score is the Home hero score plus a taste boost, and each comes with a reason ("You're into Comedy", "Student offer").
>   - Taste comes from the existing prefs (`usePrefs`, `useEffectiveWho`) and save history (`readAffinity`).
>   - With no taste signals, the second list is titled "Popular this week" and the page shows the "Make Fomo yours" prompt.
> - 13 Oct: the page is split into two groups, **Deals & offers** (`kind: "deal"`, as on the Deals tab) and **Events** (everything else). Each group has its own picks and up to 6 recommendations. The page shows one group at a time, chosen by a sticky "Deals & offers | Events" switch at the top. The choice is kept in the URL as `?tab=events`.
> - `lib/cards/price.ts` lost its `server-only` import. The file is pure, so the hero scorer can now run in the browser, scripts and tests.
>
> The sections below are the original plan. Where they say "Fomo Finds", `/finds` or "Fomo Find", read "For you", `/for-you` and "Picked for you".


## Context
Some deals and events are far better value than the rest (Cocktail Week £8 wristband, £4 cinema weekend, free jazz Wednesdays), but today they sit in the same lists as ordinary rows. The user already hand-picks these every Friday for the Instagram "Fomo Finds" series (each with a 1–5 "Fomo level"), but the app has no home for them, and the auto picks behind the IG carousel and Fomo Friday email (`scripts/lib/weekly-picks.mjs`) are weak.

Goal: a small, trusted list of steals in the app, with the same name and curation as Instagram, so one weekly pick feeds the app, IG and email.

**User decisions (12 Oct):**
- Finds **replaces Saved** in the bottom nav. Saved moves to the top bar and Profile.
- Curation: **a script suggests and the user approves**. Nothing goes live without approval.
- Each Find shows a **"why it's a steal" line**, a **Fomo level 1–5**, and a **"Fomo Find" badge** wherever the item appears elsewhere.

Why replacing Saved is fine: Saved only works for signed-in users, so most visitors see an empty sign-in card. Profile already links to `/saved` (`app/(shell)/profile/page.tsx:431`). Finds is useful to everyone and matches the Instagram brand.

## Design

### 1. Data: new `finds` table (`supabase/add_finds.sql`, run by the user)
One polymorphic table, because Finds can be events (`events`) or deals and happenings (`happenings`). It follows `saved_items`' `subject_type`/`subject_id` pattern.
- Columns: `id uuid pk`, `subject_type text check in ('event','happening')`, `subject_id uuid`, `why text not null`, `fomo_level smallint check 1–5`, `score numeric`, `status text check in ('suggested','live','retired') default 'suggested'`, `week_of date`, `created_at`, `approved_at`.
- Unique on (`subject_type`, `subject_id`) so an item can't be a Find twice.
- RLS: anon and authenticated can `select` only where `status='live'`. Writes are service-role only. Mirror the policy style in `tighten_public_inserts.sql`.
- Expiry happens when the row is read: a Find whose item has ended is hidden using `happeningHasEnded` / `eventHasEnded`. The script retires those rows on its next run. No cron needed.
- Code falls back safely (empty Finds) until the SQL has run, the same way the event-lifecycle columns did.

### 2. Weekly suggest-and-approve script: `scripts/finds.ts` (run with `npx tsx`)
It's a TypeScript file run through tsx so it can **import `lib/happenings/hero.ts` directly** (`happeningRecommendationScore`, `eventRecommendationScore`) rather than porting them again. The tests already run TS this way (`npx tsx --test`).
- `suggest`:
  - Candidates are live happenings with an occurrence in the next 10 days, evergreen genuine deals (`isGenuineDeal`, `lib/happenings/groups.ts`), and events in the next 10 days that are free or ≤£15.
  - Excludes family-only and over-60-only rows, using the same wedge rules as weekly-picks.
  - Scores each one and takes the top ~12.
  - Drafts a `why` line and a `fomo_level` for each with DeepSeek, through the existing `scripts/sources/core/deepseek.mjs` client (off-peak guard and spend cap built in). It falls back to the hero `reason` string if DeepSeek is off or in peak hours.
  - Upserts the results as `suggested` and prints a numbered table.
- `approve 1,3,4` sets those to `live`. `edit <n> --why "…" --level 4` changes one. `retire <n>` takes one down. `list` shows what's live.
- Each run first retires `live` rows whose item has ended.
- Writes go through plain `fetch` with the service-role key, as `weekly-picks.mjs` does (avoids the supabase-js realtime problem under Node).

### 3. API: `GET /api/finds` (public, cached)
- Reads live Finds, then turns each one into the shared `Candidate` card shape.
- **Reuse:** pull the subject→Candidate resolution out of `app/api/saved/route.ts` (≈L92-195) into `lib/cards/resolve.ts` and call it from both routes.
- Returns `{ items: (Candidate & { why, fomoLevel })[] }`. Ended items are dropped, not marked "Ended" as Saved does. Ordered by `fomo_level` desc, then soonest.
- Uses `cachedJson` with a public s-maxage (`lib/http/cache.ts`).
- Also returns a cheap `ids` list (`"type:id"`) for badges.

### 4. `/finds` page
- `app/(shell)/finds/page.tsx` is a server component (revalidate 120, like `/weekend`), plus `FindsClient.tsx`, `layout.tsx` (metadata, indexable) and an `opengraph-image.tsx` copied from `/weekend`'s.
- `AppHeader title="Fomo Finds"` with the subtitle "This week's steals, hand-picked. New every Friday."
- A new `components/finds/FindCard.tsx`:
  - The image leads, followed by the title, `PriceTag`, venue and date line.
  - Then the **why line** and a **`FomoLevel` meter**: 5 pips filled with the IG gradient `#FF8A3D→#FF3D7F→#8B5CF6`. Add these as tokens in `app/globals.css`.
  - `SaveButton` (signing in to save still works the same).
  - Tapping opens the existing detail page.
- Empty state: "New Finds every Friday" plus `SubscribeCard`.
- Add `/finds` to the sitemap. Track `find_opened` through the existing `track()`.

### 5. Nav and moving Saved
- `components/shell/nav-items.ts`:
  - Add `NAV_FINDS` (`/finds`, icon `local_fire_department`, using Saved's old colour slot).
  - `LEFT = [NAV_FEED, NAV_FINDS]`.
  - `PRIMARY = [NAV_FEED, NAV_FINDS, NAV_DEALS, NAV_EXPLORE]`.
- `components/shell/SideNav.tsx`: move Saved into the bottom group beside Tip and Profile.
- `components/shell/AppHeader.tsx`: add a bookmark icon button linking to `/saved`, shown only when signed in (`useSignedIn` is already imported there). It sits next to search on phones.
- Update the history comment in `BottomNav.tsx`.

### 6. "Fomo Find" badge everywhere
- Add `lib/finds/useFinds.ts`: a module-level store that fetches `/api/finds` ids once per session, read through `useSyncExternalStore`. It follows the `lib/useSaved.ts` pattern.
- Add `components/finds/FindBadge.tsx`: a small gradient pill, "Fomo Find".
- Render it in:
  - `FeedListCard`
  - `BookEarlyCard`
  - `VenueDealCard`
  - `HappeningDetail`
  - `EventDetail`
  - the deals page cards
- On the detail pages it also shows the why line.

### 7. Content loop
- `scripts/lib/weekly-picks.mjs`: when live Finds exist for the window, put them first in `picks`/`deals` for `ig-carousel.mjs` and `fomo-friday.mjs`. If there are none, use today's logic.
- Update `docs/content-loop.md` with the new weekly rhythm:
  1. `finds suggest`
  2. approve
  3. IG carousel
  4. email

### Not in scope (follow-ups)
- A Finds teaser on Home.
- Push alerts for new Finds.
- Sponsored or venue Finds (the money to-do).
- Storing an "original price" column.

## Build order (delegate to Sonnet subagents; main session reviews)
1. The SQL file, `lib/cards/resolve.ts` (refactor Saved to use it, with no behaviour change), and `/api/finds`.
2. `scripts/finds.ts` (suggest/approve/edit/retire/list), with a `--dry-run`.
3. The `/finds` page, `FindCard`, `FomoLevel`, tokens and OG image.
4. The nav swap, Saved in the header and SideNav, and the badge store plus `FindBadge` wiring.
5. The weekly-picks integration and docs: the `docs/README.md` to-do (run `add_finds.sql`), plus a plan copy to `docs/plans/2026-10-12-fomo-finds.md`.

Branch `fomo-finds` off `main`, then open a PR.

## Verification
- `npx tsc --noEmit`, lint, `npx tsx --test` (add unit tests for the resolve helper and the script's candidate filter and ordering).
- Before the SQL runs: `/finds` shows the empty state with no errors, and the API returns `[]`.
- After the user runs `add_finds.sql`:
  - `npx tsx scripts/finds.ts suggest --dry-run`, then a real `suggest`, then `approve` 3 items.
  - `/api/finds` returns those 3.
- In the preview, at mobile and desktop widths:
  - The bottom nav reads Feed · Finds · [Fomo] · Deals · Explore.
  - `/finds` renders the cards with the why line and meter.
  - The badge appears on the same items in Feed, Deals and the detail pages.
  - Signed in, the header bookmark opens `/saved` and Saved still lists and toggles.
  - Signed out, there's no bookmark in the header.
  - No console errors.
- `node scripts/ig-carousel.mjs` (dry) leads with the approved Finds.
