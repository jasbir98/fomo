# Weekly Edinburgh happenings pipeline

`scraper/weekly_edinburgh.py` is the safe weekly refresh for the Edinburgh happenings catalogue. It reads publisher pages first, runs narrow research topics independently, and reloads every candidate from its cited page before it can be staged. Nothing is deleted.

## What a run does

1. Runs the lifecycle sweep, moving expired one-off live entries to `dormant`. It never deletes a row or auto-retires a source merely because a request failed.
2. Reads the configured official/publisher pages directly. It obeys `robots.txt`, and logs then drops pages which block, challenge, or rate-limit the script. JSON-LD events are imported without AI; a page with no structured event data is simply recorded as read.
3. Runs the page-grounded **deal sources** (see below), inside their own sub-cap, after the direct sources and before the search topics.
4. Runs 47 small DeepSeek research topics in priority order: ticket releases, resident rewards, concessions, offers, low-cost cinema, comedy, ceilidhs, parkruns, markets, free tours, family activity, museum lates, festivals, sports fixtures, and seasonal/council events. Each has its own source seeds. Up to four run concurrently.
5. Merges duplicate title/date candidates and creates conservative city-level collections for truly identical activity families: for example, Cramond, Holyrood, and Portobello become one **Edinburgh parkruns** card, while retaining and checking every individual source page. It does not collapse unrelated items merely because they share a category. Before verification, two silent (non-review) drops happen: a candidate whose every stated date has already passed (e.g. this year's already-finished Fringe dates mislabelled "annual"), and a candidate that names no concrete date, price/promo code, or venue — generic programme narration rather than a real thing to do or offer.
6. The run then links high-confidence venues to existing places and reloads every remaining candidate's source page (falling back to its other `source_urls`/`booking_url` if the first is blocked or challenged). A price, promo code, date, stated recurrence weekday, and booking release date/time must still be visibly stated on that page — verbatim for promo codes/saving figures, verbatim OR any common textual format (UK numeric, ordinal-day, weekday-abbreviated, etc.) for dates. The title/venue name is only a soft relevance signal — an LLM-paraphrased title is expected to never match verbatim — used solely to catch a page that turns out to be about something else. Anything that fails a hard check remains a review item rather than a live entry.
7. Writes a Markdown and JSON report plus the verified JSON output under `scraper/out/<batch-id>/`.

When `--publish` is explicitly used, only the just-verified rows are marked approved and promoted; publisher preview images are then attached. The normal first run below never publishes.

## Deal sources (`scraper/deal_sources/`)

Deals are read straight from the pages that state them, instead of from search results. Each source in `scraper/deal_sources/registry.py` has a `trust` (`official` or `commercial`) and a `status` (`shadow` or `live`), and a `discover` rule: a WordPress REST query, a sitemap filter, a fixed URL list, or a listing page's links.

Per page: fetch politely (the bot's real identity, robots.txt obeyed, skipped on 401/403/429/503 or a challenge); hash the text against the `source_pages` ledger and skip unchanged pages; one DeepSeek forced-tool call extracts every deal as `{value, quote}` fields; then the gate drops a deal unless:

- every quote is found word for word in the page text (after normalising case, quotes, dashes, whitespace);
- every £ and % figure in a value is in its quote, and any promo code is verbatim, exact case;
- every date and weekday is stated in the quote;
- it is in Edinburgh (an EH postcode in the deal's text, or an Edinburgh-only official source; a non-EH postcode rejects it);
- it has not expired;
- it passes the Python port of the app's `isGenuineDeal` (promo code, discount wording, or restricted eligibility with a positive saving). Plain-price vouchers are rejected as `not_a_deal`.

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

## Cost cap

The default cap is **$3.00**. Before scheduling a topic, the script reserves `--topic-reserve-usd` (default `$0.09`) so concurrent jobs cannot start after the remaining budget is insufficient. It settles each reservation against the token and server-search usage returned by the API, and puts unstarted topics in the report.

The rate flags must match the currently billed DeepSeek account rates; they are command arguments rather than an unstated pricing assumption. Update them if the provider changes pricing:

```bash
python3 scraper/weekly_edinburgh.py \
  --input-usd-per-million 0.28 \
  --output-usd-per-million 0.42 \
  --search-usd 0
```

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

**GitHub Actions (current):** `.github/workflows/weekly-research.yml` runs `--stage --workers 1` every Monday 05:23 UTC. It never publishes: the report lands in the run summary and as an artifact. Approve rows with the report's SQL, then run the workflow manually with `mode: promote` (and the batch id) to publish them. Needs `DEEPSEEK_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the Production environment.

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
