import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { adminGetContributionReview, adminSaveContributionReview } from '../api/admin';
import { setContributionReviewed } from '../utils/contributionReview';

/**
 * The admin's switch for reviewing contributions (backend
 * config/contributionReview), shown above the queues it empties: Image
 * Review and Data Fields. On by default. Off suits a private server whose
 * members all trust each other (a household on its own install, discussion
 * #1778): photos, fixes, values and new fields then go live as they are made.
 * Turning it off decides nothing already waiting — the queues say so.
 *
 * Where a super admin is configured (cellarion.app) only they may change it;
 * other admins see the state without the button.
 */
export default function ContributionReviewSwitch() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    // An unreachable or older server answers nothing usable: no switch shown.
    Promise.resolve()
      .then(() => adminGetContributionReview(apiFetch))
      .then((res) => (res && res.ok ? res.json() : null))
      .then((data) => { if (live && data) setState(data); })
      .catch(() => {});
    return () => { live = false; };
  }, [apiFetch]);

  if (!state) return null;

  const waiting = state.waiting || {};
  const waitingTotal = (waiting.photos || 0) + (waiting.values || 0) + (waiting.fields || 0) + (waiting.corrections || 0);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminSaveContributionReview(apiFetch, !state.enabled);
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setState((s) => ({ ...s, ...body }));
        setContributionReviewed(body.enabled);
      } else {
        setError(body.error || t('common.networkError', 'Network error. Please try again.'));
      }
    } catch {
      setError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`alert ${state.enabled ? 'alert-info' : 'alert-warning'}`} role="region" aria-label={t('admin.contributionReview.title', 'Review of contributions')}>
      <strong>{t('admin.contributionReview.title', 'Review of contributions')}: </strong>
      {state.enabled
        ? t('admin.contributionReview.on', 'On. Photos, wine-record fixes, values and new data fields from members wait here until an admin decides them.')
        : t('admin.contributionReview.off', 'Off. Photos, wine-record fixes, values and new data fields go live as soon as a member adds them. A fix that needs a choice (a merge, a producer spelled two ways) still waits.')}
      {' '}
      <span>{t('admin.contributionReview.hint', 'Turn it off only on a private server where everyone trusts each other.')}</span>
      {!state.enabled && waitingTotal > 0 && (
        <> {t('admin.contributionReview.stillWaiting', '{{count}} items from before are still waiting to be decided.', { count: waitingTotal })}</>
      )}
      {state.canChange ? (
        <div style={{ marginTop: '0.5rem' }}>
          <button type="button" className="btn btn-small btn-secondary" onClick={toggle} disabled={busy}>
            {state.enabled
              ? t('admin.contributionReview.turnOff', 'Turn review off')
              : t('admin.contributionReview.turnOn', 'Turn review on')}
          </button>
        </div>
      ) : (
        <div style={{ marginTop: '0.5rem' }}>
          {t('admin.contributionReview.superOnly', 'Only the super admin can change this on this server.')}
        </div>
      )}
      {error && <div role="alert" style={{ marginTop: '0.5rem' }}>{error}</div>}
    </div>
  );
}
