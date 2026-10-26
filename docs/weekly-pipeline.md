# Weekly Edinburgh happenings pipeline

`scraper/weekly_edinburgh.py` is the safe weekly refresh for the Edinburgh happenings catalogue. It reads publisher pages first, runs narrow research topics independently, and reloads every candidate from its cited page before it can be staged. Nothing is deleted.

## What a run does

1. Runs the lifecycle sweep, moving expired one-off live entries to `dormant`. It never deletes a row or auto-retires a source merely because a request failed.
2. Reads the configured official/publisher pages directly. It obeys `robots.txt`, and logs then drops pages which block, challenge, or rate-limit the script. JSON-LD events are imported without AI; a page with no structured event data is simply recorded as read.
3. Runs the page-grounded **deal sources** (see below), inside their own sub-cap, after the direct sources and before the search topics.
4. Runs 53 small DeepSeek research topics (plus up to 2 dated school-holiday topics, see below) in priority order: ticket releases, resident rewards, student and young-professional deals, concessions, offers, low-cost cinema, comedy, ceilidhs, free museum days, family and kids topics (museum and gallery family activities, school-holiday activities, Bookbug and library sessions, kids eat free, children's theatre, family days out and kids-go-free, kids' cinema clubs), parkruns, markets, free tours, museum lates, festivals, sports fixtures, and seasonal/council events. Each has its own source seeds. Up to four run concurrently.
5. Merges duplicate title/date candidates and creates conservative city-level collections for truly identical activity families: for example, Cramond, Holyrood, and Portobello become one **Edinburgh parkruns** card (family fit `all_ages`), and individual library Bookbug sessions become one **Bookbug at Edinburgh libraries** card (free, weekly, ages 0 to 4, category `family`, family fit `kids`), while retaining and checking every individual source page. It does not collapse unrelated items merely because they share a category. Before verification, two silent (non-review) drops happen: a candidate whose every stated date has already passed (e.g. this year's already-finished Fringe dates mislabelled "annual"), and a candidate that names no concrete date, price/promo code, or venue — generic programme narration rather than a real thing to do or offer.
6. The run then links high-confidence venues to existing places and reloads every remaining candidate's source page (falling back to its other `source_urls`/`booking_url` if the first is blocked or challenged). A price, promo code, date, stated recurrence weekday, and booking release date/time must still be visibly stated on that page — verbatim for promo codes/saving figures, verbatim OR any common textual format (UK numeric, ordinal-day, weekday-abbreviated, etc.) for dates. The title/venue name is only a soft relevance signal — an LLM-paraphrased title is expected to never match verbatim — used solely to catch a page that turns out to be about something else. Anything that fails a hard check remains a review item rather than a live entry.
7. Writes a Markdown and JSON report plus the verified JSON output under `scraper/out/<batch-id>/`.

When `--publish` is explicitly used, only the just-verified rows are marked approved and promoted; publisher preview images are then attached. The normal first run below never publishes.

## Live rechecks (how "Checked Nd ago" stays short)

`scraper/recheck_live.py` runs daily as the first step of the daily deal review (`.github/workflows/daily-deal-review.yml`, 12:37 UTC; see below). It reloads the source page of every live row not confirmed in the last 7 days and runs the same `verify_record` check as step 6. A pass sets `verified_at` to now; a 404/410 retires the row; anything else (a block, a timeout, a saving label or date no longer on the page) leaves the row alone and lists it in the run summary for a person to check. No AI calls, so no off-peak constraint. `--dry-run` reports without writing.

The weekly run keeps its own 21-day recheck as a backstop and applies it on every `--stage` run. (Until 23 Oct 2026 it only wrote results under `--publish`, which the schedule never passes, so live rows aged past 40 days.)

The app shows "Checked today / yesterday / Nd ago" for 13 days. From 14 days (`STALE_AFTER_DAYS` in `lib/happenings/format.ts`) cards drop the line, the hero names the source instead, the detail page shows "Last checked 3 Oct" with a "check with the source before you go" note, and hero/For you ranking de-prioritizes the row.

## Daily deal review

`.github/workflows/daily-deal-review.yml` runs at 12:37 UTC, after the 11:17 events import. It re-verifies live rows (`recheck_live.py`, above), then `scripts/review-deals.ts` goes through every live deal and removes the ones that are finished or have gone unconfirmed. It makes no AI calls. To run it by hand: `npx tsx --env-file=.env.local scripts/review-deals.ts --dry-run`, and to run the whole job from GitHub, use "Run workflow" (with the `dry_run` box ticked if you only want the report).

What it does to each live deal:

- **Retired** (gone for good): the deal has ended. Its end date has passed, its weekly or yearly rule has run past its `until` date, its list of dates has run out, or its season (`season_valid_until`) is over. A yearly deal whose season is over goes dormant instead, because it returns next year. A deal with no dates at all is not treated as ended.
- **Dormant** (hidden, can be switched back on), in two cases:
  - `verified_at` is missing or more than 30 days old. The recheck keeps any deal whose source page still states it fresh, so a deal this old has failed re-verification for weeks.
  - **Outside Edinburgh.** The first of three signals that answers decides: (1) the postcode in `address`, where EH1 to EH17, EH28 to EH30, EH91, EH95 and EH99 are inside and any other postcode (other EH districts such as EH21 Musselburgh, or G, FK, KY, ML and so on) is outside; (2) a town name in `venue_name` or `title`, as a whole word, from a list such as Musselburgh, Dalkeith, Livingston, Glasgow and Stirling (Leith, Portobello, Cramond and South Queensferry are inside the city, so they are not on the list); (3) the pin, if it falls outside a rough box around Edinburgh. A deal with none of the three (no address, no town name, no coordinates) is kept: no data is a gap, not a wrong place. The reason shown is, for example, `outside Edinburgh: EH21 postcode`.
- The checks run in this order for each deal: ended, then stale, then outside Edinburgh. The first that applies sets its outcome.
- **Flagged, nothing changed**: not a genuine discount (same test as the Deals tab), or a likely duplicate (same venue and the same saving badge or a near-identical title). A national chain offering 10% off or less (`isNationalChain` and `dealDepth` in `lib/happenings/deal-score.ts`) is flagged too.
- **New today**: deals created in the last 24 hours, with their flags, so a person can look over what was just added.

Rules that don't bend: no row is ever deleted; only rows that are still `live` are touched, and the update re-checks that when it writes; and if one run would retire or make dormant more than 15 deals, it writes nothing, prints the list and fails the job. That many in one day is more likely a bug, or a recheck outage that left every `verified_at` old, than real expiries. If you see that failure, read the list in the run summary, fix the cause, then re-run (or change the rows by hand). The run summary has a table per section with the title, venue, reason, id and source link; `--dry-run` prints the same report and never fails, even over the cap.

## Deal sources (`scraper/deal_sources/`)

Deals are read straight from the pages that state them, instead of from search results. Each source in `scraper/deal_sources/registry.py` is a `DealSource` with an `id`, a `trust` (`official` or `commercial`), a `status` (`shadow` or `live`), a `discover` rule (a WordPress REST query, a sitemap filter, a fixed URL list, or a listing page's links) and, where needed, extraction hints and the per-source keys listed below.

| id | Name | Trust | Status | Discover | Notes |
|---|---|---|---|---|---|
| `forever-edinburgh-offers` | Forever Edinburgh offers | official | live | WordPress REST: the child pages of parent 5095, modified in the last 120 days | Usually one offer per page. Many pages are long expired. Edinburgh-only source. |
| `more-by-the-shore` | More By The Shore specials (Leith and Newhaven) | official | live | WordPress REST page `more-by-the-shore-specials` | One page of about 35 offers, split into cards. Each offer must state its own EH postcode. |
| `resident-rewards` | Forever Edinburgh Resident Rewards | official | live | WordPress REST: page 7239 and its child pages | Offers for Edinburgh residents. Eligibility defaults to `local_resident`. Edinburgh-only source. |
| `edinburgh-leisure-offers` | Edinburgh Leisure offers | official | live | `page-sitemap.xml` and `post-sitemap.xml`, URLs matching offer, free, try or joining-fee, modified in the last 90 days; plus the children's pages (`/clambers-soft-play/`, `/tumbles-soft-play/`, `/scrambles-soft-play/`, `/holiday-activities/`, `/holiday-camps/`, `/family-days-out-in-edinburgh/`, the Tiny Tasters under-5s week page), always read via `always_pattern` | Free or reduced sessions and joining offers, 5 to 10 a year, and offers for children (eligibility `family`, family fit `kids`). Edinburgh-only source. |
| `itison-edinburgh` | itison Edinburgh deals | commercial | live | Links from `itison.com/edinburgh` to `/Edinburgh/deals/<slug>`, up to 45 | Deals in other towns (no EH postcode) are dropped. Only offers with a stated saving count. No booking link. |
| `fort-kinnaird-offers` | Fort Kinnaird offers | commercial | live | `/offers` with `type=student`, `type=dining` and `type=kids-dining-offers` | Page evidence: "Newcraighall Edinburgh EH15 3RD". Kids Eat Free and kids' menu deals are eligibility `family`. |
| `omni-centre-offers` | OMNi Edinburgh student offers | commercial | live | `omniedinburgh.co.uk/offers/student-discounts-and-more` | Page evidence: "Greenside Row, Edinburgh EH1 3AA". Student offers. |
| `pizzaexpress-offers` | PizzaExpress national offers | commercial | **shadow** | `pizzaexpress.com/offers` | National offers, scope `national`, venue "PizzaExpress (Edinburgh restaurants)". Promote to live after one reviewed report. |
| `scotrail-kids-for-a-quid` | ScotRail Kids for a Quid | official | **shadow** | `scotrail.co.uk/kids-for-a-quid` | Up to four children aged 5 to 15 travel for £1 return each with a paying adult: eligibility `family`, family fit `kids`. "Kids Visit Free" is a second deal only if the page names attractions or terms. National, venue "Edinburgh Waverley station". |
| `cineworld-family-films` | Cineworld family films | commercial | **shadow** | `cineworld.co.uk/movies-for-juniors` | £2 family films, with adults accompanied by children: eligibility `family`, family fit `kids`. The £5.99 line counts only if a saving is stated. National, venue "Cineworld Edinburgh (Fountain Park)". |
| `picturehouse-kids-club` | Picturehouse Kids' Club | commercial | **shadow** | `picturehouses.com/kids-club` | All tickets £3, for children and their parents or carers: eligibility `family`, family fit `kids`. Runs at selected Picturehouses; Cameo is the Edinburgh one. National, venue "Cameo Picturehouse". |

Not deal sources: Odeon (bot-blocked, a 302 loop), Vue (JavaScript-rendered), and Asda and Morrisons (JavaScript-rendered, no offer text in the HTML). They are covered by the "Kids' cinema clubs in Edinburgh" and "Kids eat free in Edinburgh" research topics instead.

Trust rules: a live **official** source's deal that passes every check is treated as verified (eligible for `--publish`). A live **commercial** source's deal always goes to review (`commercial_source_review`), whatever it passes.

Per page: fetch politely (the bot's real identity, robots.txt obeyed, skipped on 401/403/429/503 or a challenge); hash the text against the `source_pages` ledger and skip unchanged pages; one DeepSeek forced-tool call extracts every deal as `{value, quote}` fields; then the gate drops a deal unless:

- every quote is found word for word in the page text (after normalising case, quotes, dashes, whitespace);
- every £ and % figure in a value is in its quote, and any promo code is verbatim, exact case;
- every date and weekday is stated in the quote;
- it is in Edinburgh: an EH postcode in the deal's own text, or the source's `edinburgh_evidence` on the page, or an Edinburgh-only source. The EH districts that count are EH1 to EH17 and EH28 to EH30 (the City of Edinburgh council area). Other EH districts (EH21 Musselburgh, EH22 Dalkeith, EH26, EH39, EH49) are Lothians towns and are rejected, matching the daily deal review. Any other postcode rejects the deal (`not_edinburgh`). A national offer with no postcode passes only from a `national_ok` source, recorded with scope `national`;
- it is not aimed at a restricted group that the schema can't record, such as disabled people, carers, NHS staff, blue light services, the armed forces, veterans, teachers, job seekers or benefit claimants (`restricted_audience_unsupported`). Only a sentence that also reads as an offer counts, so a plain facilities note doesn't trigger it;
- a seasonal offer, such as "kids eat free this summer", states its dates (`seasonal_undated`);
- it has not expired, meaning every stated date has passed (`expired`);
- it passes the Python port of the app's `isGenuineDeal`: a promo code, discount wording, or restricted eligibility with a positive saving. Discount wording covers percentages, "off", "discount", "concession", "half price", "free", "save", "2 for 1" and buy-one-get-one wording (BOGOF, "buy one get one", "get another"). Plain-price vouchers are rejected as `not_a_deal`.

Display-only text that fails its quote check (summary, includes, notes, venue, address, booking link) is dropped from the row rather than rejecting the deal. Survivors are matched against live and dormant rows by `scraper/identity.py`.

- **Shadow** sources are extracted, gated and reported, never staged. Move a source to `live` in the registry only after reviewing one report.
- **Live + official**, every check passed: treated as a verified row (eligible for `--publish`). **Live + commercial**: always staged for review with reason `commercial_source_review`.
- The ledger (`source_pages`, `supabase/add_deal_source_columns.sql`, run by hand) is written only for live sources in a `--stage` run. If the table is missing the run logs it once and treats every page as changed.
- Spend is capped by `--deal-sources-usd` (default `$0.50`), inside `--cap-usd`.

Flags: `--skip-deal-sources`; `--only-deal-sources` (no sweep, direct sources, topics or live rechecks; for testing); `--deal-source ID` (repeatable); `--deal-sources-preview` (fetches and extracts, costs a few cents, writes only files under `scraper/out/<batch-id>/`; no sweep, no ledger, no staging; implies `--only-deal-sources` and refuses `--stage`/`--publish`). The report has a "Deal sources" section; `deal-sources-report.md` and per-source `deal-sources/<id>-records.json` (with every quote) land beside it.

```bash
python3 scraper/weekly_edinburgh.py --deal-sources-preview
```

Run `python3 scraper/test_deal_sources.py` for the unit tests.

### Per-source keys

- `always_pattern` (sitemap discover): a regex for evergreen pages that skip the `modified_within_days` window. A URL matching it is kept whatever its `<lastmod>`; it must still match `pattern`. Edinburgh Leisure uses it so its soft-play, holiday and family pages are read even after more than 90 days without an edit.
- `edinburgh=True`: the whole catalogue is in Edinburgh, so a deal with no EH postcode is still accepted.
- `edinburgh_evidence`: a verbatim line from the page that proves the location, such as an address with its EH postcode in the footer. When it is on the page, every deal from that page passes the Edinburgh rule. A non-EH postcode in a deal's own text still rejects it. Use it on multi-offer pages.
- `national_ok` and `national_venue`: a UK-wide offer valid at a chain's Edinburgh venues. A deal with no postcode passes as a national offer, and its venue is `national_venue`. A non-EH postcode still rejects it. Never set this on a page that lists different local offers for different towns.
- `multi_deal_pages`: the page lists several offers. It gets no page-level image, because its `og:image` is a generic banner. Each deal is judged on its own text plus `edinburgh_evidence`.
- `segment`: a regex for the opening tag of one offer card. When it matches, the page is split into whole cards, and each LLM call sees a few complete cards rather than an arbitrary slice of the page.
- `default_eligibility`: an eligibility the whole scheme shares and the page states once (`local_resident` on Resident Rewards), so it isn't repeated on each card.
- `default_category` (default `food`) and `extract_hints`: the category to use when none is stated, and the instructions the extractor works from. (`default_category` is not read by the runner today; the category comes from the extractor's answer.)

### Annual promotions (`annual.yaml`)

`scraper/deal_sources/annual.yaml` lists promotions that come round once a year. Each entry is a `urls` source, read only inside its window: from six weeks before the first day of its `usual_month` through the last day of that month. All annual entries run in `shadow`.

| id | Promotion | Trust | Usual month |
|---|---|---|---|
| `national-cinema-weekend` | National Cinema Weekend (UK Cinema Association announcement) | commercial | September |
| `doors-open-days-edinburgh` | Doors Open Days (Scottish Civic Trust) | official | September |
| `national-lottery-open-week` | National Lottery Open Week (National Lottery Good Causes) | official | March |

- The `url` in each entry points at the current edition. **Refresh the `url` and `usual_month` every year.** The cinema event moved from summer to a September weekend in 2026, and its announcement URL is for that edition.
- Left out on purpose: Museums at Night (the festival stopped in 2019, and its page is an archive) and Kids Eat Free (no stable official list; the offers are commercial and per venue, so it is covered by the weekly "Kids eat free in Edinburgh" topic, the school-holiday topics and `fort-kinnaird-offers`).

### Deal sites not added

Checked and left out. The manual "Probe event and deal sources" workflow re-checks the blocked ones from GitHub's runners (see `docs/daily-sources.md`).

- **Young Scot:** its terms forbid scraping. Asking for permission is a to-do.
- **Groupon and Wowcher:** Groupon's pages sit behind a Cloudflare challenge. Wowcher's pages are challenged too, and its JSON API is undocumented, so there is no page to check deals against. Both are better reached through an Awin or Partnerize affiliate feed.
- **Blocked:** TheFork, Odeon, Vue (Cineworld's home page is blocked, but its `/movies-for-juniors` page reads fine and is a shadow source above), Tesco Clubcard, O2 Priority, Nando's, OpenTable and EUSA.
- **Not worth it:** DesignMyNight (no offers page), Student Beans and UNiDAYS (national online brands, login-gated) and tastecard (paid membership). Quandoo has shut down.

## Family

Eligibility `family` is for an offer only someone bringing children can use: kids eat free, a child goes free with a paying adult, under-5s free. The deal gate requires child wording (kids, children, under-5s, junior, family) in the evidence quote, so a bare "£5 off" can't become a family offer. A residents-only offer for children (World Children's Day on Resident Rewards) stays `local_resident`, because residency is the binding restriction.

`family_fit` is a separate field: `kids` (aimed at children: a kids' workshop, Bookbug, soft play, kids eat free), `all_ages` (suits young children as well as adults: a free museum, a garden, a parkrun) or null. An offer with eligibility `family`, or a happening in the `family` category, is forced to `kids`. Topic prompts for the family topics tell the model to leave out paid children's classes and term courses with no saving, and private parties.

### School-holiday topics

`scraper/school_holidays.py` lists the City of Edinburgh Council school holidays (source: <https://www.edinburgh.gov.uk/schools/term-dates>, read 20 Oct 2026) through Easter 2028. `upcoming_holiday(today, lead_days=21)` returns the holiday whose window (start minus 21 days, to its last day) holds today. While one does, the weekly run adds two dated topics: "Kids eat free and kids go free in Edinburgh over the <holiday> (<dates>)" (offers, priority 90) and "Edinburgh children's activities over the <holiday> (<dates>)" (calendar, priority 89). **Extend the list each year from the council page**; once today is past the last listed holiday the run logs a warning and the holiday topics stop.

## Cost cap

The default cap is **$3.00**. Before scheduling a topic, the script reserves `--topic-reserve-usd` (default `$0.09`) so concurrent jobs cannot start after the remaining budget is insufficient. It settles each reservation against the token and server-search usage returned by the API, and puts unstarted topics in the report.

The rate flags must match the currently billed DeepSeek account rates; they are command arguments rather than an unstated pricing assumption. Update them if the provider changes pricing:

```bash
python3 scraper/weekly_edinburgh.py \
  --input-usd-per-million 0.28 \
  --output-usd-per-million 0.42 \
  --search-usd 0
```

The family topics rank 26th to 38th of 53 (28th to 40th of 55 when the holiday topics are on, which rank 15th and 19th). A topic starts if spent, reserved and `$0.09` fit under the cap, so with the full `$0.50` deal-source spend they all start while the average topic costs under about `$0.055`; the 27 Sep 2026 run averaged about `$0.015`.

The reservation is the admission-control ceiling. Set it to a larger known per-topic worst case if the account charges for server searches.

## First run — stage, do not publish

Run this from the repository root after applying the happenings migrations and setting `DEEPSEEK_API_KEY`, Supabase credentials, and the service-role key in the existing `.env.local` / `scraper/.env` files:

```bash
python3 scraper/weekly_edinburgh.py --stage
```

Open `scraper/out/edi-weekly-YYYY-MM-DD/weekly-report.md`. It contains the actual usage-derived spend, verified rows, every item needing review with its reason, source failures/blocks, an SQL snippet, and the promotion command.

To preview the configured sources/topics without network, API, database, or file writes:

```bash
python3 scraper/weekly_edinburgh.py --dry-run
```

The report's approve SQL covers every verified row in the batch (`extraction_status = 'validated'`, not yet approved) plus the listed review slugs: delete any review slug you have not checked, run it, then run the report's `promote-happenings.mjs` command. A failed verification is never silently approved.

## Automatic weekly publishing (after the first review)

Once the initial staging report has been checked, this command performs the same run and automatically publishes only source-verified entries:

```bash
python3 scraper/weekly_edinburgh.py --stage --publish
```

## Scheduling later

**GitHub Actions (current):** `.github/workflows/weekly-research.yml` runs `--stage --workers 1` every Monday 11:23 UTC. It never calls DeepSeek in its weekday peak hours (01:00–04:00 and 06:00–10:00 UTC, double price): a scheduled run that GitHub starts late waits for a clear off-peak hour, a manual run in peak stops with the next start time, and `scraper/llm_client.py` refuses DeepSeek in peak regardless (`scraper/deepseek_hours.py`). It never publishes: the report lands in the run summary and as an artifact. Approve rows with the report's SQL, then run the workflow manually with `mode: promote` (and the batch id) to publish them. Needs `DEEPSEEK_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the Production environment.

The local options below remain for running it off GitHub.

### launchd (macOS)

Save this as `~/Library/LaunchAgents/app.fomo.edinburgh-weekly.plist`, replacing `/ABSOLUTE/PATH/TO/Roameo` with this checkout's absolute path:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.fomo.edinburgh-weekly</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string>
    <string>/ABSOLUTE/PATH/TO/Roameo/scraper/weekly_edinburgh.py</string>
    <string>--stage</string><string>--publish</string>
  </array>
  <key>WorkingDirectory</key><string>/ABSOLUTE/PATH/TO/Roameo</string>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>/tmp/fomo-edinburgh-weekly.log</string>
  <key>StandardErrorPath</key><string>/tmp/fomo-edinburgh-weekly-error.log</string>
</dict></plist>
```

Load it with:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.fomo.edinburgh-weekly.plist
```

### cron (Linux/macOS)

Run every Monday at 07:15 (server timezone):

```cron
15 7 * * 1 cd /ABSOLUTE/PATH/TO/Roameo && /usr/bin/python3 scraper/weekly_edinburgh.py --stage --publish >> /tmp/fomo-edinburgh-weekly.log 2>&1
```

Use absolute paths and make sure the scheduler's environment can read the required credentials. Do not put API keys directly into the launchd plist or crontab.
