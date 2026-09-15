# Plan — better Edinburgh data collection (deals, events, iconic stuff)

Status: **decisions made 2026-09-15** (see §8). Next: Phase 1. Written 2026-09-15.
Constraint: **no paid data sources** (no Data Thistle, no Apify). AI budget stays ≤ $3/run.

## 0. Where we are (measured 2026-09-15)

| Signal | Value | What it means |
|---|---|---|
| Live `happenings` | **117** (57 dormant) | Far too thin for "everything happening in Edinburgh" |
| Live by kind | event 54 · deal 36 · activity 9 · festival 7 · free_access 6 · tour 5 | Deals are the weakest section and the core promise |
| `events` table (Skiddle + Ticketmaster cache) | 267 | Separate from `happenings`; merged only at display time |
| Direct-source records in last weekly run | **0 of 20 sources** | Every configured publisher page is JS-rendered or blocks us |
| Research → verified | 117 → 7 (first run) | Web-search-then-verify loses most of what it finds |
| Distinct `source_name` spellings for Forever Edinburgh | 4 | No source registry; names are free text from the LLM |
| Live rows sharing a `source_url` | 51 | Several items per page, fine, but nothing tracks which page produced what |

### Why the weekly script can't "skip what we have"

1. **No memory across runs.** `merge_records` only dedupes candidates *within* one run
   (`scraper/weekly_edinburgh.py:559`). Nothing reads `happenings` before researching.
2. **Unstable identity.** Slug = LLM slug or `slugify(scope-title)`
   (`scraper/happenings_research.py:986`). The LLM paraphrases titles, so the same thing gets a
   new slug each week, and `on_conflict=slug` in `promote-happenings.mjs` inserts a duplicate.
3. **Staging key is `(batch_id, slug)`.** Every week restages everything as new rows.
4. **The LLM isn't told what we already have**, so it spends the budget rediscovering Hearts
   fixtures and Resident Rewards instead of finding new things.
5. **Web search is the main discovery channel.** It's the most expensive and least verifiable
   channel. Structured feeds and page-grounded extraction should come first, with search
   only filling gaps.

## 1. Target architecture

```
                 ┌──────────── source registry (scraper/sources/*.yaml) ───────────┐
                 │ id · name · tier · adapter · url · cadence · trust · kind hints │
                 └──────────────────────────────┬──────────────────────────────────┘
   Tier 1 structured (no AI)     Tier 2 page-grounded AI     Tier 3 social        Tier 4 search (gaps)
   APIs, JSON-LD, iCal, RSS      fetch page → extract          IG / FB posts        existing DeepSeek topics
             │                          │                          │                      │
             └──────────────┬───────────┴──────────────┬───────────┴──────────────────────┘
                            ▼                          ▼
                 source_items ledger  ──(unchanged hash? skip, $0)──┐
                            ▼                                        │
                 normalise → identity match vs live+staging+dormant+events
                            ▼                     ▼
                     NEW → staging          KNOWN → refresh last_seen / add source_url / diff facts
                            ▼
                 verify (tier-dependent) → auto-publish or review → report + per-source metrics
```

**Rules for this design:**
- **Tier 1** records are trusted as publisher data and skip text verification. This is the
  same treatment JSON-LD gets today.
- **Tier 2** extraction runs on text we already fetched. Every extracted fact carries the
  **evidence snippet** it came from. Verification becomes "is the snippet in the page": always
  checkable, and no second fetch.
- **Tier 3** (social + newsletters) **always goes to review**, never auto-published (decision
  2026-09-15). If the post links to a page that passes a Tier 1 or Tier 2 check, the review row
  is marked "pre-checked" so approving it is one click.
- **Tier 4** is only for gaps. Each topic gets a "known items" list it must not return.

## 2. Skip-what-we-have: identity + ledger (build this first)

### 2a. `source_items` ledger (new table)

| column | purpose |
|---|---|
| `source_id` | registry id (e.g. `luma-edinburgh`) |
| `external_id` | provider id, JSON-LD `url`/`@id`, IG shortcode, RSS guid, or canonical URL |
| `content_hash` | sha256 of normalised payload (title+dates+price+text snippet) |
| `first_seen_at`, `last_seen_at`, `last_changed_at` | freshness |
| `happening_id` / `staging_id` | what it became (nullable = rejected/ignored) |
| `disposition` | `new` · `matched` · `rejected_low_value` · `rejected_out_of_area` · `review` |

Unique on `(source_id, external_id)`. Each run:
- **Same hash as last time** → bump `last_seen_at` and stop. No LLM spend, no restage.
- **Hash changed** → re-extract that item only and diff it against the linked happening
  (price changed, date moved, sold out).
- **Not seen for N runs while its source was read successfully** → signal to mark dormant.
  Today only dates and 404s retire rows.

### 2b. Canonical identity + stable slugs
- `identity_key` = `place_id` (or normalised venue) + local start date + sorted significant
  title tokens. For deals: venue/brand + offer type + saving figure.
- Match against **live + dormant + staging + `events`**. Rule: same date, same
  venue/place, title-token Jaccard ≥ 0.5. Deals: same brand plus same saving figure.
  Borderline scores go to review as "possible duplicate of X". They are never auto-merged.
- **Slug derives from the identity key, never from the LLM.** Add `happenings.identity_key`
  (unique, partial on non-null) and promote on it. Keep `slug` for URLs only.
- **Canonical `source_name` comes from the registry.** This fixes the 4 Forever Edinburgh
  spellings. One-off SQL backfill for existing rows.
- **Cross-table dedupe with `events`.** Ticketmaster rows currently exist in both tables
  (13 + 4 live `happenings` sourced "Ticketmaster"). Research topics must not re-add what
  Skiddle/TM already supply.

### 2c. Tell the search agents what we have
Before each Tier 4 topic, inject a compact list, capped at ~60 lines:
`title | date | venue`, for live+staging rows in that topic's category.
Instruction: *"Return only items not on this list. If an item on the list has changed (price,
date, sold out), return it with `updates_slug`."*
Cheap on tokens, and aimed straight at the rediscovery waste.

## 3. Source catalogue

Status key: ✅ probed live 2026-09-15 with the pipeline UA · ⚠️ exists but access or terms
need a decision · ❌ blocked (don't bypass) · 🔍 not yet probed.

### 3a. Events — Tier 1 (structured, no AI)

| Source | Access | Status | Why it matters |
|---|---|---|---|
| **Edinburgh Festivals Listings API** (`api.edinburghfestivalcity.com`) | Free registration, REST + spreadsheet + MCP (beta) | ⚠️ register | Official data for all 11 festivals: Fringe, EIF, Book, Film, Jazz & Blues, Science, Storytelling, Children's, Art, Hogmanay, Tattoo. Includes a **pay-what-you-can price type** and accessibility flags. Terms: commercial use OK; must say "not an official festival app"; show attribution; refresh ≥ every 24h; delete on termination. Replaces 6 of today's search topics. |
| **Skiddle** | API key | ✅ in use (`events`) | Club/gig coverage |
| **Ticketmaster Discovery** | API key | ✅ in use (`events`) | Arena/major shows, on-sale dates |
| **Luma** `lu.ma/edinburgh` | JSON-LD, 20 events | ✅ | Tech/community/free meetups; nothing else covers these |
| **allevents.in** `/edinburgh/all` | JSON-LD, 43 events | ✅ | Aggregator; freshers, club nights, pub crawls (noisy, so Tier 1 + low trust) |
| **Eventbrite discover pages** (`/d/united-kingdom--edinburgh/free--events/`, plus category pages) | JSON-LD, 20/page | ✅ | Public discover pages carry JSON-LD even though the search API is dead. Free lectures, library, university, community. Read-only, low volume, obey robots. |
| **Songkick** `metro-areas/24551-uk-edinburgh` | JSON-LD, 50/page | ✅ (correct ID is **24551**; 24542 is Birmingham) | Gigs incl. small venues TM/Skiddle miss |
| ~~Data Thistle API~~ (ex-The List) | Paid, from £50/mo | ❌ rejected (cost) | Coverage comes from the free sources in this table + Tier 2 venue pages instead |
| Venue iCal/RSS feeds: Traverse, Sneaky Pete's, La Belle Angele, Stramash, Monkey Barrel | `rss-link` found on page | ✅ link present, feed content 🔍 | Small venues, often cheap/free nights |
| City of Edinburgh Council events RSS | RSS (1 item) | ✅ but thin | Keep, low yield |

### 3b. Events — Tier 2 (fetch page → page-grounded extraction)
JS-rendered or no JSON-LD. Fetch rendered HTML with Playwright (plain page load; no stealth,
no challenge solving), or read embedded `__NEXT_DATA__` where present.

- **Venues:** Usher Hall/Culture Edinburgh, Capital Theatres (Festival/King's), Edinburgh
  Playhouse (ATG), Queen's Hall, Leith Theatre, Summerhall, Assembly Roxy, Traverse, The Stand,
  Monkey Barrel, Hidden Door, Out of the Blue Drill Hall, Dynamic Earth, RBGE, NMS, National
  Galleries, Edinburgh Zoo, Filmhouse, Cameo, Dominion, Scotsman Picturehouse.
- **Institutions:** University of Edinburgh events (`ed.ac.uk/events`, 200 OK), EUSA (URL 404,
  find current), Edinburgh Science Festival, Edinburgh Libraries, Royal Society of Edinburgh
  (free lectures).
- **Listings editorial:** The Skinny `/whats-on/edinburgh` (200, no JSON-LD), VisitScotland
  events (200, no JSON-LD), Edinburgh Festival City.
- **DICE** (`__NEXT_DATA__`; browse URL 404 → find current city slug), **Fever**
  (Candlelight etc., 2 MB page), **DesignMyNight** what's on.

### 3c. Deals & offers (the weakest section)

| Source | Tier | Status | Notes |
|---|---|---|---|
| **itison** Edinburgh | 2 | ✅ 200 | *The* Scottish deals site: restaurant/spa/experience vouchers |
| **Groupon / Wowcher** Edinburgh | 1 via `__NEXT_DATA__` | ✅ 200 | Structured JSON in page; filter to Edinburgh-redeemable, local-only |
| Forever Edinburgh Resident Rewards | 2 | ✅ in use | Keep |
| Student Beans / UNiDAYS / Young Scot (under-26) | 2 | 🔍 | Already topics; convert to page-grounded |
| **Operator loyalty offers**: O2 Priority, Three+, Vodafone VeryMe, Tesco Clubcard partners, National Lottery Open Week, Art Fund | 2 | 🔍 | Recurring national offers redeemable at Edinburgh venues (e.g. Lottery Open Week free entry) |
| **Annual price-promo days**: National Cinema Weekend/Day (UK Cinema Association), Doors Open Days (Sept, free), Museums at Night, Kids Eat Free lists | calendar + Tier 2 on announcement page | 🔍 | The exact miss that started Fomo. Keep a hand-maintained **annual calendar file** so each gets checked in the weeks before it usually lands. |
| 5pm.co.uk | — | ❌ 403 | Don't bypass; replace with itison + venue IG |
| Too Good To Go | — | ❌ 429 | Skip |
| DesignMyNight offers, Edinburgh restaurant/bar Instagram | 3 | see §4 | Happy hours and bottomless deals are mostly announced on IG |

### 3d. "Iconic / talked-about" (reading "infamous" as the things locals rave about)

- **Secret Edinburgh** (RSS connection failed from here, retry), **Edinburgh Live** what's-on,
  **Edinburgh Evening News**, **Edinburgh Reporter** (✅ RSS, 10 items). Tier 2 extraction on
  article text. "10 free things this weekend" articles are high-density.
- **Reddit r/Edinburgh**: public JSON is ❌ 403; use the official Reddit API (free OAuth
  script app). Weekly "what's on" threads plus mentions ranked by upvotes = an "iconic" signal.
- **Existing TikTok/IG reels pipeline** as a popularity signal: places and events that show up
  in many reels get a `buzz_score` feeding the Top pick hero.
- ❌ **Resident Advisor**: 403 to our UA. Skip unless we take a partner route.

## 4. Facebook & Instagram (where venues actually announce things)

There is no free, compliant way to read *all* public FB/IG. Realistic options, in order:

1. **Curated handle list.** `scraper/sources/social_handles.yaml` holds ~80–150 accounts:
   venues, bars, food spots, deal aggregators (`@itison`, `@secretedinburgh`,
   `@edinburghfoodies`-type accounts), festivals, student unions. Tag each handle with its
   `place_id` so posts link to venues automatically. **Every option below needs this list;
   build it first.**
2. **Instagram Graph API — Business Discovery** (official). With our own IG
   Business/Creator account + FB Page + Meta app, read recent media (caption, permalink,
   timestamp, media_url) of *other Business/Creator accounts* by username. Needs
   `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`. Personal accounts and
   age-gated accounts are invisible. Open question: whether app-admin standard access is
   enough without App Review. **Spike 1 hour before committing.** Rate limit ~200 calls/hr
   per user, enough for ~150 handles weekly.
3. ~~Apify actors~~: **rejected (cost)**, 2026-09-15.
4. **Existing Playwright scraper** (`scraper/scrape_instagram.py`, the user's own session): extend
   from hashtags to profile grids. Free, but manual and fragile. Only for handles Business
   Discovery can't see (personal accounts), run ad hoc by the user.
   - **Facebook without Apify:** there is no free API route to Page events. The Graph API's
     `/{page}/events` only works for pages you manage. So FB is covered **indirectly**: venues
     cross-post the same thing to IG (option 2), their newsletter (option 5), their website
     (Tier 2), or Eventbrite/Luma/Skiddle (Tier 1). Optional later: a manual, low-volume
     Playwright read of ~20 curated FB Pages' public Events tabs in the user's own session,
     review-only. Same ToS caveat as the IG scraper. Only worth building if the golden-set
     report (§6) shows FB-only items being missed.
5. **Newsletters**, the underrated channel. A dedicated Gmail inbox subscribed to ~30
   Edinburgh newsletters (Secret Edinburgh, The List, itison, Forever Edinburgh, venues,
   festivals, Student Beans). A weekly Gmail API read → Tier 2 extraction. Announcements often
   land here before the website updates. Compliant, cheap, high signal.

**Post → happening pipeline** (shared by options 2–5):
1. Ledger check on shortcode/message-id; already seen means skip.
2. Cheap classifier on caption: `event | deal | announcement | irrelevant`. Most posts are
   irrelevant, so this is where cost is saved.
3. Extraction from caption + OCR of the image. Many deals are text-in-image; DeepSeek has no
   vision, so OCR runs locally with **Tesseract** (free).
4. Identity match (§2b).
5. Link-out check: caption link or bio link → Tier 2 verify, which marks the row "pre-checked".
   **Every social/newsletter item then goes to review**, labelled "Announced on Instagram by
   @handle" (or "via <newsletter>"), with the permalink/email as source.

## 5. New weekly run (replaces the current flow)

1. **Lifecycle sweep** (unchanged) + retire rows whose ledger items vanished from a successfully read source.
2. **Tier 1 adapters** in parallel → ledger → identity match. $0 AI.
3. **Tier 2 fetch** → ledger hash check → extract **only changed pages/articles**. Budget ~$0.50.
4. **Tier 3 social + newsletters** → classify → extract (local OCR) → match → review only. Budget ~$0.75 AI.
5. **Tier 4 gap topics** with known-items injection. Remaining budget, cap still $3.
6. **Verify** (tier-dependent, §1) → auto-publish verified rows → stage the rest.
7. **Report**, adding **per-source metrics**: fetched / new / matched / changed / verified /
   rejected / cost. Any source with 0 new and 0 matched for 4 runs gets flagged for fixing or
   removal. The report also gains a "possible duplicates" section.

Split the 1,300-line `weekly_edinburgh.py` into `scraper/pipeline/`: `registry.py`,
`ledger.py`, `identity.py`, `adapters/{jsonld,rss,festivals_api,next_data,playwright_page,
instagram,apify_fb,gmail}.py`, `extract.py`, `verify.py`, `report.py`. `weekly_edinburgh.py`
remains the entry point with the same flags.

## 6. Quality guards (carry over + add)
- Keep: verbatim promo codes/savings, date-format verification, low-value and expired drops,
  never bypass blocks.
- Add **Edinburgh geofence**: allevents/Songkick leak Loch Ness/Glasgow rows. Require
  geocoded lat/lng inside the city bbox or a known `place_id`.
- Add **evidence snippets** stored in `field_sources` (`{url, snippet}`), shown in review.
- Add **per-source trust** in the registry, feeding the auto-publish decision.
- Add a **golden set**: 20 known real items (e.g. National Cinema Weekend, Doors Open Day,
  parkruns, EIF £10 tickets). The report shows how many the run found (a recall metric).

## 7. Phases

| # | Phase | Output | Est. effort |
|---|---|---|---|
| **1** | **Dedupe foundation** | `source_items` + `identity_key` migrations; identity matcher; stable slugs; registry with canonical source names + backfill; known-items injection into topics | 1–2 sessions |
| **2** | **Tier 1 adapters** | Festivals API, JSON-LD adapter generalised (Luma, allevents, Eventbrite discover, Songkick), RSS/iCal, `__NEXT_DATA__` (Groupon/Wowcher), geofence | 1–2 sessions |
| **3** | **Tier 2 page-grounded extraction** | Playwright fetcher for JS venues, evidence-snippet extraction, itison, news RSS articles, annual promo calendar | 2 sessions |
| **4** | **Social + newsletters** | Handle list, Business Discovery spike → adapter, IMAP newsletter adapter, Tesseract OCR, post classifier, review-only staging | 2–3 sessions |
| **5** | **Metrics + pruning** | Per-source report, golden-set recall, retire-on-disappear, Reddit API buzz signal | 1 session |

Phase 1 alone stops rediscovery waste. Phase 2 should multiply live events several times over
at ~$0 AI cost. Phases 3–4 target the deals gap.

## 8. Decisions (2026-09-15)
1. Data Thistle: **no** (cost).
2. Apify: **no** (cost). FB is covered indirectly (§4).
3. Meta setup: **yes**, user sets it up (§9a).
4. Newsletter inbox: **yes**, user creates it (§9b).
5. Social/newsletter items: **always review**, never auto-publish.
6. Festivals API: **user registers as "Fomo"** (§9c). App needs the attribution line + "not an
   official festival app" notice wherever festival data is shown.

## 9. User setup checklists

None of these block Phase 1–2. Put credentials in `scraper/.env` only, never in chat or git.

### 9a. Meta / Instagram Business Discovery
1. Create an Instagram account for Fomo, then **Settings → Account type → switch to Professional (Business)**.
2. Create a **Facebook Page** "Fomo Edinburgh" and link the IG account to it (Page settings → Linked accounts → Instagram).
3. At developers.facebook.com, **Create App**, type **Business**. Add the product **"Instagram API with
   Facebook Login"**. Business Discovery is *not* available on the newer "Instagram Login" flavour.
4. In **Graph API Explorer**, pick the app and generate a User token with `instagram_basic`,
   `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`.
5. Test it with
   `GET /me/accounts?fields=instagram_business_account`, which returns your IG user id. Then
   `GET /{ig-user-id}?fields=business_discovery.username(itison){media.limit(5){caption,permalink,timestamp}}`.
   If that returns captions, the route works in dev mode and no App Review is needed.
6. Exchange for a long-lived token (60 days). Phase 4 adds an auto-refresh.
7. Add to `scraper/.env`: `META_APP_ID`, `META_APP_SECRET`, `IG_USER_ID`, `META_ACCESS_TOKEN`.

### 9b. Newsletter inbox
1. Create a Gmail account (e.g. fomo.edinburgh.inbox@…). Turn on **2-Step Verification**, then create an
   **App password** (Google Account → Security → App passwords). The script reads it over **IMAP**,
   which avoids a Google Cloud OAuth app (in Testing mode its refresh tokens expire every 7 days).
2. Add to `scraper/.env`: `NEWSLETTER_IMAP_USER`, `NEWSLETTER_IMAP_APP_PASSWORD`.
3. Subscribe it (use each site's footer signup, accept only essential cookies):
   - **Deals:** itison, Groupon (Edinburgh), Wowcher (Edinburgh), Student Beans, UNiDAYS, Young Scot, Forever Edinburgh (incl. Resident Rewards), DesignMyNight
   - **Listings/news:** Secret Edinburgh, Edinburgh Live, The List, The Skinny, Edinburgh Reporter, Skiddle, DICE, Fever
   - **Festivals:** Edinburgh Festival Fringe, EIF, Book Festival, Edinburgh's Hogmanay, Science Festival, Jazz & Blues, Film Festival
   - **Venues:** Capital Theatres, Usher Hall/Culture Edinburgh, Queen's Hall, Summerhall, Traverse, The Stand, Monkey Barrel, Filmhouse, Cameo, Dominion, Leith Theatre
   - **Culture:** National Galleries, National Museums Scotland, RBGE, Dynamic Earth, Edinburgh Libraries

### 9c. Edinburgh Festivals Listings API
1. Register at api.edinburghfestivalcity.com as **Fomo**, developer / app use.
2. Add the issued credentials to `scraper/.env`: `FESTIVALS_API_KEY`, plus `FESTIVALS_API_SECRET` if one is issued.
3. App task (Phase 2): show "data provided courtesy of the Edinburgh Festivals Listings API" + "Fomo is not an official festival app" on festival items. Refresh ≥ every 24h (so festival data needs a **daily** job, not just the weekly run).
