import { useSyncExternalStore } from 'react';
import { useAuth } from '../contexts/AuthContext';

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
 * The list is fetched once per page load, shared by every component, and
 * remembered in localStorage so a reload (or an offline start) shows the same
 * screens before the answer arrives. Without any answer every flag is off:
 * the classic screens are the safe default.
 */

const API_BASE = import.meta.env.VITE_API_URL || '';
const STORE_KEY = 'cellarion-feature-flags';

function readCached() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

let flags = readCached();
let loading = null;
const listeners = new Set();

function emit() {
  for (const l of listeners) l();
}

/** Fetch the list (once per page load unless forced). Never throws. */
export function loadFeatureFlags({ force = false } = {}) {
  if (loading && !force) return loading;
  try {
    loading = fetch(`${API_BASE}/api/site/features`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !Array.isArray(data.features)) return;
        flags = data.features;
        try { localStorage.setItem(STORE_KEY, JSON.stringify(flags)); } catch { /* private mode */ }
        emit();
      })
      .catch(() => { /* offline or down: keep what we had */ });
  } catch {
    loading = Promise.resolve();
  }
  return loading;
}

function subscribe(listener) {
  listeners.add(listener);
  if (!loading) loadFeatureFlags();
  return () => listeners.delete(listener);
}

const getSnapshot = () => flags;

/** Every flagged feature in beta or out for everyone: [{ key, state, betaAt, releasedAt, forumPath }]. */
export function useFeatureFlags() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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

/** Test seam: replace the list and notify subscribers. */
export function __setFeatureFlagsForTest(next) {
  flags = Array.isArray(next) ? next : [];
  loading = Promise.resolve();
  emit();
}
