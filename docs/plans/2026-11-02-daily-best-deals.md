# Get the best Edinburgh deals every day

## Context

You think we're not finding enough good deals, and the data backs you up. But more sources alone won't fix it: new deals are getting stuck after we find them, and our "is it a deal?" check rejects many of the best ones.

**Measured on 2 Nov:**

| Finding | Evidence |
|---|---|
| **Nothing has gone live for 3 weeks** | The last new row in `happenings` is dated 12 Oct. Weekly runs on 19 and 26 Oct found deals, but they need manual SQL approval. 502 rows are waiting, including 161 different deals we don't have live. |
| **The quality check rewards the wrong things** | `is_genuine_deal` (`scraper/deal_sources/gate.py:160`) looks for discount wording, not value. On 26 Oct it rejected "£4 cask pints" (Nobles) and "£5 IPA with any burger" (Lioness of Leith), and kept "20% off film studio hire" and "free spinal screening". |
| **We hardly cover everyday cheap food and drink** | Of 169 live deals, one mentions happy hour, one brunch and 10 lunch. Top sources are Resident Rewards (39) and itison (32). |
| **We never read venues' own sites** | 327 Edinburgh places have a website on file (79 pubs, 40 bars, 31 cafés, 19 restaurants). Only a few venue pages are read for deals. |
| **Collection is weekly** | Deals are only read on Mondays, and that run spent $0.72 of its $3 cap. Money isn't the limit. |
| **Instagram, Facebook and newsletters: nothing** | The old scrapers were deleted on 28 Sep. The Meta and newsletter setup from the 15 Sep plan never happened. |
| **Some jobs fail quietly** | The weekly tidy has been failing (`node: .env.local: not found`, `weekly_edinburgh.py:910`). Fort Kinnaird failed 3 of 3 pages on 26 Oct. All 19 direct publisher pages gave 0 records. |

**Your decisions:** strong deals auto-publish, unsure ones go to a one-tap digest, weak ones are dropped. Instagram and Facebook through official routes plus newsletters only. AI budget up to $15 a month.

**Facebook-only deals will stay a gap.** Meta's rules need App Review to read Pages we don't manage, so we only catch what venues also post on Instagram, in newsletters or on their sites.

**This overrides the 14 Oct source freeze**, at your request. That review's point still stands: more deals won't bring users on their own. So this plan sets a budget and a stop-check instead of being open-ended.

## Phase 1: Fix what's broken and judge deals by value

**Quick fixes**
- Make the weekly tidy work in CI by not requiring `.env.local`.
- Find out why Fort Kinnaird, ScotRail and Cineworld fail, then fix them or mark them as blocked.
- Save every rejected deal with its reason (`runner.py:213` only keeps counts and 12 examples), so we can see what we're throwing away.
- Check itison's 28 rejections for a missing quote, date or weekday, and loosen any check that's rejecting real deals.

**New quality score, `scraper/deal_sources/quality.py`, 0 to 100**
- **Cheap prices count as deals.** A new `price_benchmarks.yaml` holds Edinburgh "good price" lines per item: pint, cocktail, lunch or main, coffee, cinema ticket. Draft values get tuned in the backtest. A fixed price below its line counts as a deal.
- **Update the app's check too.** `isGenuineDeal` in `lib/happenings/groups.ts:204` needs the same change, otherwise the Deals tab hides these rows (`build-feed.ts:600`).
- **What raises the score:** depth of saving (the same logic as `dealDepth`), limited days, local rather than chain, useful to students and young professionals, and evidence that's clear and recent.
- **AI relevance rating:** one off-peak DeepSeek call per batch rates "would a student or young professional in Edinburgh care?" It can only lower a score, never overrule a failed check. This is what catches film studio hire.

**What happens to each deal**

| Result | Rule | Action |
|---|---|---|
| Publish | Score 70+, source page confirms every fact, no duplicate or dormant match, not from social or newsletters | Live automatically, at most 10 a day. Extras go to the digest. |
| Digest | Score 40–69, or flagged, or from social or newsletters | One-tap review |
| Drop | Below 40 | Saved with its reason, never shown |

- itison loses its "always review" rule and goes through the same scoring, but only after the backtest shows its rows are good enough.
- The other kinds (events, activities, free access) use the same route, with free and under-£10 scoring higher.

**Backtest before anything publishes.** Score the 161 waiting deals, the 169 live ones and the saved rejections, then show you the results table to set the thresholds. Then run for 3 days logging what it *would* publish before switching it on.

New columns `quality_score` and `quality_reasons` on `happenings_staging` and `happenings`, added by SQL you run by hand, as usual.

## Phase 2: Run daily and make review one tap

- **New `.github/workflows/daily-deals.yml`, off-peak:** runs all deal sources every day. Unchanged pages cost nothing thanks to the `source_pages` ledger. Research topics rotate so each runs weekly, and deal topics run more often. It replaces the Monday run, then scores and publishes.
- **Hard limits:** $0.45 per run (about $14 a month), enforced with the existing `--cap-usd`. The off-peak guard in `scraper/deepseek_hours.py` stays.
- **Daily digest email through Resend, `scripts/deal-digest.ts`:** up to 10 deals, best first, each with its quote, source link and score.
- **Review page, `app/review/[token]`:** approve or reject in one tap. Links are signed, admin-only and expire after 7 days. The email opens a confirm page and the action is a POST, because email scanners open links automatically. Read the Next.js guide in `node_modules/next/dist/docs/` first.
- **No more pile-ups:** unreviewed items expire after 14 days. The current backlog gets scored once, so the best reach the digest and the rest are dropped with reasons.
- **Drought alarm:** the daily deal review fails loudly if no new deal has gone live in 7 days. This would have caught the last 3 weeks.
- **Six Tattoo Hospitality packages:** retired by the new score, closing that open to-do.

## Phase 3: Read many more of the web's deals

**Venue sweep, `scraper/deal_sources/venue_sweep.py`**
- Starts from the places with websites, keeping useful categories: pubs, bars, cafés, restaurants, music venues, theatres, bakeries, chippies, museums and galleries. This leaves out things like the 23 luggage-storage rows.
- On each site, reads the homepage and up to 3 pages whose links match offers, deals, specials, happy hour, student, lunch or what's on.
- Covers about a seventh of sites a day, using the existing fetcher, robots rules, ledger and evidence gate. We identify as our bot and never get past a block; sites that block us or render only in JavaScript are logged and skipped.
- The place's address proves it's in Edinburgh, and each deal links to its place automatically.
- Starts in shadow mode for one reviewed run, which gives us the real cost and yield before it goes live.
- Also picks up cheap regular nights such as quizzes, comedy and open mics.

**More deal sources, added to `scraper/deal_sources/registry.py`, starting in shadow**
- Shopping centres, same as Fort Kinnaird and OMNi: St James Quarter, Ocean Terminal, The Gyle, Cameron Toll.
- Pub and bar group pages with Edinburgh offers: Belhaven student pubs, Slug & Lettuce Edinburgh, Las Iguanas students.
- Move the four existing shadow sources to live once their report reads well.

**Round-ups as leads only.** Articles from sites like Unifresher, What's On Edinburgh and Prestige Student Living can name deals we've missed, but many are old (one Skinny piece is from 2017). A lead only publishes if the venue's own page confirms it, otherwise it goes to the digest marked unconfirmed.

## Phase 4: Newsletters, then Instagram

**Newsletters first: free, allowed, and no approval to wait for**
- `scraper/newsletters.py` reads the new inbox daily over IMAP and tracks each message ID, so nothing is processed twice.
- It extracts deals with the same quote checks, and if the email links to a page that confirms the deal, marks it "pre-checked".
- Everything goes to the digest, labelled "via <newsletter>".

**Instagram**
- `scraper/sources/social_handles.yaml` lists about 150 Edinburgh business accounts, linked to places where we have them.
- One-hour test of Business Discovery first, because vendor guides disagree on whether it needs App Review and I haven't checked this against Meta's own docs.
- If it works, read captions daily, run local Tesseract OCR on images, and send everything to the digest with the permalink as source.
- If it needs review, submit the app and don't build the reader until it's approved. Newsletters and the web carry on regardless.

## Phase 5: Know if it's working

- **New `deal_source_runs` table, modelled on `event_source_runs`:** for each source, how many fetched, new, published, in digest, dropped, later retired, plus cost.
- **Golden set, `scraper/deal_sources/golden_set.yaml`:** about 30 real current deals found by hand, including the Revolution and Las Iguanas happy hours. Reported weekly as the share we caught.
- **Stop-check 30 days after launch.** Keep investing only if it's bringing in **at least 10 new good deals a week** and **at least 70% of the golden set**. Sources with no published deal in 4 weeks get dropped.
- **Check users too.** Outbound clicks on deals in PostHog show whether better supply changes behaviour. If not, the next effort goes back to distribution.

## What you need to do

Claude can't do these:

1. **Run the SQL** for the new columns and the runs table (Phases 1 and 5).
2. **Add the secrets:** `REVIEW_SIGNING_SECRET`, and `NEXT_PUBLIC_MAPBOX_TOKEN` so new deals get map pins (already a to-do).
3. **Workflow permission:** run `gh auth refresh -h github.com -s workflow`, or push the workflow branch yourself. Claude's token can't push workflow files.
4. **Top up DeepSeek** if the balance is low. It ran out on 12 Oct.
5. **Create the newsletter inbox** and subscribe it (`docs/plan-data-collection.md` §9b). About 30 minutes. Claude can't create accounts for you.
6. **Set up the Meta app** (§9a), for the Instagram test.
7. **Register for the Festivals API** (§9c). This is the biggest quick win for events, with Hogmanay on 29 Dec, and it's already built.

## Critical files

- **Change:** `scraper/deal_sources/gate.py`, `runner.py`, `registry.py`, `scraper/weekly_edinburgh.py`, `lib/happenings/groups.ts`, `lib/happenings/deal-review.ts`
- **New:** `scraper/deal_sources/quality.py`, `price_benchmarks.yaml`, `venue_sweep.py`, `golden_set.yaml`, `scraper/newsletters.py`, `scraper/sources/social_handles.yaml`, `.github/workflows/daily-deals.yml`, `scripts/deal-digest.ts`, `app/review/[token]`
- **Reuse:** `process_page` and the ledger in `runner.py`, `gate_deal`, `identity.py` matching, `verify_record`, `scripts/promote-happenings.mjs`, `scraper/deepseek_hours.py`, `event_source_runs` as the model for the new table

Update `docs/weekly-pipeline.md` and the to-do list in `docs/README.md`. Save this plan to `docs/plans/2026-11-02-daily-best-deals.md`.

## Verification

- **Unit tests in `scraper/test_deal_sources.py`:** £4 pint passes; film studio hire scores low; a failed quote check can't be rescued by a high score; social rows can never auto-publish; the daily publish limit holds.
- **App check:** a cheap-price deal shows on the Deals tab in the preview.
- **Backtest table:** you read it and agree the thresholds before auto-publish goes on.
- **Shadow runs:** 3 days of "would publish" output, and one venue-sweep report with actual cost per site.
- **Digest end to end:** on staging, approve and reject from a real email. Check that an expired or edited token is refused, that opening the link alone changes nothing, and that an approved deal goes live with its pin.
- **First live week:** daily run stays under $0.45 and off-peak, new deals appear on Home with "New", the drought alarm fires in a test, and the first golden-set score is reported.

## Sources

- [Meta: Page Public Content Access](https://developers.facebook.com/documentation/development/features-reference/page-public-content-access)
- [Zernio: Instagram Graph API guide](https://zernio.com/blog/instagram-graph-api) (vendor guide, unconfirmed)
- [Unifresher: best happy hours in Edinburgh](https://unifresher.co.uk/10-of-the-best-happy-hours-in-edinburgh/)
- [Prestige Student Living: Edinburgh student discounts](https://prestigestudentliving.com/blog/the-top-10-edinburgh-restaurants-which-offer-student-discount)
- [Belhaven student pubs](https://www.belhaven.co.uk/pubs-near-me/student-pubs)
- [Slug & Lettuce Edinburgh](https://slugandlettuce.co.uk/edinburgh/food-and-drink)
- [Las Iguanas students](https://iguanas.co.uk/students)
