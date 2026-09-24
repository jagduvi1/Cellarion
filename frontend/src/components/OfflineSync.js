import { useEffect } from 'react';
import { useAuth, API_MUTATION_EVENT } from '../contexts/AuthContext';
import { isOfflineModeEnabled } from '../utils/offlineMode';
import { getOfflineStatus, primeOfflineStatus, refreshSnapshot } from '../utils/offlineSnapshot';
import { flushQueue, getQueueStatus, refreshQueueStatus, QUEUE_CHANGED_EVENT } from '../utils/offlineQueue';

const REFRESH_EVERY_MS = 15 * 60 * 1000;
const STALE_ON_START_MS = 2 * 60 * 1000;
const AFTER_CHANGE_MS = 4000;
const RESEND_EVERY_MS = 30 * 1000;

const ageOf = () => {
  const { savedAt } = getOfflineStatus();
  return savedAt ? Date.now() - Date.parse(savedAt) : Infinity;
};

/**
 * Keeps the device's offline copy of the user's cellars fresh (#1355):
 * on start when it is more than a couple of minutes old, every 15 minutes
 * while the app is visible, when the app comes back to the foreground after
 * that long, and a few seconds after the user changes something. Online and
 * signed in only; renders nothing. Mounted once, in App.
 */
export default function OfflineSync() {
  const { user, token, offlineSession, apiFetch } = useAuth();
  const userId = user ? String(user.id || user._id || '') || null : null;
  const enabled = isOfflineModeEnabled();
  const live = enabled && !!userId && !!token && !offlineSession;

  // The banner's "saved at" time and change counts, from the device alone
  // (works offline too).
  useEffect(() => {
    if (enabled && userId) {
      primeOfflineStatus(userId);
      refreshQueueStatus(userId);
    }
  }, [enabled, userId]);

  // Send changes made offline: now, when the network returns, when a change is
  // queued, and every 30 s while any wait (a 5xx or a busy server).
  useEffect(() => {
    if (!live) return undefined;
    const send = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      flushQueue(apiFetch, userId);
    };
    send();
    const timer = setInterval(() => { if (getQueueStatus().pending > 0) send(); }, RESEND_EVERY_MS);
    window.addEventListener('online', send);
    window.addEventListener(QUEUE_CHANGED_EVENT, send);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', send);
      window.removeEventListener(QUEUE_CHANGED_EVENT, send);
    };
  }, [live, userId, apiFetch]);

  useEffect(() => {
    if (!live) return undefined;
    let stopped = false;
    let debounce;
    const refresh = () => {
      if (stopped || document.visibilityState === 'hidden') return;
      refreshSnapshot(apiFetch, userId);
    };
    primeOfflineStatus(userId).then(() => { if (ageOf() > STALE_ON_START_MS) refresh(); });

    const timer = setInterval(refresh, REFRESH_EVERY_MS);
    const onVisible = () => { if (document.visibilityState === 'visible' && ageOf() > REFRESH_EVERY_MS) refresh(); };
    const onMutation = () => { clearTimeout(debounce); debounce = setTimeout(refresh, AFTER_CHANGE_MS); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(API_MUTATION_EVENT, onMutation);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(debounce);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(API_MUTATION_EVENT, onMutation);
    };
  }, [live, userId, apiFetch]);

  return null;
}
