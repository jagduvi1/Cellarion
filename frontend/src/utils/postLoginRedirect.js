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
 * Deliberately NOT a ?next= query parameter, which would put the destination
 * into a crafted link and turn the auth path into an open redirect. As with
 * router state, nothing here is ever read from a URL — the only writer is our
 * own code, passing a value ProtectedRoute produced. The validation below is
 * therefore belt-and-braces rather than the primary defence, but it is cheap,
 * and it keeps the guarantee inside this file rather than resting on an
 * argument about every call site.
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
 * Remember where to return to. Silently ignores anything unsafe or absent — no
 * destination is the normal case (a plain visit to /login), and the caller has
 * nothing useful to do about it.
 */
export function stashPostLoginRedirect(path) {
  if (!isSafeInternalPath(path)) return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, path);
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
