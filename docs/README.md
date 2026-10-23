# Fomo plans and docs

The one place to find every plan for Fomo, what state it's in, and what's still open.
Run `/plans` in Claude Code for a summary of this page.

## Open to-dos

Things waiting on you, newest first. Tick them off here, or ask Claude to update this list.

**Families: "With kids" lens (20 Oct)** ([plan](plans/2026-10-20-families-lens.md), branch `families-lens`)
Kid-friendly tagging (`family_fit`), a `family` deal eligibility, "With kids" filters, an "I've got kids" pref, the /kids page and family sources. The app works before the SQL runs; tags only fill in after it.
- [x] Merged as [PR #45](https://github.com/jasbir98/fomo/pull/45) (20 Oct). Follow-ups (Home and /kids trims, parkrun grouping) in [PR #46](https://github.com/jasbir98/fomo/pull/46).
- [x] Run `supabase/add_family_fit.sql` in the Supabase SQL editor (done 20 Oct). The last result should show `true` twice for all 5 tables.
- [x] Backfill done 20 Oct: 8 events, 16 happenings and 50 places tagged. The `--ai` pass also ran (9 more happenings: 2 kids, 7 all ages, $0.007). Original step: `node --env-file=.env.local scripts/tag-family.mjs` (dry run). Read the table, then run it again with `--apply`. Add `--ai` outside DeepSeek peak hours to tag ~8 more happenings (about $0.02).
- [x] 50 family places staged 20 Oct (batch `family-places-2026-10-20`; the 6 weak rows left out, see `scripts/out/family-places-2026-10-20-reviewed.json`).
- [ ] Approve in the Supabase SQL editor: `update places_staging set approved = true, extraction_status = 'approved' where batch_id = 'family-places-2026-10-20' and extraction_status <> 'promoted';`
- [ ] Promote: `node --env-file=.env.local scripts/promote-places.mjs --country-code GB --source seed-family-places --destination-city Edinburgh --dry-run`, then again without `--dry-run`. Then `node --env-file=.env.local scripts/enrich-places-google.mjs` for hours and ratings.
- [ ] Tag the two family attractions the backfill missed (category "attraction"): `update places set family_fit = 'all_ages' where id in ('dc3e44de-67eb-43a0-91e3-8af42ccb46c7', 'da4a6b5d-5370-42f3-9449-5081bebf3f6f');` (Camera Obscura, Edinburgh Zoo).
- [ ] The three new deal sources (`scotrail-kids-for-a-quid`, `cineworld-family-films`, `picturehouse-kids-club`) start in shadow. Check their rows in Monday's weekly report, then set them to `live` in `scraper/deal_sources/registry.py`.
- [ ] Monday 26 Oct weekly run: review the family rows in the staging batch (7 new family topics). From 30 Nov the run adds Christmas-holiday "kids eat free" topics on its own.
- [ ] Search Console: request indexing of `/kids`.
- [ ] Share /kids in 3–5 Edinburgh parent Facebook groups and on Mumsnet's Edinburgh board. Send it to the person who gave the feedback and ask them to pass it to their school or nursery WhatsApp. One IG receipt post: "A £0 Saturday with the kids".
- [ ] 30 Nov: check PostHog against the bar. /kids ≥15% of non-internal sessions, ≥20 `kids_pref_set` opt-ins, kid-friendly outbound rate ≥ site average. Then decide on a family weekly email and seasonal pages.
- [ ] Each summer: extend `scraper/school_holidays.py` from the council's term-dates page (listed to Easter 2028).
- Not done: Jazz Bar's "Family and Kids shows" collection needs a separate page fetch (TODO in `scripts/sources/adapters/jazzbar.mjs`). Ticketmaster's family flag and Skiddle's `minage` weren't in our payloads, so they aren't used.

**Place photos (20 Oct)**
440 of 517 Edinburgh places had no photo, so Explore showed grey tiles. Places now fall back to a category photo (café → food, bookshop → shopping, park → outdoors), and 38 got their own website's share image (`scripts/place-og-images.mjs`, reviewed by a Haiku subagent, applied 20 Oct). Undo the 38 with `delete from place_photos where provider = 'og-image'`.
- [ ] Merge [PR #42](https://github.com/jasbir98/fomo/pull/42).
- [ ] About 400 places still use a category photo: their sites have no share image, block bots, or only have a logo. Wikimedia (`scraper/photos_wikimedia.py`) could cover the landmarks among them.

**Chat picks on the map, solid pins, pub quiz (19 Oct, Kylle's feedback)**
Ask Fomo's map showed "Fomo's picks · 1" for a reply with four cards: 239 of 353 live deals had no coordinates. 151 now have them (`scripts/geocode-happenings.mjs --apply`, run 19 Oct). Some dimmed pins looked solid: several deals at one venue stacked their transparency, and free deals came back twice. Pub quizzes now have their own chip on What's On.
- [ ] Merge [PR #41](https://github.com/jasbir98/fomo/pull/41).
- [ ] Add a `NEXT_PUBLIC_MAPBOX_TOKEN` repo secret on GitHub, so `promote-happenings.mjs` geocodes new deals as they're promoted. Without it they arrive with no map location again.
- [ ] 67 live deals still have no location: Mapbox couldn't match them with confidence (e.g. Blackfriars Arts Centre, The Court, McGonagall's, Height Club). Run `node --env-file=.env.local scripts/geocode-happenings.mjs` to list them; adding an address with a postcode to a row lets the script place it.

**Weekly email on time (15 Oct)**
GitHub Actions ran the Thursday email 4–7 hours late. A Vercel cron now starts it instead (Thu 15:00–15:59 UTC, so 4–5pm in summer, 3–4pm in winter). Details in [content-loop.md](content-loop.md).
- [ ] Make a fine-grained GitHub token: GitHub → Settings → Developer settings → Fine-grained tokens. Repository access: only `jasbir98/fomo`. Permissions: **Actions: Read and write**. Pick an expiry and note it.
- [ ] In Vercel → Settings → Environment Variables, *Production* only, add `GITHUB_DISPATCH_TOKEN` (the token) and `CRON_SECRET` (any random string of 16+ characters, e.g. from `openssl rand -hex 32`). Then redeploy so the cron and the variables take effect.
- [ ] Merge the weekly-email cron PR. Check Vercel → Settings → Cron Jobs lists `/api/cron/weekly-email`. "Run" there sends the real email, so only press it on a Thursday you want a send.
- [ ] Next Thursday (22 Oct), check Vercel's cron log and the Actions run both happened before 5pm.

**Stale dates on long-running events (15 Oct)**
- [x] Merge [PR #38](https://github.com/jasbir98/fomo/pull/38). Imported events listed as one long run (a weekly quiz "1 Sep – 30 Dec") showed their first date, e.g. "Tue 1 Sep", in Today. They now read "On now".
- [ ] Merge [PR #40](https://github.com/jasbir98/fomo/pull/40). Some of those runs are really one night a week: "Victoria Bar's Wednesday Quiz Night" sat in Today every day, Thursday included, and so did "Easy Sundays". A run whose title names one weekday now only shows on that weekday, reads its next date ("Wed 21 Oct") on other days, and merges with the matching curated card at the same venue.
- Known, not fixed: a weekly run whose title doesn't name its day (or names two) still shows in Today every day.

**Shareable weekend plan (15 Oct)**
- [x] Run `supabase/add_plans.sql` in the Supabase SQL editor (done 15 Oct).
- [ ] Merge [PR #34](https://github.com/jasbir98/fomo/pull/34).
- [ ] After it deploys, make a plan on askfomo.com/weekend and paste the link into a WhatsApp chat on your phone. The preview should be the receipt image. If WhatsApp shows no picture, tell Claude the link.
- [ ] After a week, check PostHog: `weekend_plan_created`, `weekend_plan_shared` (by `method`) and `plan_make_own_clicked`. The last one is the loop working: a friend who got a link making their own.

**Accurate visitor numbers in PostHog (14 Oct)**
- [x] In PostHog, turn on Project settings → Web analytics → **Cookieless server hash mode**. Do this *before* merging the `analytics-cookieless` PR.
- [x] Create a PostHog personal API key (scopes `insight:write`, `dashboard:write`, `query:read`, `annotation:write`, `project:write`) and add it to `.env.local` as `POSTHOG_PERSONAL_API_KEY`. Then ask Claude to run `scripts/posthog-dashboards.mjs --dump` and fix dashboard 980079.
- [x] Merge the `analytics-cookieless` PR, then run `scripts/posthog-dashboards.mjs --since <deploy date>`.
- [ ] A day after deploy, check cookieless visitors are spread over many daily IDs, not one. One giant "person" means `proxy.ts` is sending Vercel's IP instead of the visitor's.
- [ ] After 2–3 days, compare PostHog's "Daily visitors" with Vercel Analytics visitors. They should be close.

**What sits behind sign-in (13 Oct)**
- [ ] Merge [PR #27](https://github.com/jasbir98/fomo/pull/27). It edits `supabase/add_finds.sql` so only signed-in visitors can read the hand-picks. If you run that SQL before merging, re-run the policy part after.
- [ ] After it deploys, sign in and check For you shows every pick and the "You qualify" badges are back. Signed out, For you shows 2 picks and a sign-in card.

**For you tab: hand-picked steals and recommendations (12 Oct)**
- [ ] Run `supabase/add_finds.sql` in the Supabase SQL editor. Until you do, "Picked for you" stays empty, and the recommendations still work.
- [ ] Merge the `fomo-finds` PR.
- [ ] Every Friday:
  1. Run `npx tsx --env-file=.env.local scripts/finds.ts suggest`. It is off-peak only for DeepSeek; add `--no-ai` to skip it.
  2. Run `scripts/finds.ts approve 1,3,4`. You can change a line first with `edit <n> --why "…" --level 4`.
  3. Then run the IG carousel and Fomo Friday as usual. They now lead with the live picks.
- [ ] The first real `suggest` is the first live test of the candidate and DeepSeek steps, which were only tested against fixtures. Read its table before approving.

**Weekly research: credit and this week's batch (12 Oct)**
- [ ] Top up DeepSeek at platform.deepseek.com before next Monday's run. The balance ran out mid-run on 12 Oct.
- [ ] Merge [PR #21](https://github.com/jasbir98/fomo/pull/21). With it, a run that runs out of credit goes red instead of green, and a failed staging upload no longer loses deal pages.
- [ ] Review batch `edi-weekly-2026-10-12` in `happenings_staging`: 229 rows, 129 verified and 100 waiting for review, none approved. 198 of them were recovered by hand from the failed run's artifact, so there's no weekly report for those. Each row's `validation_errors` gives its review reasons.

**Search Console: noindex, redirects, organizer url (12 Oct)**
- [ ] Merge the `seo-indexing-fixes` PR. Then in Search Console, resubmit `sitemap.xml` and click "Validate fix" on "Excluded by 'noindex' tag" and on the Events "Missing field url (in organizer)" issue.
- "Excluded by 'noindex'" will never reach zero: an event that ends is noindexed on purpose. The bug was the sitemap still listing 107 of them.
- "Page with redirect" is expected for http://, www. and `/map`. Nothing to fix there.
- Organizer url is still missing for events and deals not linked to a venue (`place_id` empty). Linking more of them to places fixes those.

**Search Console: Event structured data (10 Oct)**
- [x] Merge the `seo-event-structured-data` PR, then click "Validate fix" in Search Console for organizer, image and description.
- [ ] Store performers: save Ticketmaster's attractions (and Skiddle's artists, if it has them) into a new `events.performers` column, then emit `performer`. 64 events are flagged.
- Left alone on purpose: `offers` without a known price, `endDate` the source doesn't give, and `validFrom` for events (no on-sale date stored).

**Event overrides and Fomo Finds (9 Oct)**
- [ ] Merge [PR #14](https://github.com/jasbir98/fomo/pull/14) before the 06:17 UTC import, or tonight's thrift, Oktoberfest and duplicate fixes are undone by it.
- [ ] Eventbrite has fetched nothing on its last two runs ("skipped, blocked or empty"). Decide whether to fix it or set it to shadow.
- [ ] `merge-events.ts` misses curated-vs-imported pairs whose titles differ ("TAGS Fest: Tabletop & Graphic Storytelling Festival" vs "TAGS Festival"). For now they're hidden in `scripts/sources/core/overrides.mjs`; a looser same-day, same-venue rule would catch them.

**More events and deals (8 Oct)**
- [ ] Run `supabase/add_event_lifecycle.sql`, then `supabase/add_deal_source_columns.sql`, in the Supabase SQL editor. Do this before merging. The code falls back safely until they have run.
- [ ] Merge the `event-coverage` PR.
- [ ] Register at api.edinburghfestivalcity.com as an app developer (licence type C, which needs their approval). Then add `FESTIVALS_API_KEY` and `FESTIVALS_API_SECRET` as GitHub secrets (the daily workflow reads them from the Production environment). Storytelling Festival runs 21 to 31 Oct; Hogmanay 29 Dec to 1 Jan. Then flip `edfestivals` to live after a spot-check.
- [ ] Check `DEEPSEEK_API_KEY` and `GOOGLE_PLACES_API_KEY` exist as repository or Production secrets. The daily workflow now reads them.
- [ ] Run the "Probe event and deal sources" workflow once from the Actions tab, and read its summary.
- [ ] Ask Young Scot for permission to list their discounts (their terms forbid scraping).
- [ ] Ask 5pm for a feed or partnership.
- [ ] Look at Awin and Partnerize affiliate feeds for Groupon and Wowcher (fits the money to-do).
- [ ] Review the first weekly report's deal-source rows, and approve with its SQL.

**Chat limits and earning money (8 Oct)**
- [ ] Merge the chat-limits PR: signed in 30 questions/day (was 150) and 3 Google Maps lookups/day (was 10); site-wide cap 5,000/day (was 1,500). A question costs about $0.0007 on DeepSeek; a Google lookup $0.035.
- [ ] Decide how Fomo earns money. Suggested order: venue partnerships (featured or Fomo-only deals), booking commissions (Viator, GetYourGuide, Skiddle, Ticketmaster via Awin), sponsored emails and posts, then Fomo+ (£2.99/month) once people come back weekly.

**SEO: "askfomo" search and the stale Google snippet (7 Oct)**
- [ ] Merge [PR #8](https://github.com/jasbir98/fomo/pull/8) (title and description, server-rendered pages, robots and sitemap).
- [ ] Vercel production: `NEXT_PUBLIC_SITE_URL=https://askfomo.com`. Both the sitemap and canonical URLs read it.
- [ ] Google Search Console: add askfomo.com as a Domain property (DNS TXT record), submit `https://askfomo.com/sitemap.xml`, then URL-inspect `/` and request indexing. Do the same for `/weekend`, `/deals` and `/free`.
- [ ] Make one of www / apex redirect to the other permanently. Today www sends a 307 (temporary) to the apex.
- [ ] Put askfomo.com in the Instagram bio. The profile URL is now `sameAs` in `app/layout.tsx`.

**Data enrichment (7 Oct)**
- [ ] Merge [PR #7](https://github.com/jasbir98/fomo/pull/7): Ask Fomo uses the new venue facts and deal prices; place and deal pages show them.
- [ ] Add a `GOOGLE_PLACES_API_KEY` repository secret so the monthly refresh runs. Google only allows its data to be stored for 30 days.
- [ ] Later: add the page-extraction step to the weekly DeepSeek pipeline.

**Mobile fixes (7 Oct)**
- [ ] Merge [PR #6](https://github.com/jasbir98/fomo/pull/6): Google place suggestions on the tip form's "Where?". Then send one test tip, picking a place from the list.
- [x] Merge [PR #5](https://github.com/jasbir98/fomo/pull/5): the personalise sheet's Budget row, the tip form's location field and optional link, and Ask Fomo's top pick card. Then send yourself one test tip with only a title, a "Where?" and an Instagram handle as the link.

**Ask Fomo timing fix (7 Oct)**
- [x] Merge [PR #4](https://github.com/jasbir98/fomo/pull/4). Then on askfomo.com ask "Something to do this weekend under £10?" and "Date night this Friday evening?". Neither should suggest a weekday-only or afternoon-only deal.

**After merging PR #3 (6 Oct)**
- [x] Merge [PR #3](https://github.com/jasbir98/fomo/pull/3), from `desktop` into `main`.
- [ ] Run `supabase/sync_profile_identity.sql` in the Supabase SQL editor. It copies Google names into profiles.
- [ ] Run `node --env-file=.env.local scripts/dedupe-happenings.mjs`. Check the list, then run it again with `--apply`.
- [ ] Run `node --env-file=.env.local scripts/link-happening-places.mjs`. Check the AMBIGUOUS lines, the partial matches and anything marked "via title", then run it again with `--apply`.

**Before the wider launch (planned Thu 15 Oct)**
- [ ] Supabase custom SMTP through Resend. The built-in sender only manages a few emails an hour.
- [ ] Check the Supabase auth email templates (see [auth-email-templates.md](auth-email-templates.md)) and that the Site URL is `https://askfomo.com`.
- [ ] Check the PostHog and Resend environment variables are set in Vercel *production*.
- [ ] Try the signed-in flows on production: Google photo, editing your name, and the name step for new email users.
- [x] Home hero and first 3 cards: photo-led, free or under £10, on today or this weekend. A timetable, poster or default image never leads while a photo exists.
- [x] Email offer: "This weekend in Edinburgh, under £10. In your inbox Thursday by 6pm." The send moved from Fri 07:07 to Thursday afternoon (now a Vercel cron, see above), and picks are capped under £10 to match.
- [ ] After merge: check the first Thursday send (15 Oct) went out, and dry-run it on the day.

**Security, last checked 29 Sep. Some of this may already be done.**
- [ ] SQL to run, in this order: `tighten_public_inserts.sql`, `harden_2026_09.sql`, then `verify_security.sql`.
- [ ] Dashboard checklist: Supabase auth URLs and CAPTCHA, Vercel preview protection, GitHub branch protection, and key restrictions. Details are in [plans/2026-09-28-security-review-and-cleanup.md](plans/2026-09-28-security-review-and-cleanup.md), §2c.
- [ ] Later: a nonce-based CSP to drop `'unsafe-inline'`.

## Strategy and marketing
| Doc | What it is |
|---|---|
| [launch/marketing-plan.md](launch/marketing-plan.md) | Positioning, success metrics, the Oct–Dec calendar, channels ranked, the launch sequence and the weekly rhythm. |
| [launch/launch-kit.md](launch/launch-kit.md) | Copy to paste: Instagram bio and the first 9 posts, launch DMs, the Reddit post, society and venue DMs, posters, the £50 boost rule, user-call questions. |
| [content-loop.md](content-loop.md) | The weekly Thursday weekend email and Instagram carousel, both generated from the database. |

## Data
| Doc | What it is |
|---|---|
| [plan-data-collection.md](plan-data-collection.md) | Plan for better Edinburgh data: dedupe, tiered sources, Instagram and Facebook. Decisions were made 15 Sep. |
| [daily-sources.md](daily-sources.md) | The daily events import (`scripts/daily-sources.mjs`). |
| [weekly-pipeline.md](weekly-pipeline.md) | The weekly happenings refresh (`scraper/weekly_edinburgh.py`). |

## Product and operations
| Doc | What it is |
|---|---|
| [analytics.md](analytics.md) | PostHog setup: events, dashboards and surveys. |
| [auth-email-templates.md](auth-email-templates.md) | Supabase sign-in email templates. |
| [push-notifications.md](push-notifications.md) | Setup checklist for web push ("Book early" on-sale alerts). Not switched on yet. |

## Past build plans
Snapshots of the plans approved in Claude Code plan mode. Each one is a record of what was decided, not a live to-do list.

| Plan | Status |
|---|---|
| [2026-10-20 Families: "With kids" lens and family supply](plans/2026-10-20-families-lens.md) | Merged in [PR #45](https://github.com/jasbir98/fomo/pull/45); follow-ups in [PR #46](https://github.com/jasbir98/fomo/pull/46). SQL and backfill done 20 Oct; places approval and promotion listed above. |
| [2026-10-14 Technical SEO](plans/2026-10-14-technical-seo.md) | Built and checked against a production build; in [PR #35](https://github.com/jasbir98/fomo/pull/35). Slug URLs proposed, not built. |
| [2026-10-14 Shareable weekend plan](plans/2026-10-14-weekend-plan.md) | Built and checked end to end; in [PR #34](https://github.com/jasbir98/fomo/pull/34). SQL run 15 Oct. |
| [2026-10-14 Accurate visitor numbers in PostHog](plans/2026-10-14-posthog-accurate-metrics.md) | Live 14 Oct (PR #31). Dashboard 980079 rebuilt by `scripts/posthog-dashboards.mjs`. |
| [2026-10-13 What sits behind sign-in](plans/2026-10-13-login-wall.md) | Built; in [PR #27](https://github.com/jasbir98/fomo/pull/27). Changes `add_finds.sql`, so run that after merging. |
| [2026-10-12 For you: hand-picked steals and recommendations](plans/2026-10-12-fomo-finds.md) | Built on branch `fomo-finds`; PR pending. SQL listed above. |
| [2026-10-08 More events and deals: sources, validation, soft-retire](plans/2026-10-08-event-and-deal-coverage.md) | Built on branch `event-coverage`; PR pending. SQL and keys listed above. |
| [2026-10-07 Fill in Edinburgh place and deal data](plans/2026-10-07-data-enrichment.md) | Data written 7 Oct (407 places, 111 deals); app changes in PR #7. |
| [2026-10-05 Pre-launch fixes and marketing](plans/2026-10-05-prelaunch-fixes.md) | Built; in PR #3. The SQL and dashboard steps are listed above. |
| [2026-09-29 Ten fixes on staging](plans/2026-09-29-staging-fixes.md) | Shipped. |
| [2026-09-28 Security review and cleanup](plans/2026-09-28-security-review-and-cleanup.md) | Code fixes shipped. The SQL and dashboard checklist are listed above. |
| [2026-09-15 UX audit (32 findings)](plans/2026-09-15-ux-audit.md) | All 5 phases shipped. |
| [2026-09-13 Edinburgh pivot (Miles → Fomo)](plans/2026-09-13-edinburgh-pivot.md) | Done. The trip layer was removed. |
