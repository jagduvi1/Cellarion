// "Your session ended" — remembered for the one login page that follows.
//
// When the server refuses to renew a session that was in use (the access token
// expired and the refresh was rejected), the app signs out and the protected
// page sends the person to /login. That page used to look exactly like a fresh
// visit, so it read as "the app threw me out". The flag lives in sessionStorage
// (this tab only); the login page shows it until the next sign-in clears it
// (AuthContext.applySession). A sign-out you chose clears sessionStorage.

const KEY = 'cellarion.sessionExpired';

export function markSessionExpired() {
  try { sessionStorage.setItem(KEY, '1'); } catch { /* not remembered — the login page just won't explain */ }
}

/** Whether the last session in this tab ended on the server's refusal. */
export function wasSessionExpired() {
  try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; }
}

/** Forget it — called when a session starts again. */
export function clearSessionExpired() {
  try { sessionStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
