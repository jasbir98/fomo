# Technical SEO fixes (14 Oct 2026)

From the product review, §3.4 "Technical fixes" (`docs/strategy/2026-10-14-product-review.md`). One PR; slug URLs are a separate, later PR (proposal at the end) because they need the user's go-ahead.

## 1. Place pages
- `app/(shell)/place/[id]/page.tsx` becomes a server component, built like `happening/[id]`: `generateStaticParams() → []`, `revalidate = 300`, a `cache()`d loader on the anon client (place, photos, live offers, upcoming events at the venue).
- `PlaceDetail` takes `initialData` and still refreshes on mount, the same contract as `HappeningDetail`/`EventDetail`. The overlay keeps loading client-side.
- New "What's on here" section on the place page: upcoming events at that venue (`events.place_id`). Without it, the ~120 event-venue pages in the sitemap would be a name and an address.
- Metadata moves from the layout to `generateMetadata` via `pageMetadata` (canonical `/place/<id>`). The layout is deleted.
- `placeSeo()` in `lib/seo/detail.ts`: description, and LocalBusiness/TouristAttraction JSON-LD (type picked from the free-text category, address, geo, opening hours, phone, website as `sameAs`, offers as `makesOffer`). No Google rating: third-party ratings aren't allowed in review markup. A permanently closed place is noindex.
- `app/sitemap.ts` adds every place that has a live, not-ended offer or an upcoming event. Both lists are already loaded for the sitemap, so no extra query. `lastModified` is the newest of those rows' dates (places have no `updated_at`).

## 2. /whats-on and /book-early server-rendered
- `page.tsx` becomes a server component (`revalidate = 120`) that calls `loadFeedForPage`; the client UI moves to `WhatsOnClient.tsx` / `BookEarlyClient.tsx` and takes the server data as its starting content (Deals/Free pattern).
- /whats-on reads `?window=` and `?free=` with `useSearchParams`, which makes a static page bail out to client rendering up to the nearest `<Suspense>`. To keep the page static and still put content in the HTML, the Suspense fallback renders the same view with the default params (Today, not free-only), filled from the server data. The browser swaps in the real-params tree on hydration.
- The layouts' metadata moves into the pages.

## 3. JSON-LD
- Paid deals get an `Offer`: a dated paid happening's Event gets one (price only when the label names a price, since `saving_amount` is sometimes a saving), and a standing deal (no Event) gets a top-level `Offer` with `offeredBy` the venue.
- `BreadcrumbList` on happening, event and place pages: Home › list page › item.
- `ItemList` on /whats-on, /book-early, /weekend, /deals and /free (first 30 items, with URLs).

## 4. Config
- `skipTrailingSlashRedirect` stays (it's the only switch Next has), and `proxy.ts` now does the trailing-slash 308 itself for every path except `/ingest/*`. That's the pattern the Next docs recommend for this flag.
- Static sitemap entries get real `lastModified`: list pages use the newest catalogue row date, and legal pages use a fixed date bumped by hand.

## 5. Internal links
- Happening and event pages link the venue name to `/place/<id>` when linked. They also get a "More in <list>" link to their list page (`/whats-on`, `/deals`, `/free`, `/book-early`), from the same helper as the breadcrumb.

## 6. Slug URLs (proposal only, not built)
See the PR description.
