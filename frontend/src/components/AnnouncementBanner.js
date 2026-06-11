import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './AnnouncementBanner.css';

const API_BASE = import.meta.env.VITE_API_URL || '';
const DISMISS_KEY = 'announcementDismissed';
const CACHE_TTL = 60 * 1000;

// Module-level cache: Layout remounts on every route change, but the banner
// endpoint only needs to be asked about once a minute.
let cached = null;
let cachedAt = 0;

async function fetchAnnouncement() {
  if (cached !== null && Date.now() - cachedAt < CACHE_TTL) return cached;
  try {
    const res = await fetch(`${API_BASE}/api/site/announcement`);
    cached = res.ok ? await res.json() : { enabled: false };
  } catch {
    cached = { enabled: false };
  }
  cachedAt = Date.now();
  return cached;
}

/**
 * Site-wide banner managed from SuperAdmin → Announcement. Used to announce
 * planned maintenance ahead of time. Dismissal is remembered per message
 * version (updatedAt), so an edited announcement shows up again.
 */
function AnnouncementBanner() {
  const { t, i18n } = useTranslation();
  const [announcement, setAnnouncement] = useState(null);
  const [dismissedVersion, setDismissedVersion] = useState(
    () => localStorage.getItem(DISMISS_KEY)
  );

  useEffect(() => {
    let cancelled = false;
    fetchAnnouncement().then(a => { if (!cancelled) setAnnouncement(a); });
    return () => { cancelled = true; };
  }, []);

  if (!announcement?.enabled || !announcement.message) return null;
  if (announcement.updatedAt && announcement.updatedAt === dismissedVersion) return null;

  const isSwedish = (i18n.language || '').startsWith('sv');
  const text = (isSwedish && announcement.messageSv) || announcement.message;

  const dismiss = () => {
    const version = announcement.updatedAt || 'unknown';
    localStorage.setItem(DISMISS_KEY, version);
    setDismissedVersion(version);
  };

  return (
    <div className={`announcement-banner ${announcement.type === 'warning' ? 'warning' : 'info'}`} role="status">
      <span className="announcement-icon" aria-hidden="true">
        {announcement.type === 'warning' ? '⚠️' : 'ℹ️'}
      </span>
      <span className="announcement-text">{text}</span>
      <button
        className="announcement-dismiss"
        onClick={dismiss}
        aria-label={t('announcement.dismiss')}
        title={t('announcement.dismiss')}
      >
        ×
      </button>
    </div>
  );
}

export default AnnouncementBanner;
