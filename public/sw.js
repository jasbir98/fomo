// Fomo minimal service worker — app-shell precache + offline fallback.
// Hand-rolled (next-pwa targets webpack; Next 16 uses Turbopack). v1.

// Cache name intentionally left as "roameo-shell-v1" — the version suffix IS
// the cache-bust mechanism, so renaming it would be a gratuitous full-cache eviction.
const CACHE = "roameo-shell-v1";
// Bumped v1 -> v2 to evict entries written by the previous version, which
// accepted opaque cross-origin responses (status 0, unreadable error state)
// and so could be holding cached failures for third-party CDN photos.
const IMG_CACHE = "img-v2";
const OFFLINE_URL = "/offline";
const PRECACHE = ["/offline", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];
const IMG_CACHE_MAX = 40; // LRU cap for image cache (reduced for opaque responses which are padded)

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== CACHE && k !== IMG_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Cross-origin (third-party CDN photos, the Google Fonts stylesheet, …):
  // don't call respondWith at all, so the browser makes the request itself
  // under its normal CSP context. Re-issuing it here via the Fetch API would
  // instead be checked against `connect-src`, which lists only Supabase and
  // Mapbox — so every host allowed by `img-src https:` / `style-src
  // fonts.googleapis.com` got blocked and turned into a `Response.error()`
  // (see CSP_DIRECTIVES in next.config.ts). Widening `connect-src` isn't an
  // option: `img-src` is an open `https:` wildcard because event photos are
  // hotlinked from arbitrary CDNs. The remote images worth caching are
  // already reachable same-origin via `/_next/image` and `/api/media-proxy`,
  // which the image branch below still handles.
  if (new URL(request.url).origin !== self.location.origin) return;

  // Images: stale-while-revalidate with LRU cap.
  if (
    request.destination === "image" ||
    request.url.includes("/_next/image") ||
    request.url.includes("/api/media-proxy")
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(IMG_CACHE);
        const cached = await cache.match(request);

        const fetchPromise = fetch(request)
          .then(async (response) => {
            // Only same-origin requests reach here (see the cross-origin bail-out
            // above), so responses are always CORS-readable — no opaque (status 0)
            // case to special-case, and no risk of caching an unreadable error.
            if (response.ok) {
              const cloned = response.clone();
              await cache.put(request, cloned);
              // Enforce LRU cap: delete oldest entries if over limit.
              const keys = await cache.keys();
              if (keys.length > IMG_CACHE_MAX) {
                const toDelete = keys.slice(0, keys.length - IMG_CACHE_MAX);
                await Promise.all(toDelete.map((k) => cache.delete(k)));
              }
            }
            return response;
          })
          .catch(() => Response.error()); // Network error: return error response, don't reject.

        // Ensure background refresh completes even if client has cached response.
        event.waitUntil(fetchPromise);

        // Return cached immediately; refresh in background.
        return cached || fetchPromise;
      })()
    );
    return;
  }

  // Everything else same-origin: cache-first for precached static assets.
  // Navigations: network-first, fall back to cached offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE);
          const cached = await cache.match(OFFLINE_URL);
          return cached ?? Response.error();
        }
      })()
    );
    return;
  }

  // Precached static assets: cache-first.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        return await fetch(request);
      } catch {
        return Response.error();
      }
    })()
  );
});

// ---------------------------------------------------------------------------
// Web push — "Book early" on-sale alerts (supabase/functions/onsale-alerts).
// Payload shape sent by the sender: { title, body, url, tag }. `tag` is the
// happening id, so a second push for the same happening (e.g. the sender's
// opt_in and big_alert reasons both firing for one user) replaces the first
// notification instead of stacking two.
// ---------------------------------------------------------------------------
self.addEventListener("push", (event) => {
  let payload = { title: "Fomo", body: "Tickets update", url: "/", tag: "fomo-push" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // Non-JSON push payload — fall back to the generic defaults above
    // rather than throwing out of the event handler.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: payload.tag,
      data: { url: payload.url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : "/";

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const targetUrl = new URL(url, self.location.origin).href;
      for (const client of clientsList) {
        if (client.url === targetUrl && "focus" in client) {
          return client.focus();
        }
      }
      // No matching tab open — focus any existing Fomo window and navigate
      // it, rather than always opening a fresh one.
      for (const client of clientsList) {
        if ("navigate" in client && "focus" in client) {
          await client.focus();
          return client.navigate(targetUrl);
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })()
  );
});
