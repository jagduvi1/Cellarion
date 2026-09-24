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

// ── Offline app shell (#1355) ──────────────────────────────────────────────
// BUILD is stamped in by the build (vite-plugins/swPrecache.js): this build's
// version and every file of it — /index.html plus all hashed JS/CSS/woff2.
// It stays null on the dev server, where nothing is precached.
const BUILD = /*__CELLARION_BUILD__*/null;
// The whole app is kept in ONE cache per build version, index.html together
// with the exact bundles it references — so an offline shell can never point at
// assets a later deploy deleted (why the shell used to be left uncached).
// Offline mode is opt-in: the page asks for it ('offline-enable'), and the
// existence of any shell cache is what remembers the choice across updates.
const SHELL_CACHE_PREFIX = 'cellarion-shell-';
const SHELL_COMPLETE = '/__cellarion-shell-complete__';
const shellCacheName = BUILD ? SHELL_CACHE_PREFIX + BUILD.version : null;

function shellCacheNames() {
  return caches.keys().then((names) => names.filter((name) => name.startsWith(SHELL_CACHE_PREFIX)));
}

async function isShellComplete(name) {
  if (!name || !(await caches.has(name))) return false;
  const cache = await caches.open(name);
  return !!(await cache.match(SHELL_COMPLETE));
}

// Download this build into its shell cache. Idempotent: a complete cache is
// left alone, so a page asking on every load costs nothing after the first.
// Hashed files never change under their name, so any already on the device
// (an older build's shell, the static cache) are copied rather than downloaded
// — a deploy that touched three chunks downloads three chunks, not 5 MB.
// index.html is always fetched fresh. Only a complete run sets the marker.
async function precacheShell() {
  if (!BUILD) return false;
  if (await isShellComplete(shellCacheName)) return true;
  const cache = await caches.open(shellCacheName);
  const toFetch = [];
  for (const url of BUILD.files) {
    const have = url === '/index.html' ? undefined : await caches.match(url);
    if (have) await cache.put(url, have);
    else toFetch.push(url);
  }
  await cache.addAll(toFetch);
  await cache.put(SHELL_COMPLETE, new Response('ok'));
  return true;
}

// Once this build's shell is complete, older builds' shells are dead weight.
// Until then they stay: an older complete shell still opens the app offline.
async function pruneOldShells() {
  if (!(await isShellComplete(shellCacheName))) return;
  const names = await shellCacheNames();
  await Promise.all(names.filter((name) => name !== shellCacheName).map((name) => caches.delete(name)));
}

async function deleteShellCaches() {
  const names = await shellCacheNames();
  await Promise.all(names.map((name) => caches.delete(name)));
}

// The shell for an offline navigation: this build's, else any complete older one.
async function offlineShell() {
  if (await isShellComplete(shellCacheName)) {
    return (await caches.open(shellCacheName)).match('/index.html');
  }
  for (const name of await shellCacheNames()) {
    if (await isShellComplete(name)) return (await caches.open(name)).match('/index.html');
  }
  return undefined;
}

// ── Offline photos (#1355) ─────────────────────────────────────────────────
// The page (utils/offlineSnapshot.syncPhotos) keeps the card-size thumbnails
// of the user's bottles in this cache. Here they are served from it, and when
// a full-size photo can't be fetched offline its thumbnail stands in — so the
// bottle page still shows the bottle without ever storing full-size photos.
const PHOTO_CACHE = 'cellarion-photos';
const PROCESSED_PHOTO = /^\/api\/uploads\/processed\/([A-Za-z0-9_-]+\.(?:png|jpe?g|webp))$/i;

async function servePhoto(request, url) {
  if (url.pathname.startsWith('/api/uploads/thumbs/')) {
    const saved = await caches.match(request, { cacheName: PHOTO_CACHE });
    return saved || fetch(request);
  }
  try {
    return await fetch(request);
  } catch (err) {
    const m = PROCESSED_PHOTO.exec(url.pathname);
    const thumb = m && await caches.match(`/api/uploads/thumbs/processed/${m[1]}.webp`, { cacheName: PHOTO_CACHE });
    if (thumb) return thumb;
    throw err;
  }
}

// App shell files to pre-cache on install
// Only truly static, un-hashed assets are precached here. The HTML shell and
// the hashed bundles are precached only for offline mode, per build version,
// in the shell cache above.
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
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS);
    // Offline mode on (a shell cache exists): bring the new build down now, so
    // the app still opens offline after this update. A failure must not block
    // the update — the page asks again on its next load.
    if ((await shellCacheNames()).length > 0) {
      try { await precacheShell(); } catch { /* retried via 'offline-enable' */ }
    }
  })());
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME && name !== PHOTO_CACHE && !name.startsWith(API_CACHE_PREFIX) && !name.startsWith(SHELL_CACHE_PREFIX))
          .map((name) => caches.delete(name))
      )
    ).then(pruneOldShells)
  );
  self.clients.claim();
});

// The page turns offline mode on or off (utils/offlineMode.js). A reply goes
// back on the MessageChannel port when the page sent one.
self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  const reply = (msg) => { if (event.ports && event.ports[0]) event.ports[0].postMessage(msg); };
  if (type === 'offline-enable') {
    event.waitUntil(
      precacheShell()
        .then((ok) => pruneOldShells().then(() => reply({ type: 'offline-shell', ok })))
        .catch(() => reply({ type: 'offline-shell', ok: false }))
    );
  } else if (type === 'offline-disable') {
    event.waitUntil(deleteShellCaches().then(() => reply({ type: 'offline-shell', ok: false })));
  }
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

  // Photos: saved thumbnails first; offline, a thumbnail for a full-size photo.
  if (url.pathname.startsWith('/api/uploads/')) {
    event.respondWith(servePhoto(request, url));
    return;
  }

  // Skip other API requests — always go to network
  if (url.pathname.startsWith('/api/')) return;

  // Navigation requests (HTML pages): always network-first, never cached here.
  // The SPA shell references build-hashed bundles, so a shell cached on its own
  // would request deleted assets (404) after a deploy. Offline, fall back to
  // offline.html — or, with offline mode on, to the precached shell of a complete
  // build, whose bundles sit in the same cache — the app itself opens.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (await offlineShell()) || caches.match('/offline.html'))
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

      if (cached) {
        networkFetch.catch(() => {}); // offline: the cached copy stands
        return cached;
      }
      return networkFetch;
    })
  );
});
