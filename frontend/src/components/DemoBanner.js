import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import './AnnouncementBanner.css';
import './DemoBanner.css';

/**
 * Persistent, non-dismissible banner shown for the whole ephemeral demo session.
 * Driven purely by user.isDemo (stamped by the backend on the demo JWT), it warns
 * the visitor their changes reset and points them at signup — the conversion
 * surface. Because a demo user is authenticated, "create your own cellar" must
 * first end the demo session (else the /login route bounces an authed user back
 * to /cellars); demo→real upgrade is a later enhancement.
 */
function DemoBanner() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [now, setNow] = useState(() => Date.now());

  const isDemo = !!user?.isDemo;

  useEffect(() => {
    if (!isDemo) return undefined;
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, [isDemo]);

  if (!isDemo) return null;

  // Optional "resets in ~N min" hint when the backend supplied an expiry.
  let remaining = null;
  if (user.demoExpiresAt) {
    const ms = new Date(user.demoExpiresAt).getTime() - now;
    if (Number.isFinite(ms) && ms > 0) remaining = Math.max(1, Math.round(ms / 60000));
  }

  const signUp = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="announcement-banner info demo-banner" role="status">
      <span className="announcement-icon" aria-hidden="true">🍷</span>
      <span className="announcement-text">
        {remaining != null
          ? t('demo.bannerTextTimed', { minutes: remaining })
          : t('demo.bannerText')}
      </span>
      <button type="button" className="demo-banner-cta" onClick={signUp}>
        {t('demo.bannerCta')}
      </button>
    </div>
  );
}

export default DemoBanner;
