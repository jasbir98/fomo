# Fomo plans and docs

The one place to find every plan for Fomo, what state it's in, and what's still open.
Run `/plans` in Claude Code for a summary of this page.

## Open to-dos

Things waiting on you, newest first. Tick them off here, or ask Claude to update this list.

**Chat limits and earning money (8 Oct)**
- [ ] Merge the chat-limits PR: signed in 30 questions/day (was 150) and 3 Google Maps lookups/day (was 10); site-wide cap 5,000/day (was 1,500). A question costs about $0.0007 on DeepSeek; a Google lookup $0.035.
- [ ] Decide how Fomo earns money. Suggested order: venue partnerships (featured or Fomo-only deals), booking commissions (Viator, GetYourGuide, Skiddle, Ticketmaster via Awin), sponsored emails and posts, then Fomo+ (£2.99/month) once people come back weekly.

**SEO: "askfomo" search and the stale Google snippet (7 Oct)**
- [ ] Merge [PR #8](https://github.com/jasbir98/fomo/pull/8) (title and description, server-rendered pages, robots and sitemap).
- [ ] Vercel production: `NEXT_PUBLIC_SITE_URL=https://askfomo.com`. Both the sitemap and canonical URLs read it.
- [ ] Google Search Console: add askfomo.com as a Domain property (DNS TXT record), submit `https://askfomo.com/sitemap.xml`, then URL-inspect `/` and request indexing. Do the same for `/weekend`, `/deals` and `/free`.
- [ ] Make one of www / apex redirect to the other permanently. Today www sends a 307 (temporary) to the apex.
- [ ] Put askfomo.com in the Instagram bio, then add the profile URL as `sameAs` in `app/layout.tsx`.

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

**Security, last checked 29 Sep. Some of this may already be done.**
- [ ] SQL to run, in this order: `tighten_public_inserts.sql`, `harden_2026_09.sql`, then `verify_security.sql`.
- [ ] Dashboard checklist: Supabase auth URLs and CAPTCHA, Vercel preview protection, GitHub branch protection, and key restrictions. Details are in [plans/2026-09-28-security-review-and-cleanup.md](plans/2026-09-28-security-review-and-cleanup.md), §2c.
- [ ] Later: a nonce-based CSP to drop `'unsafe-inline'`.

## Strategy and marketing
| Doc | What it is |
|---|---|
| [launch/marketing-plan.md](launch/marketing-plan.md) | Positioning, success metrics, the Oct–Dec calendar, channels ranked, the launch sequence and the weekly rhythm. |
| [launch/launch-kit.md](launch/launch-kit.md) | Copy to paste: Instagram bio and the first 9 posts, launch DMs, the Reddit post, society and venue DMs, posters, the £50 boost rule, user-call questions. |
| [content-loop.md](content-loop.md) | The weekly Fomo Friday email and Instagram carousel, both generated from the database. |

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
| [2026-10-07 Fill in Edinburgh place and deal data](plans/2026-10-07-data-enrichment.md) | Data written 7 Oct (407 places, 111 deals); app changes in PR #7. |
| [2026-10-05 Pre-launch fixes and marketing](plans/2026-10-05-prelaunch-fixes.md) | Built; in PR #3. The SQL and dashboard steps are listed above. |
| [2026-09-29 Ten fixes on staging](plans/2026-09-29-staging-fixes.md) | Shipped. |
| [2026-09-28 Security review and cleanup](plans/2026-09-28-security-review-and-cleanup.md) | Code fixes shipped. The SQL and dashboard checklist are listed above. |
| [2026-09-15 UX audit (32 findings)](plans/2026-09-15-ux-audit.md) | All 5 phases shipped. |
| [2026-09-13 Edinburgh pivot (Miles → Fomo)](plans/2026-09-13-edinburgh-pivot.md) | Done. The trip layer was removed. |
