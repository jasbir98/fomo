# Happenings research pipeline

Researches Edinburgh (or another configured city's) "happenings" — time-limited
money/access opportunities — via Claude + the Anthropic API's server-side
`web_search` tool, and gets them into the app's `happenings` table with a
provenance trail and a working staleness/retirement story.

Why this exists: the app (Fomo) exists because its own user missed National
Cinema Weekend — a real, UK-wide, £4-cinema-ticket weekend — simply because
nobody surfaced it to them in time. This pipeline's whole design is shaped
around not repeating that failure in either direction: missing a real
happening is bad, but inventing a fake one (a hallucinated date, a
guessed promo code) is worse, because it actively misleads someone standing
at a till.

## Pieces

- `scraper/happenings/base.py` — `CityHappeningsConfig`, the per-city config
  contract (source domains, known named fixtures, prompt guidance).
- `scraper/happenings/cities/edinburgh.py` — Edinburgh's config. Add a new
  city by copying this file and registering it in `cities/__init__.py`.
- `scraper/happenings_research.py` — the research script itself, three modes
  (`calendar` / `offers` / `verify`), writes
  `scraper/out/<batch-id>/<city>-happenings-<mode>.json`.
- `scraper/upsert_happenings.py` — pushes a research script's output JSON
  into `happenings_staging` (Supabase REST, upsert on `(batch_id, slug)`).
- `scripts/promote-happenings.mjs` — promotes approved `happenings_staging`
  rows into `happenings` + `happening_sources`.
- `scripts/sweep-happenings.mjs` — the trust mechanism: auto-retires expired
  one-offs, and emits a re-verification worklist for `--mode verify`.

## Why three research modes, not one

`calendar` and `offers` research fundamentally different kinds of things
with different catastrophic failure modes (a hallucinated date vs. a
hallucinated promo code), so they get different prompts, different search
budgets, and different target counts. `verify` exists from day one, not
bolted on later: without a way to re-check old rows, "checked 3 days ago"
silently rots into "checked 4 months ago" and the "still current" badge the
whole app leans on becomes a lie nobody notices — until a user does.

## End-to-end workflow

All commands assume you're at the repo root, with `scraper/.env` populated
(`ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — see
`scraper/.env.example`) and `.env.local` populated for the two `.mjs`
scripts (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
`happenings_staging` has no anon write policy (see
`supabase/archive/lock_pipeline_tables.sql`), so both the Python upsert step and the
`.mjs` promote step require the service-role key — the anon key will not
work for either. (If `SUPABASE_SERVICE_ROLE_KEY` is already set in the
repo-root `.env.local`, the Python scripts will pick it up from there too —
no need to duplicate it into `scraper/.env`.)

```bash
BATCH=edi-happenings-2026-09-12

# 1. Research dated one-offs + annual fixtures (~40 rows, walks known_fixtures by name).
python3 scraper/happenings_research.py --mode calendar --batch-id "$BATCH"

# 2. Research rolling venue deals / standing discounts (~30 rows, recurrence-first).
python3 scraper/happenings_research.py --mode offers --batch-id "$BATCH"

# 3. Push both outputs into happenings_staging.
python3 scraper/upsert_happenings.py "scraper/out/$BATCH/edinburgh-happenings-calendar.json"
python3 scraper/upsert_happenings.py "scraper/out/$BATCH/edinburgh-happenings-offers.json"

# 4. Human review: approve rows in happenings_staging (approved=true) via
#    Supabase Studio / a review script — this pipeline never auto-approves.

# 5. Promote approved rows into happenings + happening_sources.
node --env-file=.env.local scripts/promote-happenings.mjs --batch-id "$BATCH"

# --- ongoing, e.g. as a daily/weekly cron ---

# 6. Auto-retire one-offs whose date has passed (dry-run first, always).
node --env-file=.env.local scripts/sweep-happenings.mjs
node --env-file=.env.local scripts/sweep-happenings.mjs --apply

# 7. Find rows overdue for re-verification and re-check them against source.
node --env-file=.env.local scripts/sweep-happenings.mjs --emit-worklist \
  | python3 scraper/happenings_research.py --mode verify --batch-id "$BATCH-verify"

# 8. Push verification results back in (still_live/changes land in
#    happenings_staging for now — wire a human-facing review step or a
#    direct happenings.last_verified_at/status PATCH before relying on this
#    in production).
python3 scraper/upsert_happenings.py "scraper/out/$BATCH-verify/edinburgh-happenings-verify.json"
```

## Adding a new city

1. Create `scraper/happenings/cities/<slug>.py` with a `CityHappeningsConfig`
   (see `edinburgh.py`). `known_fixtures` matters most — named search targets
   massively outperform an open-ended "find events in `<city>`" query.
2. Register it in `scraper/happenings/cities/__init__.py`'s `CITIES` dict.
3. Run with `--city <slug>`.

## Static checks (no network, no Supabase, no key required)

```bash
python3 -m py_compile scraper/happenings/base.py scraper/happenings/__init__.py \
  scraper/happenings/cities/__init__.py scraper/happenings/cities/edinburgh.py \
  scraper/happenings_research.py scraper/upsert_happenings.py
node --check scripts/promote-happenings.mjs
node --check scripts/sweep-happenings.mjs

python3 scraper/happenings_research.py --help
node scripts/promote-happenings.mjs --help
node scripts/sweep-happenings.mjs --help

# Dry-run: builds prompts/config, makes no API calls, writes nothing.
python3 scraper/happenings_research.py --mode calendar --batch-id smoketest --dry-run
python3 scraper/happenings_research.py --mode offers --batch-id smoketest --dry-run
echo '[]' | python3 scraper/happenings_research.py --mode verify --batch-id smoketest --dry-run
```
