import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { isOfflineModeEnabled, OFFLINE_MODE_EVENT } from './offlineMode';

/**
 * Pages that work offline, from the device's copy (#1355, utils/offlineData):
 * the cellar list, a cellar, its racks, a bottle — and Settings, where offline
 * mode itself is switched. Everything else needs the network.
 */
const OFFLINE_PAGES = [
  /^\/cellars\/?$/,
  /^\/cellars\/[a-f0-9]{24}\/?$/,
  /^\/cellars\/[a-f0-9]{24}\/racks\/?$/,
  /^\/cellars\/[a-f0-9]{24}\/bottles\/[a-f0-9]{24}\/?$/,
  /^\/settings\/?$/,
];

export function isOfflineCapablePage(pathname) {
  return OFFLINE_PAGES.some((re) => re.test(String(pathname || '')));
}

/**
 * { offline, modeOn }: whether the app is offline right now — the browser
 * reports no network, or the session started offline — and whether offline
 * mode is on. Re-renders on online/offline and when the switch changes.
 */
export function useOfflineNow() {
  const { offlineSession } = useAuth();
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const [, setTick] = useState(0);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    const mode = () => setTick((n) => n + 1);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    window.addEventListener(OFFLINE_MODE_EVENT, mode);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      window.removeEventListener(OFFLINE_MODE_EVENT, mode);
    };
  }, []);
  const modeOn = isOfflineModeEnabled();
  return { offline: !online || (modeOn && !!offlineSession), modeOn };
}
