/**
 * Offline mode (#1355): keep the app and the signed-in session usable when the
 * device has no network (a cellar in a basement).
 *
 * Off until the user chooses it — nothing is stored on a device before they
 * say yes (storage on a user's device needs their request: ePrivacy art. 5(3)).
 * The installed app (standalone / the Android TWA) asks once, after sign-in
 * (components/OfflinePrompt); anywhere, Settings → Offline mode switches it
 * (components/OfflineSettings). The choice is stored per browser.
 *
 * What it switches on (this module is the only switch):
 *  - the service worker keeps the whole app for offline use (public/service-worker.js)
 *  - a network failure at startup keeps the last signed-in profile instead of
 *    showing the login page (contexts/AuthContext.js, below)
 */
export const OFFLINE_MODE_RELEASED = true;

const PREF_KEY = 'cellarion-offline';          // 'on' | 'off' | absent (default)
const USER_KEY = 'cellarion-offline-user';
// The Android app is only recognisable on its first page load (the
// android-app:// referrer; a reload loses it), so once seen it is remembered.
const INSTALLED_KEY = 'cellarion-installed-app';

function readPref() {
  try { return localStorage.getItem(PREF_KEY); } catch { return null; }
}

export function isStandaloneApp() {
  try {
    const now = window.matchMedia?.('(display-mode: standalone)').matches
      || window.navigator.standalone === true                         // iOS home screen
      || document.referrer.startsWith('android-app://');              // Android TWA
    if (now) {
      try { localStorage.setItem(INSTALLED_KEY, '1'); } catch { /* noop */ }
      return true;
    }
    return localStorage.getItem(INSTALLED_KEY) === '1';
  } catch {
    return false;
  }
}

export function isOfflineModeEnabled() {
  return OFFLINE_MODE_RELEASED && readPref() === 'on';
}

/** The installed app, and the user hasn't chosen yet: ask once (OfflinePrompt). */
export function needsOfflineChoice() {
  const pref = readPref();
  return OFFLINE_MODE_RELEASED && pref !== 'on' && pref !== 'off' && isStandaloneApp();
}

/** 'on' / 'off' for this browser; null returns to the default. */
export function setOfflineModePreference(value) {
  try {
    if (value === 'on' || value === 'off') localStorage.setItem(PREF_KEY, value);
    else localStorage.removeItem(PREF_KEY);
  } catch { /* storage blocked — the default applies */ }
  if (!isOfflineModeEnabled()) {
    clearOfflineUser();
    // Loaded on demand: offlineSnapshot imports this module.
    import('./offlineSnapshot').then((m) => m.clearOfflineData()).catch(() => {});
  }
  // Components that read the switch at render (banner, sync) re-render.
  try { window.dispatchEvent(new Event(OFFLINE_MODE_EVENT)); } catch { /* noop */ }
  return syncOfflineShell();
}

/** Fired when the switch changes (setOfflineModePreference). */
export const OFFLINE_MODE_EVENT = 'cellarion-offline-mode';

/**
 * Tell the service worker to keep (or drop) the offline copy of the app.
 * Resolves to true when the current build is fully stored for offline use.
 */
export async function syncOfflineShell() {
  try {
    if (!('serviceWorker' in navigator)) return false;
    // ready never settles when registration failed (blocked service workers,
    // dev) — don't wait on it forever.
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
    ]);
    const worker = reg?.active;
    if (!worker) return false;
    const enable = isOfflineModeEnabled();
    return await new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(false), 120000);
      channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(!!e.data?.ok); };
      worker.postMessage({ type: enable ? 'offline-enable' : 'offline-disable' }, [channel.port2]);
    });
  } catch {
    return false;
  }
}

// ── The signed-in profile, kept for an offline start ──────────────────────
// Only what the UI needs to render as this user. Not kept: email, bio, consent
// records, and isSuperAdmin (the server grants that per request and IP — it
// must never be replayed from storage). No token is ever stored.
const KEPT_FIELDS = [
  '_id', 'id', 'username', 'displayName', 'roles', 'plan', 'planExpiresAt',
  'preferences', 'isDemo', 'demoExpiresAt', 'hasPassword', 'profileVisibility',
  'deletionScheduledFor',
];

// An offline start is only allowed for a "remember me" session (one that
// survives closing the browser — a shared computer's browser-only session must
// not reopen offline for the next person) that the server confirmed within the
// refresh cookie's lifetime.
const OFFLINE_START_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function saveOfflineUser(user, { persistent = false } = {}) {
  if (!user || !isOfflineModeEnabled()) return;
  if (!persistent) { clearOfflineUser(); return; }
  const kept = { _verifiedAt: Date.now() };
  for (const k of KEPT_FIELDS) if (user[k] !== undefined) kept[k] = user[k];
  try { localStorage.setItem(USER_KEY, JSON.stringify(kept)); } catch { /* quota / blocked */ }
}

export function loadOfflineUser() {
  if (!isOfflineModeEnabled()) return null;
  try {
    const u = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    if (!u || typeof u !== 'object' || typeof u.username !== 'string') return null;
    if (!(Date.now() - Number(u._verifiedAt) < OFFLINE_START_MAX_AGE_MS)) return null;
    const { _verifiedAt, ...user } = u;
    return user;
  } catch {
    return null;
  }
}

// A logout made with no network could not end the server session; this marks
// it so the next start ends it before anything else (AuthContext).
const PENDING_LOGOUT_KEY = 'cellarion-pending-logout';
export function markPendingLogout(on) {
  try { if (on) localStorage.setItem(PENDING_LOGOUT_KEY, '1'); else localStorage.removeItem(PENDING_LOGOUT_KEY); } catch { /* noop */ }
}
export function hasPendingLogout() {
  try { return localStorage.getItem(PENDING_LOGOUT_KEY) === '1'; } catch { return false; }
}

export function clearOfflineUser() {
  try { localStorage.removeItem(USER_KEY); } catch { /* noop */ }
}
