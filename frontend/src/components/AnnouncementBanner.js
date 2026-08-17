import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './AnnouncementBanner.css';

const API_BASE = import.meta.env.VITE_API_URL || '';
const DISMISS_KEY = 'announcementDismissed';
const CACHE_TTL = 60 * 1000;
// How often an OPEN tab re-asks. The banner's whole job is to reach people
// before something happens (a maintenance window, an incident), and fetching
// only on mount meant it reached nobody who already had the app open —
// found 2026-08-17, when a live banner was invisible to exactly the person
// who had been sitting on the page. Comfortably longer than CACHE_TTL, so
// each poll actually re-asks rather than reading its own cache.
const POLL_MS = 5 * 60 * 1000;

// Module-level cache: Layout remounts on every route change, but the banner
// endpoint only needs to be asked about once a minute.
let cached = null;
let cachedAt = 0;

async function fetchAnnouncement() {
  if (cached !== null && Date.now() - cachedAt < CACHE_TTL) return cached;
  try {
    const res = await fetch(`${API_BASE}/api/site/announcement`);
    if (res.ok) {
      cached = await res.json();
      cachedAt = Date.now();
    } else if (cached === null) {
      // Never had an answer — treat as "no banner" but do NOT start the
      // cache clock, so the next poll retries rather than waiting a minute.
      cached = { enabled: false };
    }
  } catch {
    // A transient network blip must not TAKE DOWN a banner that is already
    // showing: keep whatever we last knew. Only the first-ever failure
    // resolves to "no banner" (see above). This matters more with polling
    // than it did with a single fetch — one dropped request in five minutes
    // would otherwise blink the notice off the page.
    if (cached === null) cached = { enabled: false };
  }
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
    const load = () => fetchAnnouncement().then(a => { if (!cancelled) setAnnouncement(a); });
    load();

    // Poll, so a banner raised while someone is mid-session still reaches
    // them. Both triggers go through the same CACHE_TTL-respecting fetch, so
    // a tab that is switched to repeatedly cannot spam the endpoint.
    const timer = setInterval(load, POLL_MS);
    // Returning to the tab is the moment a stale banner is most likely and
    // most wanted — a user coming back after an hour gets the current state
    // without waiting out the interval.
    const onVisibility = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
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
