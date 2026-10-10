import { useState, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { lazy } from '../utils/lazyWithReload';
import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../utils/featureFlags';
import { betaFeatureText } from '../config/betaFeatures';
import './BetaBadge.css';
import './EarlyAccessSettings.css';

const BetaFeedbackModal = lazy(() => import('./BetaFeedbackModal'));

// How long a feature stays under "Recently released" after it went out to everyone.
const RECENT_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Settings → Early access: the one "Try new features early" switch, and the
 * list of what is in beta now (with "Give feedback" and the testers' forum
 * thread) and what was released lately. The list shows whether the switch is
 * on or off, so anyone can see what they would get. Turning the switch off
 * only changes which screens show: a beta screen saves into the same fields
 * the ordinary ones read, so nothing is lost.
 */
export default function EarlyAccessSettings() {
  const { t, i18n } = useTranslation();
  const { user, updatePreferences } = useAuth();
  const flags = useFeatureFlags();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [feedbackFor, setFeedbackFor] = useState(null);
  // The switch flips at once and goes back if the save fails, rather than
  // sitting unchanged until the server answers.
  const [pending, setPending] = useState(null);
  const on = pending ?? user?.preferences?.earlyAccess === true;

  const day = (iso) => (iso
    ? new Date(iso).toLocaleDateString(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' })
    : '');
  const inBeta = flags.filter((f) => f.state === 'beta');
  const released = flags
    .filter((f) => f.state === 'everyone' && f.releasedAt && Date.now() - Date.parse(f.releasedAt) < RECENT_MS)
    .sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt));

  const toggle = async (next) => {
    setBusy(true);
    setError(null);
    setPending(next);
    const result = await updatePreferences({ earlyAccess: next });
    setBusy(false);
    setPending(null);
    if (!result.success) setError(result.error || t('earlyAccess.saveFailed', 'Could not save. Please try again.'));
  };

  return (
    <div className="card settings-card early-access">
      <h2 className="settings-section-title">{t('earlyAccess.title', 'Try new features early')}</h2>
      <p className="settings-hint">
        {t('earlyAccess.intro', 'Larger changes reach the members who turn this on first, before everyone gets them, so they can be tried and improved with your feedback. Your data is stored the same way either way: turn it off at any time and nothing is lost.')}
      </p>
      <label className="settings-toggle-row">
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => toggle(e.target.checked)} />
        <span>{t('earlyAccess.toggle', 'Show me new features before everyone else')}</span>
      </label>
      {error && <div className="alert alert-error" role="alert">{error}</div>}

      <h3 className="early-access-h3">{t('earlyAccess.inBetaTitle', 'In beta now')}</h3>
      {inBeta.length === 0 ? (
        <p className="settings-hint">{t('earlyAccess.noneInBeta', 'Nothing is in beta right now.')}</p>
      ) : (
        <ul className="early-access-list">
          {inBeta.map((f) => {
            const text = betaFeatureText(t, f.key);
            return (
              <li key={f.key} className="early-access-item">
                <div className="early-access-name">
                  <span className="beta-pill">{t('earlyAccess.badge', 'Beta')}</span> {text.name}
                </div>
                {text.description && <p className="early-access-desc">{text.description}</p>}
                <p className="early-access-meta">
                  {[text.where, f.betaAt ? t('earlyAccess.since', 'In beta since {{date}}', { date: day(f.betaAt) }) : null].filter(Boolean).join(' · ')}
                </p>
                <div className="early-access-actions">
                  {on && !user?.isDemo && (
                    <button type="button" className="btn btn-small btn-secondary" onClick={() => setFeedbackFor(f.key)}>
                      {t('earlyAccess.giveFeedback', 'Give feedback')}
                    </button>
                  )}
                  {f.forumPath && (
                    <Link to={f.forumPath} className="early-access-link">{t('earlyAccess.discuss', 'Discuss with other testers')}</Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {released.length > 0 && (
        <>
          <h3 className="early-access-h3">{t('earlyAccess.releasedTitle', 'Recently released')}</h3>
          <ul className="early-access-list">
            {released.map((f) => (
              <li key={f.key} className="early-access-item">
                <div className="early-access-name">{betaFeatureText(t, f.key).name}</div>
                <p className="early-access-meta">{t('earlyAccess.releasedOn', 'For everyone since {{date}}', { date: day(f.releasedAt) })}</p>
              </li>
            ))}
          </ul>
        </>
      )}

      <Suspense fallback={null}>
        {feedbackFor && <BetaFeedbackModal feature={feedbackFor} onClose={() => setFeedbackFor(null)} />}
      </Suspense>
    </div>
  );
}
