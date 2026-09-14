# Weekly Edinburgh happenings pipeline

`scraper/weekly_edinburgh.py` is the safe weekly refresh for the Edinburgh happenings catalogue. It reads publisher pages first, runs narrow research topics independently, and reloads every candidate from its cited page before it can be staged. Nothing is deleted.

## What a run does

1. Runs the lifecycle sweep, moving expired one-off live entries to `dormant`. It never deletes a row or auto-retires a source merely because a request failed.
2. Reads the configured official/publisher pages directly. It obeys `robots.txt`, and logs then drops pages which block, challenge, or rate-limit the script. JSON-LD events are imported without AI; a page with no structured event data is simply recorded as read.
3. Runs 32 small DeepSeek research topics in priority order: ticket releases, resident rewards, concessions, offers, low-cost cinema, comedy, ceilidhs, parkruns, markets, free tours, family activity, museum lates, festivals, and seasonal/council events. Each has its own source seeds. Up to four run concurrently.
4. Merges duplicate title/date candidates and creates conservative city-level collections for truly identical activity families: for example, Cramond, Holyrood, and Portobello become one **Edinburgh parkruns** card, while retaining and checking every individual source page. It does not collapse unrelated items merely because they share a category. Before verification, two silent (non-review) drops happen: a candidate whose every stated date has already passed (e.g. this year's already-finished Fringe dates mislabelled "annual"), and a candidate that names no concrete date, price/promo code, or venue — generic programme narration rather than a real thing to do or offer.
5. The run then links high-confidence venues to existing places and reloads every remaining candidate's source page (falling back to its other `source_urls`/`booking_url` if the first is blocked or challenged). A price, promo code, date, stated recurrence weekday, and booking release date/time must still be visibly stated on that page — verbatim for promo codes/saving figures, verbatim OR any common textual format (UK numeric, ordinal-day, weekday-abbreviated, etc.) for dates. The title/venue name is only a soft relevance signal — an LLM-paraphrased title is expected to never match verbatim — used solely to catch a page that turns out to be about something else. Anything that fails a hard check remains a review item rather than a live entry.
6. Writes a Markdown and JSON report plus the verified JSON output under `scraper/out/<batch-id>/`.

When `--publish` is explicitly used, only the just-verified rows are marked approved and promoted; publisher preview images are then attached. The normal first run below never publishes.

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

To approve specific review rows after checking them, use the report's SQL, then run its `promote-happenings.mjs` command. A failed verification is never silently approved.

## Automatic weekly publishing (after the first review)

Once the initial staging report has been checked, this command performs the same run and automatically publishes only source-verified entries:

```bash
python3 scraper/weekly_edinburgh.py --stage --publish
```

## Scheduling later

No scheduler is installed. Pick one of the following only when ready to automate the post-review command.

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
