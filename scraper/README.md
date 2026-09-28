# Roameo Scraper

Python pipelines for discovering and enriching Edinburgh places and happenings (events/deals).

## Pipelines

### Weekly Edinburgh Happenings (`weekly_edinburgh.py`)

Runs weekly via GitHub Actions (`.github/workflows/weekly-happenings.yml`). Scrapes public Edinburgh event listing pages and APIs to build a curated feed of deals, events, and things-to-do. Results are promoted into the `happenings` table by `scripts/promote-happenings.mjs`.

**Sources:**
- Public listing pages (via JSON-LD): Luma, Eventbrite, Songkick, AllEvents
- Venue RSS feeds: Sneaky Pete's
- Structured APIs (key-based): Skiddle Events API, Ticketmaster Discovery v2
- Web research: Anthropic API (for deal detection and descriptions)

**Flow:**
```bash
python scraper/weekly_edinburgh.py --output data/weekly_research.json
# Review, approve rows manually, then promote them:
node --env-file=.env.local scripts/promote-happenings.mjs
```

See `docs/daily-sources.md` for the daily ingest pipeline (scraped pages + API).

### Generic City Places Pipeline

Discovers and enriches places for any city (used for Scotland). Finds unique venues, geocodes them, fetches Wikimedia photos, and enriches with opening hours and Wikipedia links.

**Main scripts:**
- `discover_cities.py` — lists all cities in a country (Scotland)
- `discover_and_extract_city.py` — extracts venues from Wikipedia and Google Places for a single city
- `run_city_batch.py` — orchestrates the full pipeline: discover → extract → geocode → enrich → merge
- `merge_neighbourhood_batch.py` — combines city results into one feed
- `photos_wikimedia.py` — fetches hero photos from Wikimedia Commons

**Configuration:**
- `scraper/countries/` — per-country config (Scotland only currently)
- `scraper/data/` — working data directory

**Flow:**
```bash
# 1. Discover and extract places for a city
python scraper/discover_and_extract_city.py --city Edinburgh --country-code GB

# 2. Run full pipeline for all cities
python scraper/run_city_batch.py --country-code GB

# 3. Promote approved staging rows into live places table
node --env-file=.env.local scripts/promote-places.mjs --country-code GB --source seed-scotland-pipeline
```

## Setup

```bash
cd scraper
pip install -r requirements.txt
cp .env.example .env
# Fill in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
```

**Requires:**
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (server-role key, not anon)
- `ANTHROPIC_API_KEY` (for research + classification)
- Optional: `DEEPSEEK_API_KEY` (for classification fallback)

**Important:** Use the **service-role key** from Supabase → Settings → API. It bypasses RLS and is required for writing to staging/pipeline tables. Treat it like a password: never commit it, never use in `NEXT_PUBLIC_` variables.

## Files

- `weekly_edinburgh.py` — Edinburgh-specific weekly research pipeline
- `discover_cities.py` — list all cities in a country
- `discover_and_extract_city.py` — extract venues from Wikipedia + Google Places
- `run_city_batch.py` — full pipeline orchestration
- `merge_neighbourhood_batch.py` — combine results into one feed
- `geocode_osm.py` — batch geocoding via OpenStreetMap Nominatim
- `photos_wikimedia.py` — fetch Wikimedia Commons photos
- `enrich.py` — add opening hours, Wikipedia links, and other details
- `upsert_supabase.py` — shared upserter for staging/live tables
- `llm_client.py` — LLM abstraction (DeepSeek or Anthropic)
- `countries/` — per-country config (base.py, scotland.py)
- `data/` — working directory for intermediate results
- `requirements.txt` — Python dependencies

## Notes

- All pipelines write to staging tables first (`places_staging`, `happenings_staging`) for review
- Promotion scripts promote approved rows into live tables (`places`, `happenings`)
- Staging tables have **no anon/authenticated write policy** — pipelines require the service-role key
- See `supabase/README.md` for database schema and RLS details
