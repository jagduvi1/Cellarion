/**
 * Where to send someone once they finish signing in.
 *
 * ProtectedRoute carries the destination in router state, which survives the
 * client-side hop to /login but not the full-page redirect out to an SSO
 * provider and back — so the password path lands correctly (#1165) while the
 * Google path always ended on /cellars.
 *
 * The destination is stashed here instead, in sessionStorage: scoped to this
 * origin and this tab, it survives the cross-origin round trip. It is the same
 * mechanism the OIDC client libraries use to carry a PKCE verifier across that
 * trip.
 *
 * Deliberately NOT a ?next= query parameter: that would let a crafted link name
 * any destination at all. What ProtectedRoute records is narrower — the path the
 * visitor was already on, which had to match a protected route to get here.
 *
 * Narrower is not the same as trusted, so the validation below is load-bearing
 * rather than decorative. An attacker still chooses the link, and react-router's
 * push falls back to window.location.assign() when pushState throws (which it
 * does for a cross-origin URL), so navigating to a protocol-relative path would
 * genuinely leave the origin. Today no protected route can match one — they are
 * all literal-prefixed and '//evil.example' falls to the unprotected catch-all —
 * but that is a property of the route table, not a guarantee, and it would
 * evaporate the day a wildcard route becomes protected. Hence the checks here.
 */

const STORAGE_KEY = 'cellarion.postLoginRedirect';

// Generous for a deep link with a query string; small enough that the key
// cannot be used as general-purpose storage.
const MAX_LENGTH = 512;

// C0 controls plus DEL. A newline or tab inside a path is never legitimate
// here, and is the classic way to smuggle something past a naive check.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * True for a path that stays inside this app. Rejects anything a browser would
 * resolve to another origin.
 */
export function isSafeInternalPath(path) {
  if (typeof path !== 'string') return false;
  if (path.length === 0 || path.length > MAX_LENGTH) return false;
  if (path[0] !== '/') return false;      // must be root-relative
  if (path[1] === '/') return false;      // //evil.com is protocol-relative
  if (path.includes('\\')) return false;  // browsers fold \ to /, so /\evil.com escapes
  if (CONTROL_CHARS.test(path)) return false;
  return true;
}

/**
 * Record where to return to at the start of a sign-in — and, just as important,
 * clear any earlier destination when this sign-in has none.
 *
 * Skipping instead of clearing would let an abandoned journey be inherited by
 * the next sign-in in the tab: cancel at the provider, come back, sign in
 * plainly, and you would land on the page someone was heading for earlier. On a
 * shared computer that is someone else's cellar.
 */
export function stashPostLoginRedirect(path) {
  try {
    if (isSafeInternalPath(path)) window.sessionStorage.setItem(STORAGE_KEY, path);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage disabled or full. Sign-in still works, it just ends on /cellars —
    // which is what everyone had before this.
  }
}

/**
 * Read the destination and clear it, so a stale value can never redirect a
 * later sign-in. Returns null when there isn't one.
 */
export function takePostLoginRedirect() {
  let value = null;
  try {
    value = window.sessionStorage.getItem(STORAGE_KEY);
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    return null;
  }
  return isSafeInternalPath(value) ? value : null;
}
