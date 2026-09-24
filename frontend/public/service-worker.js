/* eslint-disable no-restricted-globals */

const CACHE_NAME = 'cellarion-v4';
// API responses are cached PER USER: one cache per account, named
// `${API_CACHE_PREFIX}<userId>`. The Cache API matches on URL alone and ignores
// the Authorization header, so a single shared cache let the next person on a
// shared device be served the previous account's cellar straight from the
// cache — the server's access check never ran. v1 was that shared cache; the
// activate step deletes it. The page wipes every API cache on logout
// (clearApiCaches in serviceWorkerRegistration.js).
const API_CACHE_PREFIX = 'cellarion-api-v2-';

// The account a request is made as, read from its bearer token. The payload is
// NOT verified here — it does not need to be: it only picks which of this
// device's caches to use, and the server still authorises the network request.
// No token (or an unreadable one) → null → the request is never cached.
function apiCacheNameFor(request) {
  const match = /^Bearer\s+[^.\s]+\.([^.\s]+)\.[^.\s]+$/.exec(request.headers.get('Authorization') || '');
  if (!match) return null;
  try {
    const payload = JSON.parse(atob(match[1].replace(/-/g, '+').replace(/_/g, '/')));
    const id = String(payload && payload.id);
    return /^[a-f0-9]{24}$/i.test(id) ? API_CACHE_PREFIX + id : null;
  } catch {
    return null;
  }
}

function deleteApiCaches() {
  return caches.keys().then((names) =>
    Promise.all(names.filter((name) => name.startsWith(API_CACHE_PREFIX)).map((name) => caches.delete(name)))
  );
}

// App shell files to pre-cache on install
// Only truly static, un-hashed assets are precached. The HTML shell ('/' and
// '/index.html') is deliberately NOT precached — it maps to build-hashed
// bundles, so a frozen shell would request deleted assets (404) after a deploy.
const PRECACHE_URLS = [
  '/offline.html',
  '/manifest.json'
];

// API paths eligible for stale-while-revalidate caching.
// Only safe, read-heavy GET endpoints that benefit from instant repeat loads.
const CACHEABLE_API_PATTERNS = [
  '/api/cellars/',   // cellar detail + bottles (the LCP-critical request)
  '/api/wines/',     // wine detail pages
  '/api/bottles/',   // bottle detail
];

// Install: pre-cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME && !name.startsWith(API_CACHE_PREFIX))
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// ── Push Notifications ──────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Cellarion';
  const options = {
    body: data.message || '',
    icon: '/logo192.png',
    badge: '/logo192.png',
    data: { link: data.link },
    tag: data.tag || 'cellarion-notification',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // The link is server-built, but it is data: only ever open this origin
  // (audit 2026-09 F03-5).
  const raw = event.notification.data?.link;
  let link = null;
  try {
    const target = raw ? new URL(String(raw), self.location.origin) : null;
    if (target && target.origin === self.location.origin) link = target.href;
  } catch { link = null; }
  if (link) {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        for (const client of clients) {
          if (new URL(client.url).origin === self.location.origin) {
            client.navigate(link);
            return client.focus();
          }
        }
        return self.clients.openWindow(link);
      })
    );
  }
});

// Fetch handler
self.addEventListener('fetch', (event) => {
  const { request } = event;

  const url = new URL(request.url);

  // Any non-GET request to a cached API path means data changed (add/remove/update bottle, etc.)
  // — wipe the API cache so the next page load fetches fresh data instead of showing stale content.
  if (request.method !== 'GET') {
    if (url.pathname.startsWith('/api/')) {
      // A write can change what other accounts see too (a shared cellar), so
      // every account's cache on this device goes, not only the writer's.
      deleteApiCaches();
    }
    return;
  }

  // ── Cacheable API requests: stale-while-revalidate ──
  // Serve the cached response instantly (eliminates the API wait on repeat visits),
  // then update the cache in the background so the next load is fresh.
  const apiCacheName = url.pathname.startsWith('/api/') && CACHEABLE_API_PATTERNS.some((p) => url.pathname.startsWith(p))
    ? apiCacheNameFor(request)
    : null;
  if (apiCacheName) {
    event.respondWith(
      caches.open(apiCacheName).then((cache) =>
        cache.match(request).then((cached) => {
          const networkFetch = fetch(request).then((response) => {
            if (response.ok) {
              cache.put(request, response.clone());
            } else if (response.status === 403 || response.status === 404) {
              // Access withdrawn (a share revoked) or the thing is gone: stop
              // serving the stale copy on the next visit. (Not 401 — that is
              // only an expired access token, and apiFetch retries at once.)
              cache.delete(request);
            }
            return response;
          });
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // Skip other API requests — always go to network
  if (url.pathname.startsWith('/api/')) return;

  // Navigation requests (HTML pages): always network-first, NEVER cached. The
  // SPA shell references build-hashed bundles, so a cached shell would request
  // deleted assets (404) after a deploy. Fall back to offline.html only offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/offline.html'))
    );
    return;
  }

  // Static assets: stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });

      return cached || networkFetch;
    })
  );
});
