import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';

/**
 * Lets the bottle owner opt in / opt out of sommelier price tracking
 * for the wine+vintage pair this bottle belongs to. Renders nothing for
 * ineligible bottles (NV, missing vintage, missing wineDefinition).
 */
export default function PriceTrackingToggle({ bottleId, vintage, hasHistory }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [status, setStatus] = useState(null);  // { requested, requesterCount, eligible, firstRequestedAt }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Eligibility shortcut — don't even hit the API for NV/unknown
  const eligibleClient = vintage && vintage !== 'NV' && vintage !== 'Unknown';

  const load = useCallback(async () => {
    if (!eligibleClient) {
      setStatus({ requested: false, requesterCount: 0, eligible: false });
      return;
    }
    try {
      const res = await apiFetch(`/api/bottles/${bottleId}/request-price-tracking`);
      if (!res.ok) return;
      const data = await res.json();
      setStatus(data);
    } catch {
      // network blip — leave status null, hide UI
    }
  }, [apiFetch, bottleId, eligibleClient]);

  useEffect(() => { load(); }, [load]);

  if (!status || !status.eligible) return null;

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const method = status.requested ? 'DELETE' : 'POST';
      const res = await apiFetch(`/api/bottles/${bottleId}/request-price-tracking`, { method });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed');
      }
      const data = await res.json();
      setStatus(prev => ({ ...prev, ...data }));
    } catch (err) {
      setError(err.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const requested = !!status.requested;

  return (
    <div className="price-tracking-toggle">
      <div className="price-tracking-toggle__row">
        <div className="price-tracking-toggle__text">
          <div className="price-tracking-toggle__label">
            {requested
              ? t('priceTracking.statusRequested', 'Market price tracking requested')
              : hasHistory
                ? t('priceTracking.statusHistoryOnly', 'Price tracking is no longer active')
                : t('priceTracking.statusNotRequested', 'Track market price for this wine')}
          </div>
          <div className="price-tracking-toggle__hint">
            {requested
              ? t('priceTracking.hintRequested', 'A sommelier will research and add a price. You will be notified when it is set.')
              : t('priceTracking.hintGuidance', 'Only worth requesting for bottles with a real secondary-market value — Bordeaux Premier Cru, Burgundy Grand Cru, age-worthy collectibles. Everyday wines usually do not have reliable market data.')}
          </div>
          {requested && status.requesterCount > 1 && (
            <div className="price-tracking-toggle__count">
              {t('priceTracking.requesterCount', '{{count}} other user(s) also requested this', { count: status.requesterCount - 1 })}
            </div>
          )}
        </div>
        <button
          type="button"
          className={`btn ${requested ? 'btn-secondary' : 'btn-primary'} price-tracking-toggle__btn`}
          onClick={toggle}
          disabled={busy}
        >
          {busy
            ? t('priceTracking.saving', 'Saving…')
            : requested
              ? t('priceTracking.cancel', 'Cancel request')
              : t('priceTracking.request', 'Request tracking')}
        </button>
      </div>
      {error && <div className="price-tracking-toggle__error">{error}</div>}
    </div>
  );
}
