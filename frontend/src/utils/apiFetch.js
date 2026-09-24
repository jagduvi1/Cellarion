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

const TIMED_OUT = Symbol('timed-out');

/**
 * Offline mode hooks (#1355), both optional:
 *  - offlineFallback(url) → Promise<Response|null>: the device copy's answer
 *    to a GET. Used when the browser reports it is offline, when the request
 *    fails, or when it is slower than SLOW_GET_MS. null → behave as before.
 *  - onLive(): a real server response arrived.
 *  - onMutation(url): a write (non-GET) succeeded.
 */
export function createApiFetch(getToken, onRefresh, onLogout, { offlineFallback, onLive, onMutation } = {}) {
  async function send(url, init, isGet) {
    if (!isGet || !offlineFallback) return fetch(url, init);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      const saved = await offlineFallback(url);
      if (saved) return saved;
    }
    const request = fetch(url, init).then((r) => ({ r }), (e) => ({ e }));
    let timer;
    const first = await Promise.race([
      request,
      new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), SLOW_GET_MS); }),
    ]);
    clearTimeout(timer);
    if (first === TIMED_OUT) {
      const saved = await offlineFallback(url);
      if (saved) return saved;
    }
    const settled = first === TIMED_OUT ? await request : first;
    if (settled.e) {
      const saved = await offlineFallback(url);
      if (saved) return saved;
      throw settled.e;
    }
    return settled.r;
  }

  return async function apiFetch(url, options = {}) {
    if (!isApiTarget(url)) {
      const { headers: callerHeaders = {}, ...rest } = options;
      return fetch(url, { ...rest, headers: { ...callerHeaders }, credentials: 'omit' });
    }

    const token = getToken();
    const headers = { ...options.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const isGet = !options.method || String(options.method).toUpperCase() === 'GET';

    // credentials: 'include' is required so the httpOnly refresh cookie is sent
    let res = await send(url, { ...options, headers, credentials: 'include' }, isGet);
    if (res.headers?.get?.('X-Cellarion-Offline') != null) return res; // the device's copy
    if (onLive) onLive();

    if (res.status === 401) {
      const newToken = await onRefresh();
      if (newToken) {
        headers['Authorization'] = `Bearer ${newToken}`;
        res = await fetch(url, { ...options, headers, credentials: 'include' });
      } else {
        onLogout();
      }
    }

    if (!isGet && res.ok && onMutation) onMutation(url);
    return res;
  };
}
