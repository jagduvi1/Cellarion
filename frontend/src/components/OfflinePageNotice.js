import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { OFFLINE_MODE_RELEASED } from '../utils/offlineMode';

/**
 * Shown instead of a page that needs the network while the device is offline
 * (Layout) — a calm "this needs a connection" rather than the page's own
 * "Network error". The page loads by itself once the connection is back
 * (Layout renders it again on the 'online' event). With offline mode on, it
 * points to what does work offline.
 */
export default function OfflinePageNotice({ modeOn }) {
  const { t } = useTranslation();
  return (
    <div className="card" role="status" style={{ maxWidth: 560, margin: '2.5rem auto', padding: '1.75rem', textAlign: 'center' }}>
      <div aria-hidden="true" style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📴</div>
      <h2 style={{ margin: '0 0 0.5rem' }}>{t('offline.page.title', "You're offline")}</h2>
      <p style={{ margin: '0 0 0.5rem' }}>
        {t('offline.page.needsConnection', 'This page needs an internet connection. It will load by itself as soon as you are back online.')}
      </p>
      {modeOn ? (
        <>
          <p style={{ margin: '0 0 1rem', opacity: 0.85 }}>
            {t('offline.page.whatWorks', 'Your cellars, racks and bottles are saved on this device and work offline.')}
          </p>
          <Link to="/cellars" className="btn btn-primary">{t('offline.page.toCellars', 'Go to my cellars')}</Link>
        </>
      ) : OFFLINE_MODE_RELEASED && (
        <p style={{ margin: 0, opacity: 0.85 }}>
          {t('offline.page.modeHint', 'Turn on offline mode in Settings to keep your cellar available without a connection.')}
        </p>
      )}
    </div>
  );
}
