## Plan: Japan Place Seed Data

Build a Japan data pipeline that uses authoritative/place APIs, official tourism sources, reputable travel/editorial sources, and licensed image providers as the source of truth, with a cheap LLM only for extraction, normalization, deduplication, source comparison, and short descriptions. Start with a Japan pilot instead of all small cities at once: one prefecture or 10-20 small/medium cities, then expand by prefecture once source quality and schema are proven.

**Recommended Option**
- Use Google Places API or a Places API-compatible provider for base POI identity, coordinates, categories, ratings, business status, opening hours, nearest transit hints, and place photo references.
- For each city, target at least 20-30 tourist-useful records, not only major tourist destinations. Include attractions, niche experiences, markets, workshops, viewpoints, parks, streets, cafes/restaurants, food halls, local shops, small museums, seasonal spots, scenic walks, temples/shrines, public baths, local craft places, and other places tourists would realistically save.
- For each place, try to collect at least 2-3 usable images from multiple sources. Prefer exact-place imagery first, then nearby/contextual city imagery only when exact-place imagery is unavailable.
- Use official place websites, local tourism board pages, JNTO/Japan Travel, Wikidata/Wikipedia, Wikimedia Commons, Wikivoyage, japan-guide, Atlas Obscura, Navitime/Japan Travel style editorial sources, and reputable local English/Japanese tourism or food guides for descriptions, tips, famous local dishes, and verification.
- Use Google Images only through compliant APIs or providers, such as Google Programmable Search / Custom Search JSON API where access exists, with image search and license filters. Do not scrape Google Images results directly. If Google image-search API access is unavailable, use Wikimedia Commons, Google Places Photos, Unsplash, Flickr Creative Commons, Bing Image Search, SerpAPI/Zenserp-style providers, or official/tourism media pages with clear licensing/terms.
- Use Unsplash for city, neighborhood, food, or atmosphere images when exact place photos are missing; do not treat Unsplash as factual proof that a specific venue exists or looks a certain way.
- Use Reddit API, travel forums, YouTube/TikTok/Instagram metadata, Google review summaries, and optionally TripAdvisor partner/content access only for summarized public sentiment, niche discovery leads, and practical tips. Do not use community/social sources as primary factual truth for hours, addresses, coordinates, or exact claims.
- Use a low-cost LLM or another cheap model to parse pages into structured JSON with citations, compare conflicting facts across sources, suggest candidate places and local foods, and mark uncertainty. Verify/fill core facts from deterministic APIs where possible.

**Options**
1. API-first enrichment: Google Places + Wikimedia/Wikidata + Google Places Photos + transit lookup. Cheapest to build inside the current app shape, gives structured identity/location/hours/rating/photo metadata, but Google photo reuse, caching restrictions, attributions, and costs must be handled carefully.
2. Trusted crawler pipeline: source-specific scrapers/parsers for official tourism websites, official venue pages, JNTO/local tourism boards, Atlas Obscura, japan-guide, Japan Travel, Wikivoyage, Navitime, Tabelog/Gurunavi-style food pages where permitted. Best trust and richer tips, but slower to build and requires robots.txt/ToS checks.
3. Licensed image enrichment: per place, try Google Places Photos, Wikimedia Commons/Wikidata image claims, official tourism media, Flickr Creative Commons, Unsplash, and API-based Google/Bing image search with rights filters. Store 2-3 candidate images with source URL, credit, license/terms, dimensions, source type, and review status.
4. LLM-assisted research pipeline: search web, fetch pages, extract facts with low-cost LLM, require citations per field, reject uncited facts, and mark confidence. Cheapest model cost, but needs validation rules to avoid hallucinated hours, stations, famous foods, or niche experiences.
5. Community/niche discovery layer: Reddit API, travel forums, TikTok/Instagram/YouTube metadata, Google review themes, and local blogs can surface unusual experiences and foods. Use them as leads, then confirm with Google Places, official sites, tourism boards, or reputable editorial pages.
6. Curated manual seed first: hand-curate one Japan pilot set using source templates, then automate from that pattern. Highest quality for MVP, smallest blast radius.

**Research Notes To Bake Into The Pipeline**
- Google Places Details can return `currentOpeningHours`, `regularOpeningHours`, `businessStatus`, `rating`, `priceLevel`, `websiteUri`, `transitStation`, and photo metadata when requested in the field mask. Keep field masks narrow to control billing.
- Google Places Photos can return up to 10 photos for a place from the Places database, but photo names can expire and should not be cached. Store the place photo metadata/attribution and refresh the photo URI when rendering or promoting, depending on product needs and Google terms.
- Google Places photo entries may include `authorAttributions`; display/store required attribution anywhere the image is shown.
- Google Programmable Search / Custom Search JSON API supports image search via `searchType=image`, license filters via `rights`, SafeSearch, image size/type filters, and language/country biasing. The API is closed to new customers, so use it only if access already exists; otherwise use another compliant image/search provider.
- Unsplash API supports keyword photo search, dynamic image URLs, attribution requirements, hotlinking requirements, and rate limits. It is best for destination ambience or broad city/food images, not exact venue verification.
- Wikimedia Commons files are generally reusable under public-domain or open licenses, but each file needs license, author, source URL, and attribution checked. Wikimedia/Wikidata are strong sources for exact-place photos when a place has a Commons category or Wikidata image property.
- Japan-guide, Wikivoyage, JNTO/Japan Travel, local tourism boards, official city/prefecture pages, and local food guides can help identify regional dishes, local specialties, festivals, workshops, scenic routes, and niche places beyond standard attraction lists.

**Steps**
1. Define scope for v1: Japan country record, prefectures/cities, and a pilot city list. Recommended pilot: 10-20 places across 3-5 smaller cities for the first validation batch, then raise the production target to 20-30 places per city once source quality is proven.
2. Define tourist-useful place categories beyond classic attractions: attraction, experience, food, cafe, market, shopping street, scenic walk, viewpoint, shrine/temple, museum/gallery, craft/workshop, bath/onsen/sento, nightlife, seasonal/event, nature/park, hidden/niche, and local specialty stop.
3. Extend the data model conceptually beyond the current `places` table: add city/prefecture/country structure, source provenance per field, multiple photo records, photo licensing/credit, external IDs, nearest station, snack/local specialty, city famous food/dish links, tip categories, confidence score, and last-verified timestamp.
4. Add city-level food metadata: for every city, find at least one famous cuisine, dish, snack, ingredient, drink, sweet, market food, or local specialty. Store dish name, short explanation, source URLs, confidence, and linked places where a traveler can try it.
5. Build a source priority policy: official venue/local tourism page first; Google Places or equivalent for identity, coordinates, hours, ratings, and business status; Wikimedia/official media/Google Places Photos for exact reusable or API-compliant photos; Unsplash/Flickr/API image search for fallback or atmosphere; community/review sources only for sentiment, discovery, and optional tips.
6. Design ingestion stages: discover candidate places by city/category/source query, dedupe by Google place ID/name/address/coordinates/Wikidata ID, fetch/enrich trusted pages, run LLM extraction into JSON, validate required fields, store raw source URLs and normalized records in staging.
7. Add an image enrichment stage: for each accepted place, gather 2-3 image candidates from multiple providers when available. Prefer exact place images over generic city images; record source type, source URL, image URL or provider reference, credit, license/terms, dimensions, whether attribution is required, and whether the image is exact-place or contextual.
8. Add an hours reconciliation stage: request Google Places `regularOpeningHours`, `currentOpeningHours`, and `businessStatus`; compare against official venue/tourism pages where available; keep both source timestamps; mark conflicts for review; mark hours as unknown/stale rather than guessing.
9. Add food/local specialty discovery: search official city/prefecture tourism pages, JNTO/Japan Travel, japan-guide, Wikivoyage, local food guides, and reputable blogs for famous dishes. Use community/social sources only to find leads or current popularity, then confirm with a reliable source when possible.
10. Add quality gates: reject records without coordinates, source URL, and description; reject images without source/credit/license or provider terms; require at least one exact or contextual image and prefer 2-3 before promotion; mark missing hours as unknown; flag stale/conflicting hours for refresh; keep source-specific confidence.
11. Prepare seed output for Roameo: generate Supabase SQL or JSON import matching the app schema, then upsert into `places`, `place_photos`, `place_sources`, `places_staging`, and any new supporting city-food tables.
12. Add admin/review workflow before bulk import: sample records, compare source citations, approve/reject, choose the best hero image, verify 2-3 image candidates, resolve hour conflicts, approve famous-food claims, and log rejected reasons.
13. Expand by prefecture after the pilot: automate city queues, rate limits, retries, source freshness checks, image refresh rules, food metadata checks, and periodic revalidation.

**Relevant Files**
- `/Users/jasbirsingh/Documents/personal/Roameo/supabase/schema.sql` -- current shared `places`, `social_posts`, trip and itinerary schema; likely needs new normalized Japan/city/place metadata tables or columns.
- `/Users/jasbirsingh/Documents/personal/Roameo/supabase/add_places_columns.sql` -- existing precedent for extending `places` with Google place ID, coordinates, destination, source, and fetched timestamp.
- `/Users/jasbirsingh/Documents/personal/Roameo/supabase/add_japan_places_pipeline.sql` -- current staging/provenance migration with `place_photos`, `place_sources`, and `places_staging`; extend this for multiple photos and city food metadata rather than creating a separate path.
- `/Users/jasbirsingh/Documents/personal/Roameo/supabase/seed.sql` -- current seed pattern for static place/social data; use as first import target or replace with generated seed files.
- `/Users/jasbirsingh/Documents/personal/Roameo/app/api/places/route.ts` -- existing live pattern: destination geocode, Google Places fetch, map to local schema, upsert, fallback.
- `/Users/jasbirsingh/Documents/personal/Roameo/lib/places/google.ts` -- current Google Places wrapper and field-mask pattern; reuse for identity/location/hours/photo reference fetching.
- `/Users/jasbirsingh/Documents/personal/Roameo/lib/db/places.ts` -- DB read/query layer for places; update once the schema stores richer Japan-specific metadata and multiple photos.
- `/Users/jasbirsingh/Documents/personal/Roameo/scraper/JAPAN_PLACES_PIPELINE.md` -- existing staging pipeline documentation; update with image enrichment, 20-30 places per city, and food metadata rules.
- `/Users/jasbirsingh/Documents/personal/Roameo/scraper/japan_place_batch.example.json` -- current batch shape; extend with desired city targets, category mix, image sources, and food discovery fields.
- `/Users/jasbirsingh/Documents/personal/Roameo/scraper/japan_place_extract.py` -- current LLM extraction/validation script; update output schema to handle multiple photos and city food/local specialty citations.
- `/Users/jasbirsingh/Documents/personal/Roameo/scraper/upsert_japan_places.py` -- staging upsert path; update to insert photo arrays and any city-food staging records.
- `/Users/jasbirsingh/Documents/personal/Roameo/scraper/upsert_supabase.py` -- existing offline ingestion pattern using Supabase REST upsert.
- `/Users/jasbirsingh/Documents/personal/Roameo/scraper/scrape_instagram.py` and `/Users/jasbirsingh/Documents/personal/Roameo/scraper/scrape_tiktok.py` -- existing social scraping approach; keep separate from trusted factual ingestion and use only for optional niche/trend leads.

**Verification**
1. For a pilot city, inspect 20-30 generated place records and confirm every factual field has a source URL and timestamp.
2. Confirm each promoted place has at least 2-3 image candidates where available, or a documented reason if fewer are available.
3. Confirm every image has source URL/provider reference, credit/attribution, license or provider terms, dimensions when available, and exact-place/contextual classification.
4. Compare hours for 10 random places against Google Places and official venue/tourism pages; verify conflicts are flagged instead of silently overwritten.
5. Confirm each city has at least one cited famous cuisine/dish/snack/local specialty and at least one linked place or area where it can be tried.
6. Check database constraints/deduplication by importing the same city twice and confirming no duplicate places or duplicate photo rows.
7. Run `npm run lint` after app/API changes.
8. Run `npm run build` after schema-dependent UI/API changes.
9. Query Supabase counts by city/source/confidence/photo_count/hours_status and spot-check missing hours/photos/transit fields.
10. Manually compare 5 random records against official source pages, Google Maps, and image source pages before expanding.

**Decisions**
- Low-cost LLM should not be used as the factual source; it should extract, compare, summarize, and normalize trusted sources into structured data.
- Tourist-useful places are broader than tourist destinations. Include attractions, experiences, local food stops, neighborhoods, markets, workshops, and niche places that a visitor might save or plan around.
- Every production city should aim for 20-30 places, but the first pilot can start smaller to validate schema, source policy, and review workflow.
- Each place should aim for 2-3 images. Exact-place images are preferred; contextual city/area/food images are acceptable fallback only when clearly labeled.
- Unsplash is acceptable for generic city, neighborhood, or cuisine imagery, but not ideal for exact place photos. Prefer Wikimedia Commons, official tourism/venue media, Google Places photos where API terms allow, Flickr Creative Commons, or licensed providers for exact place imagery.
- Google Images should be used via compliant APIs/providers with license filters and stored provenance, not direct scraping.
- Opening and closing timings can come from Google Places, official venue pages, tourism pages, and reputable listings. When sources conflict, keep the most authoritative source, preserve the conflict, and mark the field for review.
- Scraping TripAdvisor/Reddit/social platforms directly is risky; prefer official APIs/partner programs or store only links/aggregated sentiment where permitted.
- For all-Japan coverage, batch by prefecture/city and keep records refreshable, because hours/reviews/stations/images change.

**Further Considerations**
1. Source strictness: recommended default is high-trust mode for launch, allowing only official/tourism/Wikidata/Wikimedia/Google-derived facts and using community sources for optional tips, niche discovery, or current sentiment.
2. Scope: recommended default is a pilot prefecture or city cluster first, then expand by prefecture.
3. Photo policy: recommended default is licensed/reusable or API-compliant photos with credit metadata, avoiding scraped images with unclear reuse rights.
4. City food coverage: recommended default is one cited dish/local specialty per city minimum, with optional expansion to 3-5 dishes for food-heavy cities like Osaka, Fukuoka, Hiroshima, Sapporo, Kanazawa, Nagoya, and Kyoto.
5. Search strategy: use Japanese and English queries, including city name + `official tourism`, `local specialty`, `famous food`, `things to do`, `hidden gems`, `experience`, `workshop`, and the Japanese equivalents where practical.