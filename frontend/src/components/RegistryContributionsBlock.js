import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getRegistryContributions, contributeWines } from '../api/bridge';
import { messageForResponse } from '../utils/friendlyError';

// Settings → Shared wine registry, for this install's admins: the wines made
// on this install that the shared registry does not have, the one action
// that offers them all, and what became of the ones offered before
// (backend services/registryContributionOps). Mounted by
// RegistryConnectionSection only while the install is connected.
export default function RegistryContributionsBlock({ onChanged }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [overview, setOverview] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const res = await getRegistryContributions(apiFetch);
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }, [apiFetch]);

  useEffect(() => {
    let ignore = false;
    load().then((data) => { if (!ignore) setOverview(data); }).catch(() => {
      if (!ignore) setError(t('settings.registryContributions.errorLoad', 'Failed to read the wines offered to the shared registry.'));
    });
    return () => { ignore = true; };
  }, [load, t]);

  if (!overview || !overview.enabled) return error ? <div className="alert alert-error">{error}</div> : null;
  const counts = overview.counts || {};
  const attention = overview.attention || [];
  const hasHistory = Object.values(counts).some((v) => v > 0);
  if (!overview.offerable && !hasHistory) return null;

  const contributeAll = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const fallback = t('settings.registryContributions.errorOffer', 'The wines could not be offered right now. Please try again.');
    try {
      const res = await contributeWines(apiFetch, { all: true });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(messageForResponse(res, body, fallback, t));
        return;
      }
      setConfirming(false);
      setNotice(body.queued
        ? t('settings.registryContributions.queuedNotice', '{{count}} wines offered. They are sent as far as today\'s allowance reaches, and the rest follow hourly.', { count: body.queued })
        : t('settings.registryContributions.nothingQueued', 'Nothing was offered: every wine made here has been offered already.'));
      setOverview(await load());
      // The card's quota line counts these too.
      if (onChanged) onChanged();
    } catch {
      setError(fallback);
    } finally {
      setBusy(false);
    }
  };

  const parts = [
    counts.queued ? t('settings.registryContributions.countQueued', '{{count}} waiting to be sent', { count: counts.queued }) : null,
    counts.sent ? t('settings.registryContributions.countSent', '{{count}} waiting for review on cellarion.app', { count: counts.sent }) : null,
    counts.declined ? t('settings.registryContributions.countDeclined', '{{count}} declined', { count: counts.declined }) : null,
    counts.duplicate ? t('settings.registryContributions.countDuplicate', '{{count}} already copied here', { count: counts.duplicate }) : null,
    counts.failed ? t('settings.registryContributions.countFailed', '{{count}} not accepted as sent', { count: counts.failed }) : null,
  ].filter(Boolean);

  const reasonFor = (w) => {
    if (w.status === 'duplicate') return t('settings.registryContributions.reasonDuplicate', 'approved, and this install already has its copy; an admin can merge the two');
    if (w.status === 'failed') return t('settings.registryContributions.reasonFailed', 'not accepted as sent: {{reason}}', { reason: w.notes || '' });
    return t('settings.registryContributions.reasonDeclined', 'declined: {{reason}}', { reason: w.notes || '' });
  };

  return (
    <div>
      <h3>{t('settings.registryContributions.title', 'Wines made on this install')}</h3>
      {overview.offerable > 0 && (
        <p className="settings-hint">
          {t('settings.registryContributions.offerable', '{{count}} wines made on this install are not in the shared registry. You can offer them, with their pictures and the drink windows reviewed here; each is reviewed on cellarion.app before it joins the registry, and when it is approved your wine here is linked to it.', { count: overview.offerable })}
        </p>
      )}
      {parts.length > 0 && <p className="settings-hint">{parts.join(' · ')}</p>}
      {attention.length > 0 && (
        <ul className="settings-hint">
          {attention.map((w) => (
            <li key={w.id}>
              <Link to={`/wines/${w.slug || w.id}`}>{w.name}</Link>{w.producer ? ` — ${w.producer}` : ''}: {reasonFor(w)}
            </li>
          ))}
        </ul>
      )}
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-info">{notice}</div>}
      {overview.offerable > 0 && !confirming && (
        <div className="settings-actions">
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setConfirming(true)} disabled={busy}>
            {t('settings.registryContributions.offerAll', 'Contribute all {{count}}', { count: overview.offerable })}
          </button>
        </div>
      )}
      {overview.offerable > 0 && confirming && (
        <>
          <p className="settings-hint">
            {t('settings.registryContributions.confirm', 'They go up under the cellarion.app account that owns this install\'s key, as far as each day\'s allowance reaches. A wine still waiting can be taken back from its page.')}
          </p>
          <div className="settings-actions">
            <button type="button" className="btn btn-primary btn-small" onClick={contributeAll} disabled={busy}>
              {t('settings.registryContributions.confirmSend', 'Offer them')}
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setConfirming(false)} disabled={busy}>
              {t('common.cancel', 'Cancel')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
