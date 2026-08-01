# Roameo Scraper (offline Playwright ingestion tool)

This is a **separate, offline Python tool** — not part of the Next.js app. It
runs on your own machine, drives a real browser you log into yourself, and
writes rows directly into your Supabase `social_posts` table over the REST
API. The Next app never scrapes anything at request time; it only reads
whatever rows already exist in `social_posts`.

## Read this first — important caveats

- **This scrapes public TikTok/Instagram content and may violate their Terms
  of Service.** Both platforms restrict automated access. Use this at your
  own risk, for your own **low-volume personal use** (e.g. seeding reels for
  a trip you're planning) — not for commercial use or large-scale collection.
- **It's brittle by design.** These scripts scrape live HTML/DOM structure
  that TikTok and Instagram change frequently and without notice. Selectors
  in `scrape_tiktok.py` / `scrape_instagram.py` are best-effort and marked
  with comments — expect to need small fixes over time as the sites change.
- **Risks**: your IP or your logged-in account can be rate-limited,
  temporarily restricted, or banned by the platform if you scrape too much,
  too fast, or too often. Keep `--limit` low and don't run this on a loop.
- **No bot-detection evasion of any kind.** These scripts do not solve
  CAPTCHAs, do not spoof browser fingerprints, and do not rotate proxies. If
  TikTok or Instagram shows a login wall, CAPTCHA, or checkpoint challenge,
  the script detects it, prints a message, and exits — it will not try to
  get around it. If that happens repeatedly, scraping is not a reliable
  option for you right now; see the fallbacks below.

### Sanctioned fallbacks (use these instead, or once scraping gets blocked)

If you need something more reliable than this scraper — for production use,
higher volume, or because scraping keeps getting blocked — use a licensed
data source instead:

- **[Apify](https://apify.com/store)** — hosted "TikTok Scraper" and
  "Instagram Scraper" actors with pay-per-use pricing; handles a lot of the
  brittleness/anti-bot concerns for you.
- **[RapidAPI](https://rapidapi.com/)** — several third-party TikTok and
  Instagram data endpoints (search by hashtag/keyword, get post details) with
  simple API-key auth.
- **[TikTok Display API](https://developers.tiktok.com/doc/display-api-overview)**
  — TikTok's official API for reading public video data (requires a
  registered developer app).
- **[Instagram Graph API](https://developers.facebook.com/docs/instagram-api/)**
  — Meta's official API for Instagram content (requires a Business/Creator
  account and app review for most endpoints).

## Setup

```bash
cd scraper
pip install -r requirements.txt
playwright install chromium
cp .env.example .env
# then edit .env and fill in SUPABASE_URL / SUPABASE_KEY
```

`SUPABASE_URL`/`SUPABASE_KEY` are read from `scraper/.env` — this is
independent of the Next app's `.env.local` (which uses
`NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`). You can copy the
same project URL and anon key from your Supabase dashboard's **Settings >
API** page into both files.

**Prerequisite:** run these two migrations in the Supabase SQL Editor, in
order, before scraping (see `supabase/README.md`):

1. `supabase/add_social_video_columns.sql` — adds
   `platform`/`video_url`/`thumbnail_url`/`destination`/`place_id` to
   `social_posts`.
2. `supabase/add_scraped_reels_staging.sql` — creates the `scraped_reels`
   staging table (see "Two-table pipeline" below).

**Upsert dedupe key:** upserts go on `video_url`, which requires a unique
index for Postgres to have an `ON CONFLICT` target. Both migrations above
already add this for their respective table. If an upsert fails with an
error about a missing unique/exclusion constraint, that index is missing on
whichever table you're targeting.

## Two-table pipeline: raw scrape → AI classification → curated feed

Reels don't go straight into the table the app reads from. The flow is:

1. **Scrape** (`scrape_tiktok.py` / `scrape_instagram.py` /
   `scrape_places_batch.py`) — everything found lands in `scraped_reels`
   (raw staging), unfiltered, `classified = false`.
2. **Classify** (`classify_reels.py`) — sends each unclassified reel's
   caption + platform + the place name it was searched under to Claude
   Haiku, which decides whether it's genuinely a tourist-destination reel
   for that place (not spam, not a different place, not an unrelated
   trend/audio repost). Writes `classified = true`,
   `is_tourist_reel`, and a one-line `classification_reason` back onto the
   `scraped_reels` row. **Rejected rows are never deleted** — they stay in
   `scraped_reels` for you to inspect via `classification_reason`.
3. **Promote** — reels classified `is_tourist_reel = true` are upserted into
   `social_posts`, the curated table `lib/db/social.ts` `listReels()` (and
   the Trending-on-Social feed) actually reads from.

```bash
# 1. Scrape into staging (as before — upsert_reels() now defaults to scraped_reels)
python scrape_places_batch.py --platform both --limit-per-place 5

# 2. Classify + promote approved reels into social_posts
python classify_reels.py --limit 50 --batch-size 15
```

Re-run `classify_reels.py` any time — it only ever processes rows still
marked `classified = false`, so it's safe to run repeatedly as new reels get
scraped. `--model` (or the `REEL_CLASSIFY_MODEL` env var) overrides the
default `claude-haiku-4-5-20251001`. Requires `ANTHROPIC_API_KEY` in
`scraper/.env`.

## First-run login

**If TikTok login won't complete, this is the section you want.**

Playwright's *bundled Chromium* is a stripped build (no proprietary codecs,
no Widevine, no Chrome branding, and Playwright's launch flags set
`navigator.webdriver = true`). TikTok's login endpoints behave badly on it:
the phone/SMS form loops back on itself, and the QR flow shows "approved" on
your phone while the desktop page never advances. That is not a captcha and
not something to work around — the fix is to stop using that browser and
drive a **real Google Chrome** instead.

`browser_session.py` does that. Log in once:

```bash
# opens a real Chrome, waits (indefinitely) for you to log in, then exits
python scraper/browser_session.py --platform tiktok
python scraper/browser_session.py --platform instagram
```

That window is a normal Chrome — same binary you use every day — started with
`--remote-debugging-port` on its own profile directory, which Playwright then
attaches to over CDP and drives a tab in. Nothing is patched or spoofed;
`navigator.webdriver` is `false` there simply because nothing set it. Both
platforms share the one profile at
`scraper/.pw-profile/chrome-attach/default/`, so log into both in the same
window. Every later run reuses that session.

Three browser modes, on both `browser_session.py` and `scrape_places_batch.py`:

| `--browser-mode` | What it does | Login reliability |
|---|---|---|
| `attach` *(default)* | Starts/reuses your real Chrome, drives it over CDP. `navigator.webdriver` = false. | Best — use this |
| `channel` | Playwright launches real Chrome (`channel="chrome"`) with a persistent profile. | OK — real binary, still flagged as automated |
| `chromium` | Playwright's bundled Chromium (the old behavior). | Where the TikTok login trouble comes from |

Other flags: `--cdp-port` (default 9222), `--chrome-user-data-dir`,
`--chrome-path`, `--close-browser` (quit the Chrome we started when the run
ends — off by default so the login stays warm).

Login is detected from the **session cookie**, not the DOM: TikTok renders a
`profile-icon` element on logged-*out* pages, so a DOM check reports "logged
in" when you aren't and the batch then scrapes nothing for hours.

The one-off `scrape_tiktok.py` / `scrape_instagram.py` scripts still use their
own persistent profile under `scraper/.pw-profile/<platform>/` with a visible
window. Nothing here ever reads, stores, or requests your password.

## Usage

```bash
# TikTok: search "Tokyo", collect up to 15 reels, upsert straight to Supabase
python scrape_tiktok.py --query "Tokyo" --limit 15

# Instagram: query is used as a hashtag (spaces/punctuation stripped)
python scrape_instagram.py --query "kyoto travel" --limit 10

# Tag rows with a specific trip destination different from the search query
python scrape_tiktok.py --query "shibuya crossing" --destination "Tokyo" --limit 10

# Dry run: dump results to JSON instead of touching Supabase, so you can review first
python scrape_tiktok.py --query "Tokyo" --limit 10 --dump-json out.json

# Review out.json, then upsert it later once you're happy with it (defaults to scraped_reels)
python upsert_supabase.py out.json
python upsert_supabase.py out.json --table=social_posts  # only for already-classified rows

# Run headless once you've already logged in via a previous visible run
python scrape_instagram.py --query "Tokyo" --headless
```

### CLI flags (both scrapers)

| Flag | Default | Description |
|---|---|---|
| `--query` | *(required)* | Keyword/hashtag/location to search for. |
| `--limit` | `20` | Max reels to collect. Keep this low for politeness. |
| `--destination` | value of `--query` | Tags rows' `destination`/`location` columns (e.g. the trip's destination). |
| `--headless` / `--no-headless` | `--no-headless` (visible) | Visible is the default so you can log in on first run. |
| `--dump-json PATH` | *(none)* | Write results to a JSON file instead of upserting to Supabase. |

## Batch mode — scraping a whole list of places

`scrape_places_batch.py` runs `scrape_tiktok`/`scrape_instagram` over a list
of place names instead of one `--query` at a time, using **one browser
session per platform for the entire run** — the whole place list across all
cities, not one browser per city.

```bash
# log in first (see "First-run login"), then:
python scrape_places_batch.py --platform tiktok --limit-per-place 5

# see exactly what queries would run, without opening a browser
python scrape_places_batch.py --platform tiktok --dry-run

# one city, first 10 places, keep results local instead of upserting
python scrape_places_batch.py --platform tiktok --only-city chiyoda \
  --max-places 10 --no-upsert

# custom pacing
python scrape_places_batch.py --platform tiktok --batch-size 6 \
  --batch-rest-min 90 --batch-rest-max 180
```

- **Place list**: reads every `*.json` file in `--consolidated-dir` (default
  `consolidated/`, the enrichment pipeline's per-city output — see
  JAPAN_PLACES_PIPELINE.md), each holding a `{"records": [...]}` list.
  `_report.json` and `kanto_places.json` (a different, already-merged schema)
  are skipped. The full list is assembled up front and deduped on
  `dedupe_key`, so a place appearing in two city files is scraped once.
  Narrow it with `--only-city` / `--skip-city` (repeatable, by file stem) and
  `--max-places`.
- **Search queries** are templated per platform: TikTok gets
  `"{name} {city}"` by default so "Tsutaya Books" doesn't return every
  Tsutaya on earth; Instagram gets `"{name}"` only, since its query is
  squashed down to a hashtag. Override with `--tiktok-query` /
  `--instagram-query` (fields: `{name}`, `{city}`, `{prefecture}`).
- **Login waiting, for real**: at the start of each platform's run (and again
  any time a session looks logged out mid-batch), the script polls until it
  sees a logged-in session cookie — it doesn't just check once and quit. You
  log in manually in the Chrome window; the script waits (indefinitely by
  default, `--login-timeout` to cap it) and resumes on its own once you're in.
- **Adaptive backoff**: after `--block-threshold` consecutive empty places
  (default 3) it checks whether the session dropped — if so it pauses for you
  to log back in, otherwise it cools off for `--cooldown` seconds (default
  300) rather than grinding through hundreds of places against a soft
  throttle. After `--max-cooldowns` (default 2) fruitless cooldowns it stops
  that platform so you can come back later.
- **Nothing scraped is lost**: every reel is appended to
  `data/scraped_<platform>.jsonl` *before* the Supabase upsert is attempted,
  and an upsert failure is reported without killing the run. `--no-upsert`
  keeps results local only.
- **Batched pacing + light "human" texture**: a randomized delay
  (`--place-delay-min/max`, default 10-25s) between places, plus a longer
  rest (`--batch-rest-min/max`, default 90-180s) every `--batch-size` places
  (default 8). Small randomized mouse movements and idle pauses
  (`humanize.py`) are dropped in between actions so the run doesn't read as a
  metronomic scroll-extract loop. This is pacing/movement texture only — no
  fingerprint spoofing, no header/UA tricks, no CAPTCHA handling. Same
  no-evasion rule as the rest of this tool.
- **Resumable**: progress is written *atomically* to `--progress-file`
  (default `data/batch_progress.json`) after every single place, keyed by
  each place's `dedupe_key`, so Ctrl-C or a crash loses at most one place's
  work and can't corrupt the file mid-write. Re-running the same command
  skips places already marked `"done"` and retries anything left `"blocked"`
  or `"error"`. Progress rows from older runs keyed by plain place name are
  still honoured, so upgrading doesn't re-scrape them. `--force` re-scrapes
  everything regardless.
- Each reel is tagged with `location` = the specific place name searched and
  `destination` = the place's own `prefecture` (falling back to city) unless
  you pass `--destination` — so you can distinguish "reels about this exact
  place" from "reels about the trip generally."

## Responsible-use behavior baked into the code

- Randomized 2-5s delays between every scroll step and every individual post
  visit (`polite_delay()` in both scripts) — deliberately slow, not
  optimized for throughput.
- Strictly honors `--limit`; stops scrolling once enough unique reels are
  collected or after a few scrolls produce nothing new.
- Uses your own persistent, logged-in browser session — never automates
  login and never touches credentials. Attach mode drives a stock Google
  Chrome you logged into yourself; it patches nothing, spoofs no fingerprint
  or user-agent, and rotates no proxies. Choosing which real browser to use
  is not evasion.
- Detects login walls, CAPTCHAs, and checkpoint/challenge pages
  (`detect_block()` in both scripts) and exits with a clear message instead
  of attempting to bypass them.
- Every per-item extraction is wrapped in `try/except` — a single malformed
  card/post is skipped (logged to stderr) rather than crashing the run.
- Reels with no extractable `video_url` (the dedupe key) are skipped, both
  during scraping and again defensively in `upsert_supabase.py`.

## Files

- `scrape_tiktok.py` — searches TikTok's video search results for `--query`.
  Exposes `search_and_extract(page, query, limit)`, reused by batch mode.
- `scrape_instagram.py` — searches Instagram Reels via the `--query` hashtag
  explore page (Instagram doesn't offer public free-text search). Also
  exposes `search_and_extract(page, query, limit)`.
- `scrape_places_batch.py` — runs either scraper over every place record in
  `consolidated/*.json` on one browser session per platform. See "Batch mode"
  above.
- `browser_session.py` — how a usable, logged-in browser is obtained:
  attach-to-real-Chrome over CDP (default), Playwright-launched real Chrome,
  or bundled Chromium. Also holds the cookie-based login detection and
  `wait_for_login()`. Runnable on its own to log in once up front — see
  "First-run login".
- `humanize.py` — pacing texture used by batch mode: `human_mouse_move()` /
  `human_idle()`. (Its older `wait_for_login()` is superseded by the
  cookie-based one in `browser_session.py`.)
- `consolidated/*.json` — the per-city place lists batch mode reads by
  default (produced by the enrichment pipeline).
- `data/batch_progress.json` — created on first batch run; tracks which
  places are done/blocked/errored per platform so runs are resumable. Safe to
  delete to force a full re-scrape.
- `data/scraped_<platform>.jsonl` — append-only local backup of every reel
  scraped, written before the Supabase upsert so nothing is lost to a
  network/Supabase failure.
- `classify_reels.py` — reads unclassified `scraped_reels` rows, asks Claude
  whether each is a genuine tourist-destination reel, and promotes approved
  ones into `social_posts`. See "Two-table pipeline" above.
- `upsert_supabase.py` — shared helper: upserts a list of reel dicts into a
  Supabase table (`scraped_reels` by default, or `social_posts` for
  promotion) via the REST API; also runnable standalone against a
  `--dump-json` output file.
- `requirements.txt` — `playwright`, `python-dotenv`, `requests`.
- `.env.example` — copy to `.env` and fill in `SUPABASE_URL` / `SUPABASE_KEY`.
- `.pw-profile/` — created on first run; holds your persistent, logged-in
  browser sessions per platform. **Do not commit this directory** — it
  contains your session cookies (add it to `.gitignore` if you version this
  repo, alongside `.env`).
