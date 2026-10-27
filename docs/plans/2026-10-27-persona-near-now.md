# Persona-fit ranking + "Near you now" on Home

## Context
The 26 Oct outside review made two points:
- **Mixed audiences in one feed.** A student scrolls past "Festival Theatre's Dementia Friendly Activities" and "Irish Language Classes".
- **No spatial urgency.** Nothing on Home says "this is on now, 400 m from you".

Much of the persona idea has already shipped:
- `Make Fomo yours` collects status, kids, interests and budget.
- The hero is ranked for `who`.
- PR #53 picks Home's "Top picks" through `lib/personalise/top-picks.ts`.
- PR #50 demotes long runs and chains.

What's still missing:
- **Signed-out visitors.** They're most visitors, and they get a neutral ranking (by design: `usePrefs` keeps prefs neutral unless signed in). On 26 Oct their #1 top pick was Dementia Friendly Activities.
- **Location.** No "near me" on Home. Explore has one, but for places only.

Live data supports a "near now" view:
- 43 of 53 Today cards have coordinates.
- 50 of 82 single deals have coordinates.
- Only 13 of 53 Today cards have a real start time, so the card shows "starts 19:00" when known and "on today" otherwise. No fake countdowns.

## Part A: niche-audience demotion (ranking only, nothing hidden)
New `lib/happenings/audience.ts` with `nicheAudience(title, description?)`. It returns a label or null, matched on titles plus a few narrow description phrases, and reads existing rows at display time, so no SQL is needed. Labels:
- `accessibility`: "dementia friendly", "relaxed performance", "for carers"
- `older`: "over 50s/60s", "seniors", "silver"
- `professional`: networking, conference, summit, AGM, CPD, webinar, "leaders meetup", "for founders"
- `course`: language class(es), first aid, "certificate", "accredited", "training course"
- `support`: support group, bereavement, recovery, "anonymous" meetings

`lib/happenings/hero.ts`, in both `happeningRecommendationScore` and `eventRecommendationScore`:
- Add `NICHE_AUDIENCE_PENALTY = 20` under the existing "Audience" section.
- Skip the penalty for `older` when the visitor's `who` includes `over_60`.
- Events get the `who` param the same way happenings already do.

Everything that ranks through these scores picks this up without changes: the hero, `leadWithPhotos`, Top picks (via `baseScore`), For you and Today's deals. The full What's on list stays chronological, so these items are still one tap away under "See all".

Tests: `lib/happenings/audience.test.ts`, covering positives from live titles and negatives like "Quiz Night", "Comedy Club", "Silent Disco" and "Ceilidh". Plus a hero test: a Dementia Friendly row scores below an equal plain row.

## Part B: "Near you now" on Home
- New pure helper `lib/happenings/near-now.ts`, `nearNow(feed, coords, now, tz)`. It collects Today's What's on cards and today's deals (venue-group offers and singles) that have coordinates and are within `NEAR_RADIUS_KM = 1.5`. It returns them sorted by distance, at most 8.
  - Each item carries `distanceKm`, a walk time and a time label: "starts 19:00", "on until 22:00" or "on today", using the card's own times only.
  - Reuses `distanceKm`, `formatDistanceLabel` and `walkMinutes` from `lib/geo.ts`, plus the `localDayDate` and occurrence helpers.
  - Returns `{ outsideCity: true }` when the visitor is more than 15 km from `EDINBURGH_CENTER`.
- New component `components/happenings/NearNowSection.tsx`, using `useGeolocation()` and `refreshGeolocation()`, which ask only on tap. States:
  - `prompt` or `loading`: one compact button card, "What's on near me?". Tapping asks for location.
  - `granted`: the section "Near you now": `FeedListCard`s with a reason line like "450 m · 6 min walk · starts 19:00". If nothing is within range: "Nothing within a 20-minute walk right now". If outside Edinburgh: "Near me works in Edinburgh".
  - `denied` or `unsupported`: render nothing.
  - Because the browser remembers the permission, returning visitors who granted it see the section straight away, with no button.
- `app/(shell)/HomeClient.tsx`: render `NearNowSection` directly under Top picks, only on the Today window (`feedWindow === "now"`). It uses the feed already loaded, so no new fetch.
- Analytics through `lib/analytics/track.ts`: `near_me_tapped`, `near_me_result` (count, status) and card clicks with `surface="home_near_now"`. Coordinates are never sent.
- Tests: `lib/happenings/near-now.test.ts` covers distance sort, the radius cut, deals included, no-coordinates rows skipped, outside the city, and the time labels.

## Not doing
- **A persona gate on landing.** It costs bounce on Instagram and TikTok traffic.
- **Guessing persona from the entry page for signed-out visitors.** It goes against the "personal needs an account" rule from PR #27, and only `/kids` is a clear signal. Revisit if signed-out bounce stays high.
- **Hiding items by persona.** Ranking down is the whole change.

## Order and branches
- Separate PRs off `main`: A on `niche-audience`, B on `near-now`. They don't share files (A: `hero.ts`, `audience.ts`; B: `near-now.ts`, `NearNowSection.tsx`, `HomeClient.tsx`).
- After approval, save this plan to `docs/plans/2026-10-27-persona-near-now.md` and add an index row plus to-dos in `docs/README.md`.

## Verification
- `npx tsx --test lib/happenings/*.test.ts lib/personalise/*.test.ts` and `npx tsc --noEmit` pass.
- A: run Top picks (signed out) over the live feed. Dementia Friendly, Irish Language Classes and First Aid at Work drop out of the top 5, and the "See all" list still contains them.
- B: local dev server against prod data with the Browser pane:
  - mobile viewport; emulate a position on the Cowgate (55.9485, -3.1880) and check "Near you now" lists nearby cards in distance order with sensible labels;
  - emulate Glasgow to get the outside-Edinburgh message;
  - deny permission, and the section disappears;
  - check the console and server logs are clean;
  - take a screenshot for the PR.
