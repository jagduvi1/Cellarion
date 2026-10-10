import { useState, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { lazy } from '../utils/lazyWithReload';
import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../utils/featureFlags';
import './BetaBadge.css';

const BetaFeedbackModal = lazy(() => import('./BetaFeedbackModal'));

/**
 * The strip a feature in early access carries: a "Beta" pill, one line on
 * what is new here, "Give feedback" (a support ticket about this feature)
 * and, when a super admin linked one, the forum thread where testers talk.
 * Renders only while the feature is in beta — once it is out for everyone
 * the strip goes with the flag.
 */
export default function BetaBadge({ feature, note }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const flags = useFeatureFlags();
  const [open, setOpen] = useState(false);
  const flag = flags.find((f) => f.key === feature);
  if (!flag || flag.state !== 'beta') return null;

  return (
    <div className="beta-strip" role="note">
      <span className="beta-pill">{t('earlyAccess.badge', 'Beta')}</span>
      <span className="beta-strip-text">{note || t('earlyAccess.badgeNote', 'You are trying this early.')}</span>
      <span className="beta-strip-actions">
        {/* Demo accounts cannot file tickets (and are gone within the hour). */}
        {!user?.isDemo && (
          <button type="button" className="beta-strip-btn" onClick={() => setOpen(true)}>
            {t('earlyAccess.giveFeedback', 'Give feedback')}
          </button>
        )}
        {flag.forumPath && (
          <Link to={flag.forumPath} className="beta-strip-link">{t('earlyAccess.discuss', 'Discuss with other testers')}</Link>
        )}
      </span>
      <Suspense fallback={null}>
        {open && <BetaFeedbackModal feature={feature} onClose={() => setOpen(false)} />}
      </Suspense>
    </div>
  );
}
