# Fomo: 10 fixes → staging

## Context
User-reported round (2026-09-29): AI-sounding copy (em-dashes everywhere), Google sign-in missing after
redirects, weak logo, no global search, dull nav, text too small / spacing loose, layout breaks on short
or narrow phones, install-as-app hint rarely seen, "Not now" not reading as tappable, and a request to
let Ask Fomo answer open "find me cheap biryani" questions using Google Maps data behind DeepSeek.
Everything ships to a **staging** Vercel preview first; production (`main`) untouched until the user decides.

## Staging mechanics
- Work on branch `staging` (from `main`). Vercel's git integration builds every non-main push as a
  **Preview** deployment (none exist yet — 54 prod deploys only). Stable URL:
  `fomo-git-staging-<scope>.vercel.app`.
- Staging shares the prod Supabase + API keys (Preview env vars must be enabled in Vercel; user checks).
- User-side one-offs for staging auth to work: add `https://fomo-git-staging-*.vercel.app/**` to Supabase
  Auth → Redirect URLs, and the staging origin to the Google OAuth client's Authorised JS origins
  (otherwise the GIS button can't render there — the fallback redirect button still works).
- No DB writes during this round except the copy rewrite in step 1b, which is gated on user approval
  (staging shares the prod DB, so DB edits are effectively live).

## Work items (model assignment in brackets; main session reviews every diff)

### 1. De-AI the copy [Sonnet]
a. UI strings only (JSX text, toasts, errors, metadata, manifest, email templates, OG alt text,
   `lib/**` user-facing label builders, chat fallback messages). ~1.7k em-dashes repo-wide, most in
   comments — **comments untouched**. Rewrite, don't mechanically swap: split sentences, use commas,
   colons or "·" where it's a label separator. Also kill other AI tells: "Discover", "Dive into",
   "curated", "vibrant", "hidden gem", "Whether you're…", triple-adjective lists.
   Files: `app/**/page.tsx`, `app/layout.tsx`, `app/privacy|terms/page.tsx`, `components/**`,
   `public/manifest.json`, `scripts/lib/weekly-picks.mjs` + email templates, `lib/og/brand-image.tsx`.
b. Ask Fomo system prompt (`app/api/chat/route.ts` buildSystemPrompt): add "Write like a local texting a
   friend. Never use em dashes." and strip em-dashes from the fallback strings.
c. DB content (user decision: dry-run then approve): `scripts/dedash-content.mjs --dry-run` lists
   live `happenings`/`events` text fields containing "—" with proposed rewrites (rule-based, curl
   REST — Node 20 can't run supabase-js) → user approves → `--apply`. Writes are live in prod.

### 2. Google sign-in missing after redirect [main session, small]
Root cause (`app/signin/page.tsx:472-498`): `next/script` fires `onLoad` only the first time the GSI
script loads. On a client-side navigation back to /signin (every in-app "Sign in to save" redirect after
/signin was visited once) `onLoad` never fires → `gisLoaded` stays false → an empty 48px div renders.
Fix: use `onReady` (fires on every mount), also check `window.google?.accounts?.id` in a mount effect,
and add a 3s watchdog: if the GIS button hasn't rendered, set `gisFailed` so the "Continue with Google"
redirect button shows. Never leave the slot blank. Drop the "didn't load, continuing with redirect"
notice (just show the button).

### 3. New logo [user supplies the icon; Haiku wires it in]
User will provide the icon as **SVG** (inline it in FomoLogo; header uses the mark only). Until it arrives, build the plumbing so dropping it in is one step:
`scripts/build-icons.mjs` (sharp, already a dep) generates from one source file →
`public/icons/icon-192/512.png`, maskable 192/512 (safe-zone padding), new `apple-touch-icon-180.png`,
`public/brand/fomo-instagram-icon.png`; update `app/layout.tsx:42-45` (apple-touch → 180) and
`public/sw.js` precache version. `components/ui/FomoLogo.tsx` switches from the inline SVG to the
supplied asset (SVG inline if given SVG, else `next/image`). Wordmark stays as-is unless the user's
file includes one. Add `--color-brand-orange: #fc8a40` token; replace the 4 hard-coded copies.
Logo swap is the last commit on staging if the file arrives late.

### 4. Ask Fomo + Google Places behind DeepSeek [main session designs; Sonnet implements]
- New tool `find_places({query, open_now?, max_price?})` in `app/api/chat/route.ts`. Route becomes a
  bounded 2-round loop: round 1 streams; if the model called `find_places`, server runs
  `searchPlaces()` (existing, `lib/places/google.ts:192`, adds `priceLevels` filter,
  `includedType`, `openNow`, 5 results, Edinburgh bias) and feeds a `tool_result` back; round 2 runs
  with `thinking: disabled` (DeepSeek quirk: thinking + tool follow-ups) and may call `show_places`.
  Always return a tool_result for every tool_use (DeepSeek 400s stranded tool ids).
- Field mask adds `places.googleMapsUri,places.currentOpeningHours.openNow,places.reviewSummary`
  (Gemini-generated "AI summary" from Places API New — this is the "Google Maps AI" bit).
  Catalogue stays first: prompt says use `find_places` only when the catalogue has nothing fitting.
- New block kind `places` in `lib/fomo-ai.ts`; card reuses `ChatItemCard` layout (rating ★, £ level,
  open-now, 1-line AI summary) linking out to `googleMapsUri`. Add to history summariser
  (`fomo/page.tsx:97-100`).
- Limits (`lib/rate-limit.ts`): Google lookups per signed-in user 10/day; site-wide 300/day
  (`consumeGlobalRateLimit("places-ai:global-day")`, fail closed).
- **Anonymous Ask Fomo (user decision): 3 questions/day per IP, max 1 Google lookup/day, no persisted
  history.** Remove `/fomo` from `SIGNED_IN_PAGE_PREFIXES` (proxy.ts:69 + `lib/auth/public-next.ts`
  mirror); add `/api/chat` to `PUBLIC_POST_PREFIXES`. Route: no user → `consumeAnonRateLimit(request,
  "chat:anon-day", {limit:3, windowSeconds:86400, failClosed:true})` + `"places-ai:anon-day"` limit 1;
  skip `parseWhoGroups`; 429 message carries `signin: true` so the UI shows a "Sign in for more"
  card. Client (`fomo/page.tsx`): when signed out, keep history in sessionStorage instead of
  `addMessage` → `chat_messages`. Global chat cap (1500/day) still applies to both.
- Explore search bar gets an "Ask Fomo: '<q>'" row → `/fomo?q=<q>` auto-sends.

### 5. "Not now — keep browsing" [Haiku]
It *is* a `<button>` with working `router.push` (`app/signin/page.tsx:537`,
`app/welcome/page.tsx:283`), but styled as faint underlined caption so it doesn't read as tappable.
Make it a real `<Link href={publicNextOrHome(next)}>` styled as a full-width ghost/outline button
(44px min height), copy "Not now, keep browsing", moved above the Terms line so taps don't land on
Terms/Privacy. When `next` is gated (/fomo, /profile), fall back to `returnTo` from the seed URL
before `/`, so Ask-Fomo-from-Explore → Not now returns to Explore.

### 6. Install-as-app prompt [Sonnet]
`InstallHint.tsx` exists but only from the 2nd visit, after a cookie choice made in an *earlier*
session (gate read once on mount), max 3 shows; Android's `beforeinstallprompt` listener attaches
late and misses early events; iPadOS never detected → most users never see it. Changes: show on 1st
visit after 2 page views or 25s, re-evaluate when consent is chosen, capture `beforeinstallprompt` in
a tiny early module (`lib/pwa/install-prompt.ts`, imported from the root layout) so it isn't lost,
detect iPadOS (`MacIntel` + touch points); keep 14-day dismiss cooldown. Add a
permanent "Install Fomo" row in the profile menu + a small "Get the app" chip in AppHeader on mobile
browsers (hidden in standalone). iOS opens a bottom sheet with the Share → "Add to Home Screen"
steps illustrated; Android uses `beforeinstallprompt`; in-app browsers (Instagram) get "Open in
Safari/Chrome first".

### 7. Responsive pass [Sonnet ×2, split by pages]
- Root cause of "Make Fomo yours" cut-off: `components/ui/BottomSheet.tsx:109/130/142` — bottom-aligned
  panel with no max-height and no scrollable body, page scroll locked, so tall sheets spill off the
  top. Fix once in BottomSheet (fixes ExploreSheet, FilterSheet, CityPicker, ConfirmDialog, profile
  sheets too): panel `flex flex-col max-h-[calc(100dvh-env(safe-area-inset-top)-1rem)]`, body
  `min-h-0 overflow-y-auto overscroll-contain`, title/handle stay pinned.
- Fix known overlaps: FeedHero venue label (add right bound + truncate) and top-row pill collision;
  headers at 320px; BottomNav drop fixed `w-16` for flex-1.
- Unify page gutters to `px-4`.
- Verify every shell page at 320×568, 360×640, 375×667, 390×844, 430×932, 768×1024 via
  `resize_window` + screenshots; fix anything clipped/overlapping.

### 8. Search [Sonnet]
Decision: **search icon in the shared header** (replacing the header's Saved bookmark, which duplicates
the Saved tab), not a nav slot — keeps the 4+FAB nav balanced and search reachable from every page.
- New `/search` page: autofocused input, debounced `GET /api/explore?layer=everything&q=` (already
  public), results grouped Deals / Events / Free / Places with existing card rows, recent searches
  (localStorage), and a top row "Ask Fomo: '<q>'" → `/fomo?q=`.
- Home moves onto `AppHeader` (kills its duplicated inline header, `app/(shell)/page.tsx:543`).
- Explore reads `?q=` to seed its search state.

### 9. Colourful nav [Haiku, after 3's token lands]
Per-item colours: Feed = brand orange (text shade `#c2410c` for AA), Saved = `cat-nightlife` pink,
Deals = `cat-sports` green, Explore = `accent` blue. Inactive: icon outline in its colour, neutral
label. Active: filled icon + 12%-tint pill behind icon + coloured label.

### 10. Bigger, tighter [Sonnet, runs before 7]
Token bump in `app/globals.css`: body-md 15→16, body-sm 13→14, label-lg 14→15, label-md 12→14,
label-sm 11→12, headline-sm 16→18, headline-md 20→22. Replace the 39 raw `text-[9|10|11px]` uses with
tokens (min 12px). Nav icons 24→26, labels 12px. Tighten vertical rhythm: section `gap-6`→`gap-4`,
card padding `p-4`→`p-3.5`, hero heights unchanged. 7 runs after this so the responsive pass sees final sizes.

## Sequencing
1. Branch `staging`. Parallel wave A (disjoint files): #2 (me), #5 (Haiku), #1a (Sonnet, copy only),
   #3 logo assets (me + Haiku).
2. Wave B: #10 tokens (Sonnet) → #9 nav (Haiku) → #8 search + header (Sonnet) → #6 install (Sonnet).
3. Wave C: #4 chat + Places (Sonnet, my design spec) in parallel with #7 responsive (Sonnet).
4. Main session: diff review each wave, `npx tsc --noEmit`, `npx eslint`, `npx tsx --test`.
5. Push `staging` → Vercel preview; verify there.

## Verification
- Local `npm run dev` via preview_start: every shell page at the 6 viewport sizes, light only
  (app is light-only), screenshots of home/deals/explore/search/saved/profile/signin/welcome/
  Make Fomo yours.
- Sign-in: open /signin, navigate away, trigger "Sign in to save" → Google button present.
  Block `accounts.google.com` in devtools → fallback button appears within 3s.
- Chat: "cheap biryani near Leith" → places cards with rating/£/maps link; catalogue question still
  returns catalogue cards; 11th Google lookup in a day → graceful "limit" message; anon behaviour per
  decision.
- `grep -rn '—'` over JSX text / string literals in app+components returns only comments.
- Staging preview: Vercel build green, sign-in works on preview origin, PWA install hint on a phone.
