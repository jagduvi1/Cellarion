import { useSyncExternalStore } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { API_URL } from '../api/apiConstants';

/**
 * Feature flags on the client (backend config/featureFlags).
 *
 * The server answers which flagged features are in beta or out for everyone
 * (GET /api/site/features, public, cached 60 s); the user's own "Try new
 * features early" switch is preferences.earlyAccess. A feature is on when it
 * is out for everyone, or in beta and the user opted in. Switching early
 * access in Settings flips the screens at once — the preference save replaces
 * the user in AuthContext, and every useFeature re-reads it.
 *
 * The list is fetched when the app starts, shared by every component, and
 * remembered in localStorage so a reload (or an offline start) shows the same
 * screens before the answer arrives. An open tab re-asks every few minutes
 * and whenever it comes back into view, so a flag switched off by a super
 * admin reaches sessions that stay open (release audit 2026-10-10). Without
 * any answer every flag is off: the classic screens are the safe default.
 */

const STORE_KEY = 'cellarion-feature-flags';
const POLL_MS = 5 * 60 * 1000;

function readCached() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const cached = readCached();
let flags = cached || [];
// True once the app knows the flags: a cached copy counts, else the first
// answer (or failure) from the server. Until then a page that depends on a
// flag waits rather than rendering one layout and switching to the other.
let ready = cached !== null;
let loading = null;
let watching = false;
const listeners = new Set();

function emit() {
  for (const l of listeners) l();
}

/** Fetch the list (once per page load unless forced). Never throws. */
export function loadFeatureFlags({ force = false } = {}) {
  if (loading && !force) return loading;
  try {
    loading = fetch(`${API_URL}/api/site/features`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !Array.isArray(data.features)) return;
        flags = data.features;
        try { localStorage.setItem(STORE_KEY, JSON.stringify(flags)); } catch { /* private mode */ }
      })
      .catch(() => { /* offline or down: keep what we had */ })
      .finally(() => { ready = true; emit(); });
  } catch {
    loading = Promise.resolve();
    ready = true;
    emit();
  }
  return loading;
}

// Re-ask while the app stays open: on a timer, and when the tab comes back
// into view (a phone that was in a pocket). Installed once, on first use.
function watch() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  try {
    setInterval(() => { if (document.visibilityState !== 'hidden') loadFeatureFlags({ force: true }); }, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') loadFeatureFlags({ force: true });
    });
  } catch { /* no document */ }
}

function subscribe(listener) {
  listeners.add(listener);
  if (!loading) loadFeatureFlags();
  watch();
  return () => listeners.delete(listener);
}

const getSnapshot = () => flags;
const getReady = () => ready;

/** Every flagged feature in beta or out for everyone: [{ key, state, betaAt, releasedAt, forumPath }]. */
export function useFeatureFlags() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Whether the app knows its flags yet (a cached copy, or the first answer). */
export function useFeatureFlagsReady() {
  return useSyncExternalStore(subscribe, getReady, getReady);
}

/** Is this feature on for a user with early access on/off, given the list? */
export function isFeatureOn(list, key, earlyAccess) {
  const f = (list || []).find((x) => x.key === key);
  if (!f) return false;
  return f.state === 'everyone' || (f.state === 'beta' && earlyAccess === true);
}

/** Whether the signed-in user sees a flagged feature. */
export function useFeature(key) {
  const list = useFeatureFlags();
  const { user } = useAuth();
  return isFeatureOn(list, key, user?.preferences?.earlyAccess === true);
}

/** Test seam: replace the list, mark the flags known, and notify subscribers. */
export function __setFeatureFlagsForTest(next, { known = true } = {}) {
  flags = Array.isArray(next) ? next : [];
  loading = known ? Promise.resolve() : null;
  ready = known;
  emit();
}
