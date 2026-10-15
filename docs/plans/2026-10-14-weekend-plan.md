# Shareable Weekend plan (`/plan/<id>`)

## Context
The 14 Oct PM review (`docs/strategy/2026-10-14-product-review.md` §"highest leverage") ranks a shareable weekend plan as the #1 feature: students/under-30s plan in WhatsApp groups, the best IG post was the "£0 weekend receipt" (`scripts/out/ig-thu-zero/08-receipt.png`), and Fomo has no viral loop (0 subscribers, 5 share sessions in 30 days). Goal: pick 2–4 things → one short link whose WhatsApp preview *is* the receipt → landing page that converts the group ("Make your own plan", email signup). No account needed anywhere.

## Recommendation: store plans in a small table (not encoded URLs)
- **Short link** (`askfomo.com/plan/k3Fq9xZa`, 8 chars base62) vs ~150 chars of UUIDs in the URL. It shows in the WhatsApp message.
- **Snapshot**: each item's title, day/time, price and image are frozen at creation, so the OG image and page render from one row read (no 4 lookups per WhatsApp crawl) and the receipt stays correct after an event ends or is retired.
- **Server-resolved, not client text**: the client sends only `{kind, id, day?}` refs; the API looks each one up and builds the snapshot. Nobody can mint an askfomo.com receipt image with arbitrary text or images.
- **Dedupe**: `items_hash` (sorted refs) is unique, so the same picks give the same link (idempotent, fewer rows).
- Cost: one SQL file for you to run. Until it's run, "Make link" shows "Couldn't make your link" (API returns 503), nothing else breaks.

## Data
`supabase/add_plans.sql` (+ README "Pending" entry):
```sql
create table if not exists public.plans (
  id text primary key check (id ~ '^[A-Za-z0-9]{8}$'),
  items jsonb not null,              -- PlanItem[] snapshot, 1–4
  items_hash text not null unique,
  created_at timestamptz not null default now()
);
alter table public.plans enable row level security;   -- no policies: service-role only
revoke all on public.plans from anon, authenticated;
```
`PlanItem` = `{ kind: "happening"|"event", id, title, venue, day (YYYY-MM-DD), time ("7:30pm"|null), image (url|null), price: { label: "FREE"|"£5"|"From £12"|"20% off"|null, amount: number|null, from: boolean } }`.

## Pricing / total (honest, no guessing — matches price-label.ts rules)
New `lib/plans/price.ts`, built on `lib/happenings/price-label.ts`:
- free (`is_free === true`) → £0.
- event `price_from` → amount, `from: true` (label "From £N").
- happening `price_text` matching only `^(from )?£N(.NN)?$` → amount; else label from `priceLabelForHappening` ("20% off", "2-for-1") with `amount: null`.
- Total line: all known & exact → **"£7 total"**; any floor → **"From £7"**; any unknown → **"£7 + 1 TBC"**. All free → **"£0 total"**.

## Building a plan (client)
- `lib/plans/basket.ts`: localStorage `fomo_plan` (max 4 refs + display bits), `useSyncExternalStore` hook like SubscribeCard's, cross-tab via `storage` event. try/catch every access.
- `components/plans/AddToPlanButton.tsx`: small pill ("+ Plan" / "✓ In plan"), disabled at 4. Tracks `plan_item_added {kind, id, surface}`.
  - On `/weekend` cards: `FeedListCard` gets an optional `planAction` slot rendered only when `surface === "weekend"` (happening, series→lead, recurring→lead, event rows). Day = the card's own `cardDayDate`.
  - On detail pages: `HappeningDetail` / `EventDetail` top-bar action row, next to Share. Day = event `starts_at` day / happening's `nextOccurrence` (`lib/happenings/occurrence.ts`).
- `components/plans/PlanBar.tsx`: sticky bottom bar (above the mobile nav) on `/weekend` and detail pages when the basket is non-empty: thumbnails, "2 picked · £7", **Make link** (needs ≥2; 1 item shows "Add one more"), × to clear. Tap list to remove items. Make link → `POST /api/plans` → `track("weekend_plan_created", {count, total_known, has_unknown, source})` → open the native share sheet / copy, then route to `/plan/<id>`; basket kept so they can tweak and re-make.

## API: `app/api/plans/route.ts` (POST)
- Body `{ items: {kind, id, day?}[] }`, 2–4, unique, ids validated (uuid/slug regex).
- `consumeAnonRateLimit(request, "plans", {limit: 20, windowSeconds: 3600})` + `consumeGlobalRateLimit("plans_global", {limit: 3000, windowSeconds: 86400})` (`lib/rate-limit.ts`, fail-open as elsewhere).
- Look up with `listHappeningsByIds` / `listEventsByIds` (`lib/db/*`, `supabaseAnon()` so only live/public rows qualify), build snapshot, hash, `upsert … on conflict (items_hash) do nothing` then select id; retry id on PK collision. Insert via `supabaseAdmin()`.
- Add `/api/plans` to `PUBLIC_POST_PREFIXES` in `proxy.ts`.

## Landing page: `app/(shell)/plan/[id]/page.tsx`
- Server component; `cache()`'d `getPlan(id)` (`lib/plans/db.ts`, service role, `server-only`); 404 if missing. `revalidate = 3600`, `generateStaticParams() { return [] }` like event pages. `pageMetadata({ title: "A £7 weekend in Edinburgh", path, images: false, noindex: true })`.
- Receipt-styled list (paper card, mono numerals): photo thumb, DAY + time, title, venue, price; dashed rule; TOTAL. Each row links to its detail page.
- CTAs: **Send to the group** (WhatsApp `https://wa.me/?text=` deep link + `ShareButton`), **Make your own plan** → `/weekend`, then `SubscribeCard source="plan"` (the email CTA; there's no WhatsApp Channel yet — when there is, it slots in here).
- `components/plans/PlanShareActions.tsx` (client) fires `weekend_plan_shared {method: native|clipboard|whatsapp, id}`. `ShareButton` gets one optional `onShared(method)` prop (still fires `share_completed`, `kind: "plan"`).

## OG image: `app/(shell)/plan/[id]/opengraph-image.tsx` (+ `twitter-image` re-export)
1200×630, the IG receipt look: navy (#1b365d) background, left 55% a slightly rotated paper receipt (ASKFOMO / EDINBURGH · 17–18 OCT, rows `SAT Title …… £0.00`, dashed rules, big **TOTAL £7.00**), right a 2×2 (or 1–3 adaptive) photo collage with day chips, lowercase "fom●" wordmark. Fonts bundled in repo (`lib/og/fonts/` Space Mono 700 + Plus Jakarta Sans 800, OFL, read with `fs`) — no runtime Google Fonts fetch. Photos fetched + byte-sniffed (PNG/JPEG/GIF only; webp → category-colour tile), logic lifted from `scripts/ig-carousel.mjs` into `lib/og/fetch-image.ts`. **Size**: WhatsApp drops previews over ~300 KB, so the PNG from `ImageResponse` is re-encoded to JPEG q≈78 with `sharp` (already in node_modules) and `contentType = "image/jpeg"`; target < 200 KB.

## Analytics
`weekend_plan_created`, `weekend_plan_shared`, `plan_item_added` via `lib/analytics/track.ts`; documented in `docs/analytics.md`. Plan visits show as `$pageview` on `/plan/*` with `utm_source=share`.

## Files
New: `supabase/add_plans.sql`, `lib/plans/{types,price,basket,db,snapshot}.ts`, `lib/og/{receipt-image.tsx,fetch-image.ts,fonts/*}`, `app/api/plans/route.ts`, `app/(shell)/plan/[id]/{page,opengraph-image,twitter-image}.tsx`, `components/plans/{AddToPlanButton,PlanBar,PlanShareActions,PlanReceipt}.tsx`, `lib/plans/price.test.ts`.
Edit: `proxy.ts`, `components/ui/ShareButton.tsx`, `components/happenings/FeedListCard.tsx`, `components/happenings/SubscribeCard.tsx` (source union), `app/(shell)/weekend/WeekendClient.tsx`, `components/detail/{HappeningDetail,EventDetail}.tsx`, `supabase/README.md`, `docs/analytics.md`, `docs/README.md`.

Out of scope: places in plans, custom plan names (free text on an OG image = abuse risk), editing a saved plan (re-make gives a new link), per-item OG images for detail pages.

## Verification
1. `npx tsc --noEmit`, `npm run lint`, `npm run build`, existing tests + `price.test.ts`.
2. Needs `add_plans.sql` run once (I'll ask you when I get there; it only creates a new table). Copy `.env.local` into the worktree for the dev server.
3. Browser pane at 375px: add 3 items on /weekend + 1 from a detail page, bar shows total, Make link → `/plan/<id>`; landing page renders, links work, signed out. Second Make link with same picks returns the same id. 5th add is blocked.
4. `curl -sI /plan/<id>/opengraph-image` → `image/jpeg`, size < 300 KB; view the image; check `og:image` meta in page HTML.
5. PR opened, `docs/plans/2026-10-14-weekend-plan.md` saved, `docs/README.md` row + to-dos (run SQL, test WhatsApp preview on a real phone after deploy).
