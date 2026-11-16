import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getWineContribution, contributeWines, withdrawWineContribution } from '../api/bridge';
import { messageForResponse } from '../utils/friendlyError';

// The wine page on a SELF-HOSTED install connected to the shared registry
// (Registry Bridge): whether this wine, made here, has been offered to the
// registry on cellarion.app and what became of it, and for this install's
// admins the action that offers it (backend services/registryContributionOps).
// Renders nothing on the hosted instance (WineDetail does not mount it), on an
// install that is not connected, for a registry copy, and for a member who
// could not act on a wine nobody has offered yet.
export default function RegistryContributionPanel({ wineId }) {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const isAdmin = !!user?.roles?.includes('admin');
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    // A newer wine id wins: the answer for the previous one is dropped.
    let ignore = false;
    setState(null);
    setError(null);
    (async () => {
      try {
        const res = await getWineContribution(apiFetch, wineId);
        if (!res.ok) return;
        const data = await res.json();
        if (!ignore) setState(data);
      } catch {
        // The panel is optional: without an answer it simply stays away.
      }
    })();
    return () => { ignore = true; };
  }, [apiFetch, wineId]);

  if (!state || !state.enabled || state.linked) return null;
  const c = state.contribution;
  if (!c && !(state.offerable && isAdmin)) return null;

  const run = async (request, fallback) => {
    setBusy(true);
    setError(null);
    try {
      const res = await request();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(messageForResponse(res, body, fallback, t));
        return;
      }
      const fresh = await getWineContribution(apiFetch, wineId);
      if (fresh.ok) setState(await fresh.json());
    } catch {
      setError(fallback);
    } finally {
      setBusy(false);
    }
  };
  const offer = () => run(
    () => contributeWines(apiFetch, { wineIds: [wineId] }),
    t('wineDetail.contribution.errorOffer', 'The wine could not be offered right now. Please try again.')
  );
  const takeBack = () => run(
    () => withdrawWineContribution(apiFetch, wineId),
    t('wineDetail.contribution.errorWithdraw', 'That did not work. Please try again.')
  );

  let text;
  if (!c) {
    text = t('wineDetail.contribution.offerable', 'This wine was made on this install and is not in the shared registry on cellarion.app. You can offer it, with its picture and the drink windows reviewed here. It is reviewed there before it joins the registry, and when it is approved this wine is linked to it; its bottles stay where they are.');
  } else if (c.status === 'queued') {
    text = t('wineDetail.contribution.queued', 'Offered to the shared registry. It goes with the next hourly run, as far as today\'s allowance reaches.');
  } else if (c.status === 'sent') {
    text = t('wineDetail.contribution.sent', 'With the shared registry on cellarion.app, waiting for review. When it is approved, this wine is linked to it.');
  } else if (c.status === 'declined') {
    text = t('wineDetail.contribution.declined', 'The shared registry declined this wine: {{reason}}', { reason: c.notes || '' });
  } else if (c.status === 'failed') {
    text = t('wineDetail.contribution.failed', 'The shared registry did not accept this wine as it was sent: {{reason}}', { reason: c.notes || '' });
  } else if (c.status === 'duplicate') {
    text = t('wineDetail.contribution.duplicate', 'The shared registry approved this wine, and this install already has its copy of it. An admin can merge the two.');
  }

  return (
    <div className="card settings-card">
      <h2 className="settings-section-title">{t('wineDetail.contribution.title', 'Shared wine registry')}</h2>
      <p className="settings-hint">{text}</p>
      {c?.status === 'duplicate' && c.duplicateOf && (
        <p className="settings-hint">
          <Link to={`/wines/${c.duplicateOf}`}>{t('wineDetail.contribution.openCopy', 'Open the registry\'s copy')}</Link>
        </p>
      )}
      {error && <div className="alert alert-error">{error}</div>}
      {isAdmin && (
        <div className="settings-actions">
          {(!c || c.status === 'declined' || c.status === 'failed') && (
            <button type="button" className="btn btn-secondary btn-small" onClick={offer} disabled={busy}>
              {c ? t('wineDetail.contribution.offerAgain', 'Offer it again') : t('wineDetail.contribution.offer', 'Contribute to the shared registry')}
            </button>
          )}
          {c && c.status !== 'sent' && (
            <button type="button" className="btn btn-secondary btn-small" onClick={takeBack} disabled={busy}>
              {c.status === 'queued' ? t('wineDetail.contribution.withdraw', 'Take it back') : t('wineDetail.contribution.dismiss', 'Dismiss')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
