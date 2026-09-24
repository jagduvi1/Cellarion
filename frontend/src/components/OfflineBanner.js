import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { isOfflineModeEnabled } from '../utils/offlineMode';
import { getOfflineStatus, subscribeOfflineStatus } from '../utils/offlineSnapshot';
import './AnnouncementBanner.css';

function formatSavedAt(iso, lang) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  try {
    return {
      today,
      time: d.toLocaleString(lang || undefined, today ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' }),
    };
  } catch {
    return { today, time: d.toLocaleString() };
  }
}

/**
 * "You're offline — this is your saved copy" (#1355). Shown with offline mode
 * on whenever the app is working from the device's copy: the browser reports
 * no network, the session started offline, or a read was just answered from
 * the copy because the network did not. Says how old the copy is.
 */
export default function OfflineBanner() {
  const { t, i18n } = useTranslation();
  const { offlineSession } = useAuth();
  const [status, setStatus] = useState(getOfflineStatus);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));

  useEffect(() => subscribeOfflineStatus(setStatus), []);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  if (!isOfflineModeEnabled()) return null;
  if (online && !offlineSession && !status.usingSaved) return null;

  let text;
  if (status.savedAt) {
    const { today, time } = formatSavedAt(status.savedAt, i18n.language);
    text = today
      ? t('offline.bannerSavedToday', 'Offline — showing your cellar as saved at {{time}}', { time })
      : t('offline.bannerSavedEarlier', 'Offline — showing your cellar as saved on {{time}}', { time });
  } else {
    text = t('offline.bannerNoCopy', "Offline — your cellar hasn't been saved on this device yet");
  }

  return (
    <div className="announcement-banner info offline-banner" role="status">
      <span aria-hidden="true">📴</span>
      <span>{text}</span>
    </div>
  );
}
