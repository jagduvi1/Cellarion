/* eslint-disable no-restricted-globals */

const CACHE_NAME = 'cellarion-v3';
const API_CACHE_NAME = 'cellarion-api-v1';

// App shell files to pre-cache on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
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
  const validCaches = new Set([CACHE_NAME, API_CACHE_NAME]);
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((name) => !validCaches.has(name)).map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Fetch handler
self.addEventListener('fetch', (event) => {
  const { request } = event;

  const url = new URL(request.url);

  // Any non-GET request to a cached API path means data changed (add/remove/update bottle, etc.)
  // — wipe the API cache so the next page load fetches fresh data instead of showing stale content.
  if (request.method !== 'GET') {
    if (url.pathname.startsWith('/api/')) {
      caches.delete(API_CACHE_NAME);
    }
    return;
  }

  // ── Cacheable API requests: stale-while-revalidate ──
  // Serve the cached response instantly (eliminates the API wait on repeat visits),
  // then update the cache in the background so the next load is fresh.
  if (url.pathname.startsWith('/api/') && CACHEABLE_API_PATTERNS.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(
      caches.open(API_CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          const networkFetch = fetch(request).then((response) => {
            if (response.ok) {
              cache.put(request, response.clone());
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

  // Navigation requests (HTML pages): network-first with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match('/offline.html'))
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
