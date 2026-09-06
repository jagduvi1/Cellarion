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

export function createApiFetch(getToken, onRefresh, onLogout) {
  return async function apiFetch(url, options = {}) {
    if (!isApiTarget(url)) {
      const { headers: callerHeaders = {}, ...rest } = options;
      return fetch(url, { ...rest, headers: { ...callerHeaders }, credentials: 'omit' });
    }

    const token = getToken();
    const headers = { ...options.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // credentials: 'include' is required so the httpOnly refresh cookie is sent
    let res = await fetch(url, { ...options, headers, credentials: 'include' });

    if (res.status === 401) {
      const newToken = await onRefresh();
      if (newToken) {
        headers['Authorization'] = `Bearer ${newToken}`;
        res = await fetch(url, { ...options, headers, credentials: 'include' });
      } else {
        onLogout();
      }
    }

    return res;
  };
}
