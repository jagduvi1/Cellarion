import { API_URL } from '../api/apiConstants';

/**
 * Creates a fetch wrapper that:
 * - Automatically injects the current access token as Authorization header
 * - On 401, attempts a token refresh via /api/auth/refresh (httpOnly cookie)
 * - Retries the original request once with the new token
 * - Calls onLogout() if the refresh also fails
 *
 * The bearer token and the refresh cookie are only ever meant for OUR API. A
 * caller-supplied URL that resolves anywhere else — a protocol-relative
 * `//host/x`, a backslash trick, an absolute third-party URL — is fetched
 * with neither, and never triggers the refresh/logout dance (audit 2026-09
 * F03-3 / S7-1: a registry image value used to reach this wrapper verbatim).
 *
 * Usage (via AuthContext):
 *   const { apiFetch } = useAuth();
 *   const res = await apiFetch('/api/cellars', { method: 'GET' });
 */
export function isApiTarget(url) {
  try {
    // Our API is the page origin (nginx proxies /api there) and, when
    // VITE_API_URL names another host, that origin as well.
    const base = typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost';
    const apiOrigin = new URL(API_URL || '/', base).origin;
    const target = new URL(String(url), base);
    return (target.origin === base || target.origin === apiOrigin) && target.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

// A GET that has not answered after this long, with an offline answer
// available, is answered from the device's copy (offline mode): a basement's
// one-bar signal hangs far more often than it fails.
export const SLOW_GET_MS = 6000;
// A queueable write that has not answered after this long is queued (offline
// mode). Safe even if it then lands: the queued copy carries the same
// Idempotency-Key, so the server answers it with the stored result.
export const SLOW_WRITE_MS = 8000;

const TIMED_OUT = Symbol('timed-out');

/**
 * Try the network; with an offline answer available, use it when the browser
 * reports offline, when the request fails, or when it is slower than `slowMs`.
 * `offline()` → Promise<Response|null>; null means "no offline answer".
 */
async function withOffline(url, init, slowMs, offline) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const saved = await offline();
    if (saved) return saved;
  }
  const request = fetch(url, init).then((r) => ({ r }), (e) => ({ e }));
  let timer;
  const first = await Promise.race([
    request,
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), slowMs); }),
  ]);
  clearTimeout(timer);
  if (first === TIMED_OUT) {
    // Merely slow — the real answer may still come. Only an offline answer
    // that is a real hit may stand in; a "not found" from the device copy
    // (a consumed bottle, a cellar shared since the copy was made) must not
    // replace a slow but correct server answer.
    const saved = await offline();
    if (saved && saved.ok !== false) return saved;
  }
  const settled = first === TIMED_OUT ? await request : first;
  if (settled.e) {
    const saved = await offline();
    if (saved) return saved;
    throw settled.e;
  }
  return settled.r;
}

/**
 * Offline mode hooks (#1355), all optional:
 *  - offlineFallback(url) → Promise<Response|null>: the device copy's answer
 *    to a GET the network can't give (see withOffline).
 *  - offlineWriteKey(url, method) → string|null: an Idempotency-Key for a
 *    write that could be queued; sent on the live attempt too.
 *  - offlineWrite(url, init, key) → Promise<Response|null>: queue that write
 *    when the network can't take it.
 *  - onLive(): a real server response arrived.
 *  - onMutation(url): a write (non-GET) succeeded.
 * A request with `__direct: true` (the queue's own sends) skips them all.
 */
export function createApiFetch(getToken, onRefresh, onLogout, {
  offlineFallback, offlineWriteKey, offlineWrite, onLive, onMutation,
} = {}) {
  return async function apiFetch(url, options = {}) {
    const { __direct = false, ...opts } = options;
    if (!isApiTarget(url)) {
      const { headers: callerHeaders = {}, ...rest } = opts;
      return fetch(url, { ...rest, headers: { ...callerHeaders }, credentials: 'omit' });
    }

    const token = getToken();
    const headers = { ...opts.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const method = String(opts.method || 'GET').toUpperCase();
    const isGet = method === 'GET';

    // credentials: 'include' is required so the httpOnly refresh cookie is sent
    const init = { ...opts, headers, credentials: 'include' };
    let res;
    if (__direct) {
      res = await fetch(url, init);
    } else if (isGet && offlineFallback) {
      res = await withOffline(url, init, SLOW_GET_MS, () => offlineFallback(url));
    } else if (!isGet && offlineWrite && offlineWriteKey) {
      const key = offlineWriteKey(url, method);
      if (key) {
        headers['Idempotency-Key'] = key;
        res = await withOffline(url, init, SLOW_WRITE_MS, () => offlineWrite(url, init, key));
      } else {
        res = await fetch(url, init);
      }
    } else {
      res = await fetch(url, init);
    }
    if (res.headers?.get?.('X-Cellarion-Offline') != null) return res; // the device's copy / queued
    if (onLive) onLive();

    if (res.status === 401) {
      const newToken = await onRefresh();
      if (newToken) {
        headers['Authorization'] = `Bearer ${newToken}`;
        res = await fetch(url, { ...opts, headers, credentials: 'include' });
      } else {
        onLogout();
      }
    }

    if (!isGet && res.ok && onMutation) onMutation(url);
    return res;
  };
}
