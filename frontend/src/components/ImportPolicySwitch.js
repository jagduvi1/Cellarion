import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { adminGetImportPolicy, adminSaveImportPolicy } from '../api/admin';

/**
 * The admin's two switches for how a cellar-file import treats new wines
 * (backend config/importPolicy), shown above the queue the second one fills:
 *
 *   AI look-up       on by default. Off: nothing from a member's file goes to
 *                    an AI provider; an unknown wine is created from the file.
 *   Check new wines  off by default. On: a wine an import creates is visible
 *                    only to its owner until a curator has checked it. It does
 *                    nothing on a server that does not review contributions,
 *                    and the text says so.
 *
 * Where a super admin is configured (cellarion.app) only they may change
 * them; other admins see the state without the buttons.
 */
export default function ImportPolicySwitch({ onChange }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    // An unreachable or older server answers nothing usable: no switches shown.
    Promise.resolve()
      .then(() => adminGetImportPolicy(apiFetch))
      .then((res) => (res && res.ok ? res.json() : null))
      .then((data) => { if (live && data) setState(data); })
      .catch(() => {});
    return () => { live = false; };
  }, [apiFetch]);

  if (!state) return null;

  const save = async (change) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminSaveImportPolicy(apiFetch, change);
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setState((s) => ({ ...s, ...body, checking: body.checkNewWines === true && s.reviewOn !== false }));
        if (onChange) onChange(body);
      } else {
        setError(body.error || t('common.networkError', 'Network error. Please try again.'));
      }
    } catch {
      setError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const checkText = () => {
    if (!state.checkNewWines) {
      return t('admin.importPolicy.checkOff', 'Check new wines: off. A wine an import creates is public as soon as it is created.');
    }
    if (state.reviewOn === false) {
      return t('admin.importPolicy.checkNoReview', 'Check new wines: on, but this server does not review contributions, so imported wines are public at once.');
    }
    return t('admin.importPolicy.checkOn', 'Check new wines: on. A wine an import creates is visible only to its owner until a curator has checked it here.');
  };

  return (
    <div className="alert alert-info" role="region" aria-label={t('admin.importPolicy.title', 'Imports')} style={{ marginBottom: 12 }}>
      <strong>{t('admin.importPolicy.title', 'Imports')}</strong>
      <div style={{ marginTop: '0.25rem' }}>
        {state.aiLookup
          ? t('admin.importPolicy.aiOn', 'AI look-up: on. A wine in a file that the registry does not know is sent to the AI provider to be identified.')
          : t('admin.importPolicy.aiOff', 'AI look-up: off. Nothing from a file is sent to an AI provider. A wine the registry does not know is created from what the file says.')}
      </div>
      <div style={{ marginTop: '0.25rem' }}>
        {checkText()}
        {state.waiting > 0 && (
          <> {t('admin.importPolicy.waiting', '{{n}} wine(s) are waiting for a check.', { n: state.waiting })}</>
        )}
      </div>
      {state.canChange ? (
        <div style={{ marginTop: '0.5rem', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-small btn-secondary" onClick={() => save({ aiLookup: !state.aiLookup })} disabled={busy}>
            {state.aiLookup
              ? t('admin.importPolicy.turnAiOff', 'Turn AI look-up off')
              : t('admin.importPolicy.turnAiOn', 'Turn AI look-up on')}
          </button>
          <button type="button" className="btn btn-small btn-secondary" onClick={() => save({ checkNewWines: !state.checkNewWines })} disabled={busy}>
            {state.checkNewWines
              ? t('admin.importPolicy.turnCheckOff', 'Stop checking new wines')
              : t('admin.importPolicy.turnCheckOn', 'Check new wines before they are public')}
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
