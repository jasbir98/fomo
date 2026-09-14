# Places Pipeline

This pipeline prepares admin-unit-based place data (Japan prefectures,
Scottish council areas, etc.) without letting LLM output write directly into
the production `places` table. The scripts are country-agnostic — pass
`--country` to pick which one; see `scraper/countries/` for what's currently
configured (Japan, Scotland). Country-specific pieces (the admin-unit ->
region grouping, source guidance, category examples) live in
`scraper/countries/<name>.py`; everything else (resumability, dedupe-key
format, citation/validation rules, the staging schema) is shared.

## Model Split

| Stage | Model | Purpose |
|---|---|---|
| Source discovery | Haiku 4.5 | Find official/tourism-board/Wikidata/Wikimedia candidates and URLs. |
| Extraction | Haiku 4.5 | Convert approved source text into cited staging JSON. |
| Validation | Haiku 4.5 + rules | Reject uncited fields, unlicensed photos, missing identity. |
| Implementation | Sonnet 4.6 | Maintain scripts, migrations, import flow. |
| Critical review | Opus 4.7 | Review pilot batch before promotion into `places`. |

## City Discovery

`discover_cities.py` is Stage 1 of scaling this pipeline nationwide: one
Haiku 4.5 call per admin unit (all of them, for the chosen `--country`),
asking for tourist-relevant cities/towns/wards/districts with a
`major`/`mid`/`minor` tier and a one-line reason. It excludes cities already
promoted into `places` for that country (any source containing "seed",
filtered by `country=eq.<code>`, fetched via Supabase REST — best-effort, a
failed fetch just logs a warning and continues with no exclusions) and
writes a flat national list to `data/<country>_cities.json` for Stage 2
(per-city place discovery) to consume — Japan keeps its historic bare
`data/japan_cities.json` / `data/discover_cities_progress.json` filenames
for backward compatibility with the in-flight national scale-up; every other
country gets a `<country>_`-prefixed pair instead. It is resumable via
`--progress-file`, writing the output incrementally so a crash partway
through a full run loses at most one admin unit.

```bash
python discover_cities.py --country japan                          # full run, all 47 prefectures
python discover_cities.py --country japan --admin-unit Tottori      # single admin unit, for testing
python discover_cities.py --country scotland --dry-run              # skip the Supabase exclusion fetch
python discover_cities.py --country japan --start-from Kyoto        # resume a full run
```

`--prefecture` is kept as an alias for `--admin-unit` (same flag, `dest="admin_unit"`).

## Per-City Discovery + Extraction (Haiku)

`discover_and_extract_city.py` is Stage 2 for a single city: it researches
tourist places directly via the API's server-side `web_search` tool (no
Agent-tool subagent spawning — a spawned Haiku subagent's 200K context can't
hold the inherited MCP toolset and fails with "prompt too long"), then makes
a forced tool-use call to extract cited, structured records in the same
`{"records": [...]}` shape the wave-1 city subagents used. It supersedes
per-city Sonnet subagents starting wave 2 of the Japan pipeline. Target place
count scales with `--tier` (major=40, mid=30, minor=15-20); a city with
genuinely fewer tourist-relevant places is not force-padded to hit the
target. `--region` must be one of the chosen country's regions (see
`scraper/countries/<name>.py`'s `admin_unit_region` grouping); the model's
example categories and preferred sources also come from that country config.

```bash
python discover_and_extract_city.py \
  --country japan --city Nagatoro --prefecture Saitama --region Kanto \
  --tier mid --batch-id jp-saitama-wave2-2026-07-24

python discover_and_extract_city.py \
  --country scotland --city Portree --prefecture Highland \
  --region "Highlands" --tier mid --batch-id scot-highland-pilot-2026-07-25
```

Writes `out/<batch-id>/<city-slug>.json`. `--output-dir` overrides the
default location; `--model` overrides the default `claude-haiku-4-5`. Safe
to re-run — each invocation overwrites its own output file rather than
appending duplicates.

## Batches

Japan:
- Pilot 0 (done): Kanto sample — Kamakura, Hakone, Yokohama, Narita, Choshi/Katori. See `supabase/seed_japan_pilot.sql`.
- Pilot 1 (done): Tokyo prefecture — Shibuya, Shinjuku, Taito wards (54 places + 3 city_foods). See `supabase/seed_japan_tokyo.sql`.
- Batch 1: Remaining Tokyo wards (Chiyoda, Minato, Sumida, Koto, Meguro, Setagaya, Bunkyo, …)
- Batch 2: Hokkaido
- Batch 3: Aomori, Iwate, Akita
- Batch 4: Miyagi, Yamagata, Fukushima
- Batch 5: Ibaraki, Tochigi, Gunma, Saitama

Scotland (see `plan-scotlandPlaceSeedData.prompt.md` at the repo root for the
full plan):
- Pilot: Edinburgh, Isle of Skye, Inverness/Loch Ness, St Andrews, Stirling, Glasgow (agent-driven variant first, then `discover_and_extract_city.py --country scotland` per town).
- Scale-up order after the pilot: Edinburgh & Lothians → Glasgow & Clyde Valley → Highlands → Aberdeenshire & Grampian → Fife & Perthshire → Argyll & the Isles → Ayrshire & Arran → Scottish Borders & Dumfries and Galloway → Angus & Dundee → Outer Hebrides / Orkney / Shetland.

## Agent-driven variant (no Python / no API keys)

Japan's Pilot 0 and Pilot 1 were produced end-to-end by parallel CLI
sub-agents rather than the Python extractor. Cheap models do the research, a
cheap model consolidates, and Opus adjudicates before promotion. This keeps
LLM costs low and avoids per-service API key management for exploratory
batches — the recommended way to validate a brand-new country (like
Scotland's pilot) before running the Python/Haiku pipeline nationwide.

| Stage | Model | Notes |
|---|---|---|
| Discovery + extraction | Gemini 3.5 Flash | one `general-purpose` sub-agent per city, in parallel. Each writes its own `{city}.json` with `records[]`, `city_foods[]`, and `photos[]` (Wikimedia Commons only). |
| Consolidation + validation | Haiku 4.5 | reads all city files, dedupes, normalizes photos, and writes `consolidated.json` + `consolidated.summary.md`. |
| Critical review | Opus 4.7 | reads `consolidated.json`, cross-checks with general knowledge of the destination, drops any bad photo or citation, writes `approved.json` + `opus-review.md`. |
| Seed generation | Local script | converts `approved.json` into `supabase/seed_<country>_<batch>.sql` targeting `places_staging` and `city_foods_staging`. |

The Python `japan_place_extract.py` / `upsert_japan_places.py` scripts are
Japan-only legacy (superseded by `discover_and_extract_city.py`), kept for
future high-volume automation once a country's source policy is proven and
API budgets are warranted.

## Setup

Run the schema migrations in order in the Supabase SQL Editor. These are
country-agnostic — `places`/`places_staging`'s `country` column defaults to
`'JP'` but is plain text, so Scotland (and any future country) rows just set
`country='GB'` explicitly. No new migration is needed per country.

```sql
-- after schema.sql and add_places_columns.sql
-- paste/run supabase/add_japan_places_pipeline.sql
-- then (for Tokyo pilot and beyond — multi-photo + city_foods):
-- paste/run supabase/add_japan_tokyo_pipeline.sql
```

Install Python dependencies:

```bash
cd scraper
pip install -r requirements.txt
cp .env.example .env
```

Fill `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, and
optionally `PLACE_EXTRACT_MODEL` in `scraper/.env`. `places_staging` has no
anon write policy (see `supabase/lock_pipeline_tables.sql`), so the upsert
step requires the service-role key — the anon key will not work.

## Extract (legacy, Japan-only)

Create a batch JSON in the shape of `japan_place_batch.example.json`, then run:

```bash
python japan_place_extract.py japan_place_batch.example.json --output out/jp-kanto-pilot.json
```

Use `--no-fetch` when the batch already includes approved source text and you
do not want the script to fetch pages.

Validate an already extracted file without calling the LLM:

```bash
python japan_place_extract.py out/jp-kanto-pilot.json --output out/jp-kanto-pilot.validated.json --validate-only
```

## Upsert To Staging (legacy, Japan-only)

```bash
python upsert_japan_places.py out/jp-kanto-pilot.validated.json
```

Records are upserted into `places_staging` by `(batch_id, dedupe_key)`. They are
not promoted into `places` until reviewed and approved.

## Promote To `places`

`scripts/promote-japan-places.mjs` promotes approved, un-promoted
`places_staging` rows (filtered by `--country-code`, default `JP`) into
`places`, tagged with `--source` (default `seed-japan-pipeline`) and a
`destination` string suffixed by that country's label (`--destination-suffix`
to override, otherwise looked up from `staging.country`).

```bash
node --env-file=.env.local scripts/promote-japan-places.mjs
node --env-file=.env.local scripts/promote-japan-places.mjs --country-code GB --source seed-scotland-pipeline
```

## Review Gates

Before promotion, reject any record with:

- no source URL
- uncited description, hours, station, or photo metadata
- photo missing license or credit
- invented coordinates, ratings, or hours
- community/social/review text used as factual truth

Use Opus review only once a pilot batch has already passed script validation.

## Known Issue: identical lat/lng within a city (Scotland batch, 2026-07-25)

The Sonnet review pass over `scot-pilot-2026-07-25` (3504 Scotland records)
found that in several cities every place shares one identical `lat`/`lng`
value, despite each record's `field_sources` nominally citing that place's
own Wikipedia page as the coordinate source (e.g. all 16 Aberfeldy records
sit at 56.6216, -3.8644; Kirkwall has ~12 records sharing 58.981, -2.96 while
their stated addresses are actually in Stromness, Birsay, Hoy, Deerness,
Burray, or Tankerness). A single point can't be the true location of a
distillery, a village, and a loch simultaneously — this looks like an
upstream bug in whatever step back-filled lat/lng (see `enrich.py` /
`totals.fills["lat/lng"]` in `consolidated/scot-pilot-2026-07-25/_report.json`),
not a per-record extraction error. Affected cities found so far: Aberfeldy,
Blairgowrie, Crieff, Dunkeld (Perthshire); Kirkwall (Orkney); partial overlap
in Auchterarder/Perth/Pitlochry/Scone.

**Decision (user, 2026-07-25): do not block promotion on this** — records
were approved through review with their existing (possibly-wrong) lat/lng,
to be fixed in a follow-up pass re-running per-place coordinate lookup for
the affected cities rather than re-doing the whole batch now.
