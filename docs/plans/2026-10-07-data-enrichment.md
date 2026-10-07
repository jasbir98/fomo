# Fomo: fill in Edinburgh place and deal data (Google Places + venue pages + Claude agents)

## Context
Ask Fomo gives weak or wrong answers when the data behind them is thin. Example: Bar 50 has no summary and no price, so Fomo couldn't say "£20 for two".

A read-only count on 7 Oct shows:

**Edinburgh `places` (503 rows), missing:**
- `google_place_id`: 426
- `rating`: 426
- `hours`: 367
- `image_url`: 366
- `price_level`: 349
- `opening_hours`: all 503 (nothing ever writes it)
- website, phone, review count and summary: no columns exist for these

**Live `happenings` (209 rows):**
- 117 are paid with no £ figure
- 97 have no redemption note
- 59 have no hours (`time_note`)
- 143 aren't linked to a place
- 15 have no summary

The goal is to fill the basics Fomo needs to answer properly, and to feed Google's facts into answers alongside Fomo's own data.

**Decisions (user, 7 Oct):**
- Google data is stored and refreshed monthly, because Google's terms allow storing it for at most 30 days (the place ID can be kept forever).
- This first pass uses Claude Code agents: Haiku extracts and Sonnet reviews. Later re-runs use the existing DeepSeek pipeline.
- Writes go to production as "fill blanks on OK; any change to an existing value is reviewed". Always dry run first.

## 1. Migration: `supabase/add_enrichment_columns.sql` (user runs it in the SQL editor)
- **`places`:** `website text, phone text, google_rating_count int, price_range text, business_status text, google_maps_uri text, google_summary text, google_summary_disclosure text, google_fetched_at timestamptz`.
- **`happenings`:** `price_text text` ("£20 for two", "From £15"), `includes text` ("Pizza or burger, a side and a drink each"), `enrich_sources jsonb` (field → {url, quote}), `enriched_at timestamptz`.
- **Types:** add the same fields to `lib/types.ts` (Place) and `lib/happenings/types.ts` (Happening). Existing public-select RLS already covers new columns.

## 2. Places from Google: `scripts/enrich-places-google.mjs` (Node; Sonnet builds it)
- **Patterns to reuse:** the REST and pagination pattern from `scripts/enrich-places-data.mjs`; name normalising and matching from `scripts/lib/place-match.mjs` (`nameKey`, `normalizeName`); Google enum maps from `lib/places/google.ts` (price level).
- **Resolve place IDs (426 rows):**
  - Use Text Search with an IDs-and-location field mask, querying "name, address-or-Edinburgh" with a 10 km bias around the city centre.
  - Accept a result only when the names match by key or prefix AND it is ≤250 m from the stored lat/lng (≤2 km if we only have an address).
  - Anything else goes into the report as AMBIGUOUS and is never written.
- **Place Details (every row with an ID):**
  - Fields requested: `regularOpeningHours, rating, userRatingCount, priceLevel, priceRange, websiteUri, nationalPhoneNumber, businessStatus, googleMapsUri, formattedAddress, location, editorialSummary, reviewSummary, generativeSummary`.
  - **Fill only when blank:** `opening_hours` (from `periods`), `hours` (weekday descriptions compacted to "Mon–Fri 10:00–17:00, Sat …"), `address`, `lat`/`lng`, `price_level`.
  - **Google-owned fields, always written and refreshed:** rating, count, price range, website, phone, maps URI, summary plus its disclosure, `google_fetched_at`.
  - **Flagged for review:** CLOSED_PERMANENTLY, or a location more than 250 m from the stored one.
- **Modes:**
  - default dry run, which writes `scraper/out/enrich-YYYY-MM-DD/places-report.md` and `places-proposals.json`
  - `--apply` (fills plus Google-owned fields)
  - `--apply-changes <file>` (reviewed changes)
  - `--refresh` (only rows with `google_fetched_at` older than 25 days; Google-owned fields only)
- **Safety:**
  - A rollback file records the previous values.
  - `--max-calls` caps spending, and the script prints its estimated Google calls before it runs.
  - It never deletes.
  - Rows whose Google fields are over 30 days old and couldn't be refreshed get those fields cleared, to stay within Google's terms.
- **Tests:** pure helpers (hours compaction, period mapping, match acceptance) in `scripts/lib/google-place-map.mjs` plus `*.test.mjs`.

## 3. Deal pages: `scraper/fetch_happening_pages.py` (Python + Playwright headless Chromium; Sonnet builds it)
- **Scope:** all 209 live happenings, gappiest first. Fetch `source_url`, falling back to `booking_url`.
- **Politeness and blocks:**
  - Obey robots.txt and fetch at most once every 2 s per domain.
  - Reuse the challenge-page detection in `scraper/weekly_edinburgh.py` (`_looks_like_challenge_page`).
  - Cloudflare, 403 or a CAPTCHA is logged and skipped, never bypassed.
- **Saved per row:** `out/enrich-…/pages/<id>.json` = {url, final_url, title, main text (≤15k characters), JSON-LD, og:image}.

## 4. Extraction by Claude Code agents (one-off) + a hard evidence gate
- **Haiku agents:** 14 batches of about 15 rows, 4 at a time. Each reads the saved pages plus the current row and writes `extract/batch-NN.json`.
  - Fields: `price_text, includes, summary (≤160), time_note, redemption_note, eligibility_note, venue_name, address`.
  - Each field comes with a verbatim evidence quote and its URL, or null when the page doesn't say.
- **`scripts/check-happening-extractions.mjs`:** every evidence quote must appear in the saved page text (whitespace-normalised), and every £ figure must appear in its quote. Anything that fails is dropped. This is the same "visibly stated on the page" rule as `docs/weekly-pipeline.md`.
- **Sonnet agent review:** every proposal that would change an existing value, every `price_text`, and a random 10% of fills. It writes its verdicts, and rejected rows are dropped.
- **Report and apply:**
  - `happenings-report.md` (fills / changes / blocked pages) is produced.
  - `scripts/apply-happening-enrichment.mjs` applies with `--apply` (fill blanks only; also writes `enrich_sources`, `enriched_at`) and `--apply-changes <approved.json>`, with a rollback file.
- **Afterwards:** re-run `scripts/link-happening-places.mjs` as a dry run, then `--apply` on OK, to link more of the 143 unlinked deals.

## 5. Use the data in the app (Sonnet builds it; small PR)
- **Chat catalogue line** (`app/api/chat/route.ts` `buildCatalogue`):
  - Add `price_text` and `includes`.
  - For a linked place (already loaded through `loadPlacesForHappenings`; widen it to load every linked place): Google rating (count), price range, and today's hours from `opening_hours`.
  - Prompt: these are facts it may use in `top_pick` ("rated 4.6 on Google", "£20 for two").
  - Google's AI summary is not quoted by Fomo. It's displayed only with its disclosure.
- **Happening cards and detail:** show `price_text` in preference to the saving badge where it exists (`lib/happenings/format.ts` `savingBadgeLabel` caller in chat, plus `components/detail/HappeningDetail.tsx`), and show `includes` on the detail page.
- **`components/detail/PlaceDetail.tsx`:**
  - address, website, phone
  - today's hours plus the week
  - "★4.6 (1.2k) on Google"
  - Google summary with "Summarized with Gemini"
- **Monthly refresh:** `.github/workflows/monthly-places-refresh.yml` runs `enrich-places-google.mjs --refresh --apply` (the user adds a `GOOGLE_PLACES_API_KEY` secret).
- **Later (not this pass):** add the extraction step to `weekly_edinburgh.py` on DeepSeek, and add a to-do in `docs/README.md`.

## Order and checkpoints
1. Sonnet builds the migration, script 2, the fetch script, the check and apply scripts, and their tests. Main reviews the diffs.
2. **User runs the migration.**
3. Places dry run, then report to the user, then **user OK**, then `--apply`.
4. Fetch pages, then Haiku extraction, then the evidence gate, then Sonnet review, then report, then **user OK**, then apply. Then the linker dry run, then apply.
5. App/chat PR; test locally against the enriched data; user merges; the monthly workflow is added.

## Cost (to confirm on Google Cloud billing)
- **Google:** about 430 ID lookups plus about 500 Place Details calls, which should fit Google's free monthly allowance. The script prints the call counts before spending, and `--max-calls` caps them.
- **Pages:** no cost.
- **Claude:** runs inside Claude Code agents, so no API key is needed.

## Verification
- **Automated:** unit tests for the mapping, matching and evidence-gate helpers; `tsc`, `eslint`, all tests, `npm run build`.
- **Places:** check 10 random rows by hand against Google Maps; confirm AMBIGUOUS rows were not written.
- **Deals:**
  - check 10 random rows against their source pages
  - confirm every applied value has an `enrich_sources` quote
  - Bar 50 should now have `price_text` "£20 for two" (or whatever its page says) and `includes`
- **Chat**, local and then production, three questions:
  - "Date night for two under £20?" should state the real price and what's included.
  - "Somewhere open late on a Sunday?" should use hours.
  - "Is the National Museum worth it?" should give the rating and open hours.
- **Rollback:** each run's rollback file restores previous values with `--rollback <file>`.
