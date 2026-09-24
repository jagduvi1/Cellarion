import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { isOfflineModeEnabled } from '../utils/offlineMode';
import { getOfflineStatus, subscribeOfflineStatus } from '../utils/offlineSnapshot';
import { getQueueStatus, subscribeQueueStatus } from '../utils/offlineQueue';
import OfflineAttentionModal from './OfflineAttentionModal';
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
 * Offline mode status (#1355), shown with offline mode on:
 *  - "Offline — showing your cellar as saved at …" while the app works from
 *    the device's copy (no network, an offline start, or a read the network
 *    didn't answer);
 *  - how many changes made offline are waiting to be sent;
 *  - how many need the user's decision, with a Review button.
 */
export default function OfflineBanner() {
  const { t, i18n } = useTranslation();
  const { user, offlineSession } = useAuth();
  const [status, setStatus] = useState(getOfflineStatus);
  const [queue, setQueue] = useState(getQueueStatus);
  const [reviewing, setReviewing] = useState(false);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));

  useEffect(() => subscribeOfflineStatus(setStatus), []);
  useEffect(() => subscribeQueueStatus(setQueue), []);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  if (!isOfflineModeEnabled()) return null;
  const offline = !online || offlineSession || status.usingSaved;
  if (!offline && !queue.pending && !queue.attention) return null;

  let copyText = null;
  if (offline) {
    if (status.savedAt) {
      const { today, time } = formatSavedAt(status.savedAt, i18n.language);
      copyText = today
        ? t('offline.bannerSavedToday', 'Offline — showing your cellar as saved at {{time}}', { time })
        : t('offline.bannerSavedEarlier', 'Offline — showing your cellar as saved on {{time}}', { time });
    } else {
      copyText = t('offline.bannerNoCopy', "Offline — your cellar hasn't been saved on this device yet");
    }
  }

  return (
    <>
      <div className={`announcement-banner ${queue.attention ? 'warning' : 'info'} offline-banner`} role="status">
        <span aria-hidden="true">{offline ? '📴' : '🔄'}</span>
        <span>
          {copyText}
          {copyText && (queue.pending > 0 || queue.attention > 0) ? ' · ' : ''}
          {queue.pending > 0 && (queue.syncing
            ? t('offline.syncing', { count: queue.pending })
            : t('offline.pending', { count: queue.pending }))}
          {queue.pending > 0 && queue.attention > 0 ? ' · ' : ''}
          {queue.attention > 0 && t('offline.attention', { count: queue.attention })}
        </span>
        {queue.attention > 0 && (
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setReviewing(true)}>
            {t('offline.review', 'Review')}
          </button>
        )}
      </div>
      {reviewing && user && (
        <OfflineAttentionModal userId={String(user.id || user._id)} onClose={() => setReviewing(false)} />
      )}
    </>
  );
}
