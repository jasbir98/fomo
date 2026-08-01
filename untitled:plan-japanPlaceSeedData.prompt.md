## Plan: Japan Place Seed Data

Build a Japan data pipeline that uses authoritative/place APIs and official tourism sources as the source of truth, with a cheap LLM only for extraction, normalization, deduplication, and short descriptions. Start with a Japan pilot instead of all small cities at once: one prefecture or 10-20 small/medium cities, then expand by prefecture once source quality and schema are proven.

**Recommended Option**
- Use Google Places API or Places API-compatible provider for base POI identity, coordinates, categories, ratings, opening hours, and nearest transit hints.
- Use official place websites, local tourism board pages, JNTO/Japan Travel, Wikidata/Wikipedia, Wikimedia Commons, and Atlas Obscura/japan-guide style editorial sources for descriptions, tips, photos, and verification.
- Use Reddit API and optionally TripAdvisor partner/content access only for summarized public sentiment, not as primary factual truth.
- Use Low cost LLM or another cheap model to parse pages into structured JSON with citations, then verify/fill core facts from deterministic APIs where possible.

**Options**
1. API-first enrichment: Google Places + Wikimedia/Wikidata + transit lookup. Cheapest to build inside the current app shape, gives structured location/hours/rating/photo metadata, but Google photo reuse and costs must be handled carefully.
2. Trusted crawler pipeline: source-specific scrapers/parsers for official tourism websites, official venue pages, JNTO/local tourism boards, Atlas Obscura, japan-guide, Japan Travel/Navitime where permitted. Best trust and richer tips, but slower to build and requires robots.txt/ToS checks.
3. LLM-assisted research pipeline: search web, fetch pages, extract facts with Low cost LLM, require citations per field, reject uncited facts, and mark confidence. Cheapest model cost, but needs validation rules to avoid hallucinated hours/stations.
4. Community sentiment layer: Reddit API, TripAdvisor Content API/partner access, Google reviews aggregate, maybe YouTube/TikTok metadata. Useful for tourist tips and local snack/review snippets; not reliable for hours or exact location.
5. Curated manual seed first: hand-curate one Japan pilot set using source templates, then automate from that pattern. Highest quality for MVP, smallest blast radius.

**Steps**
1. Define scope for v1: Japan country record, prefectures/cities, and a pilot city list. Recommended pilot: 10-20 places across 3-5 smaller cities rather than every municipality.
2. Extend the data model conceptually beyond the current `places` table: add city/prefecture/country structure, source provenance per field, photo licensing/credit, external IDs, nearest station, snack/local specialty, tip categories, confidence score, and last-verified timestamp.
3. Build a source priority policy: official venue/local tourism page first; Google Places or equivalent for identity, coordinates, hours, ratings; Wikimedia/official media for reusable photos; community/review sources only for sentiment/tips.
4. Design ingestion stages: discover candidate places by city/category, dedupe by Google place ID/name/address/coordinates, fetch/enrich trusted pages, run LLM extraction into JSON, validate required fields, store raw source URLs and normalized records.
5. Add quality gates: reject records without coordinates, source URL, and description; mark hours as unknown instead of guessed; require photo license/credit; flag stale hours for refresh; keep source-specific confidence.
6. Prepare seed output for Roameo: generate Supabase SQL or JSON import matching the app schema, then upsert into `places` and any new supporting tables.
7. Add admin/review workflow before bulk import: sample records, compare source citations, approve/reject, and log rejected reasons.
8. Expand by prefecture after the pilot: automate city queues, rate limits, retries, source freshness checks, and periodic revalidation.

**Relevant files**
- `/Users/jasbirsingh/Documents/personal/Roameo/supabase/schema.sql` — current shared `places`, `social_posts`, trip and itinerary schema; likely needs new normalized Japan/city/place metadata tables or columns.
- `/Users/jasbirsingh/Documents/personal/Roameo/supabase/add_places_columns.sql` — existing precedent for extending `places` with Google place ID, coordinates, destination, source, and fetched timestamp.
- `/Users/jasbirsingh/Documents/personal/Roameo/supabase/seed.sql` — current seed pattern for static place/social data; use as first import target or replace with generated seed files.
- `/Users/jasbirsingh/Documents/personal/Roameo/app/api/places/route.ts` — existing live pattern: destination geocode, Google Places fetch, map to local schema, upsert, fallback.
- `/Users/jasbirsingh/Documents/personal/Roameo/lib/places/google.ts` — current Google Places wrapper and field-mask pattern; reuse for identity/location/hours/photo reference fetching.
- `/Users/jasbirsingh/Documents/personal/Roameo/lib/db/places.ts` — DB read/query layer for places; update once the schema stores richer Japan-specific metadata.
- `/Users/jasbirsingh/Documents/personal/Roameo/scraper/upsert_supabase.py` — existing offline ingestion pattern using Supabase REST upsert.
- `/Users/jasbirsingh/Documents/personal/Roameo/scraper/scrape_instagram.py` and `/Users/jasbirsingh/Documents/personal/Roameo/scraper/scrape_tiktok.py` — existing social scraping approach; keep separate from trusted factual ingestion.

**Verification**
1. For a pilot city, inspect 20 generated place records and confirm every factual field has a source URL and timestamp.
2. Check database constraints/deduplication by importing the same city twice and confirming no duplicate places.
3. Run `npm run lint` after app/API changes.
4. Run `npm run build` after schema-dependent UI/API changes.
5. Query Supabase counts by city/source/confidence and spot-check missing hours/photos/transit fields.
6. Manually compare 5 random records against official source pages and Google Maps before expanding.

**Decisions**
- Low cost LLM should not be used as the factual source; it should extract and summarize trusted sources into structured data.
- Unsplash is acceptable for generic city imagery, but not ideal for exact place photos. Prefer Wikimedia Commons, official tourism/venue media, Google Places photos where license/API terms allow, or licensed providers.
- Scraping TripAdvisor/Reddit directly is risky; prefer official APIs/partner programs or store only links/aggregated sentiment where permitted.
- For all-Japan coverage, batch by prefecture/city and keep records refreshable, because hours/reviews/stations change.

**Further Considerations**
1. Source strictness: recommended default is high-trust mode for launch, allowing only official/tourism/Wikidata/Google-derived facts and using community sources for optional tips.
2. Scope: recommended default is a pilot prefecture or city cluster first, then expand by prefecture.
3. Photo policy: recommended default is licensed/reusable photos with credit metadata, avoiding scraped images with unclear reuse rights.
