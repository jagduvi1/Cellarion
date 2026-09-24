/**
 * Offline mode (#1355): keep the app and the signed-in session usable when the
 * device has no network (a cellar in a basement).
 *
 * NOT RELEASED YET. Until OFFLINE_MODE_RELEASED is flipped, it is on only when
 * explicitly switched on for this browser:
 *     localStorage.setItem('cellarion-offline', 'on')   // then reload
 * When released, the default becomes: on in the installed app (standalone /
 * the Android TWA), off in a plain browser tab — a shared or borrowed computer
 * should not keep a copy of someone's cellar unless they ask for it.
 *
 * What it switches on (this module is the only switch):
 *  - the service worker keeps the whole app for offline use (public/service-worker.js)
 *  - a network failure at startup keeps the last signed-in profile instead of
 *    showing the login page (contexts/AuthContext.js, below)
 */
export const OFFLINE_MODE_RELEASED = false;

const PREF_KEY = 'cellarion-offline';          // 'on' | 'off' | absent (default)
const USER_KEY = 'cellarion-offline-user';

function readPref() {
  try { return localStorage.getItem(PREF_KEY); } catch { return null; }
}

export function isStandaloneApp() {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    if (window.navigator.standalone === true) return true;            // iOS home screen
    return document.referrer.startsWith('android-app://');             // Android TWA
  } catch {
    return false;
  }
}

export function isOfflineModeEnabled() {
  const pref = readPref();
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return OFFLINE_MODE_RELEASED && isStandaloneApp();
}

/** 'on' / 'off' for this browser; null returns to the default. */
export function setOfflineModePreference(value) {
  try {
    if (value === 'on' || value === 'off') localStorage.setItem(PREF_KEY, value);
    else localStorage.removeItem(PREF_KEY);
  } catch { /* storage blocked — the default applies */ }
  if (!isOfflineModeEnabled()) clearOfflineUser();
  return syncOfflineShell();
}

/**
 * Tell the service worker to keep (or drop) the offline copy of the app.
 * Resolves to true when the current build is fully stored for offline use.
 */
export async function syncOfflineShell() {
  try {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    const worker = reg.active;
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

export function saveOfflineUser(user) {
  if (!user || !isOfflineModeEnabled()) return;
  const kept = {};
  for (const k of KEPT_FIELDS) if (user[k] !== undefined) kept[k] = user[k];
  try { localStorage.setItem(USER_KEY, JSON.stringify(kept)); } catch { /* quota / blocked */ }
}

export function loadOfflineUser() {
  if (!isOfflineModeEnabled()) return null;
  try {
    const u = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    return u && typeof u === 'object' && typeof u.username === 'string' ? u : null;
  } catch {
    return null;
  }
}

export function clearOfflineUser() {
  try { localStorage.removeItem(USER_KEY); } catch { /* noop */ }
}
