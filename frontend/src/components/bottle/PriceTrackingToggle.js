import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import Modal from '../Modal';

/**
 * Lets the bottle owner opt in / opt out of sommelier price tracking
 * for the wine+vintage pair this bottle belongs to. Renders nothing for
 * ineligible bottles (NV, missing vintage, missing wineDefinition).
 *
 * On the page it shows only a compact pill button; the full explanation
 * and the request/cancel action live in a popup opened from that button.
 */
export default function PriceTrackingToggle({ bottleId, vintage }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [status, setStatus] = useState(null);  // { requested, requesterCount, eligible, firstRequestedAt }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);

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

  const closeModal = () => {
    setOpen(false);
    setError(null);
  };

  return (
    <>
      <button
        type="button"
        className={`price-tracking-trigger${requested ? ' price-tracking-trigger--active' : ''}`}
        onClick={() => setOpen(true)}
      >
        <span className="price-tracking-trigger__icon" aria-hidden="true">{'\u{1F4C8}'}</span>
        {requested
          ? t('priceTracking.triggerRequested', 'Tracking requested')
          : t('priceTracking.trigger', 'Track market price')}
      </button>

      {open && (
        <Modal title={t('priceTracking.modalTitle', 'Market price tracking')} onClose={closeModal} showClose>
          <div className="price-tracking-modal">
            <div className="price-tracking-modal__label">
              {requested
                ? t('priceTracking.statusRequested', 'Market price tracking requested')
                : t('priceTracking.statusNotRequested', 'Track market price for this wine')}
            </div>
            <div className="price-tracking-modal__hint">
              {requested
                ? t('priceTracking.hintRequested', 'A sommelier will research and add a price. You will be notified when it is set.')
                : t('priceTracking.hintGuidance', 'Only worth requesting for bottles with a real secondary-market value — Bordeaux Premier Cru, Burgundy Grand Cru, age-worthy collectibles. Everyday wines usually do not have reliable market data.')}
            </div>
            {requested && status.requesterCount > 1 && (
              <div className="price-tracking-modal__count">
                {t('priceTracking.requesterCount', '{{count}} other user(s) also requested this', { count: status.requesterCount - 1 })}
              </div>
            )}
            {error && <div className="price-tracking-modal__error">{error}</div>}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={closeModal}>
              {t('common.close', 'Close')}
            </button>
            <button
              type="button"
              className={`btn ${requested ? 'btn-secondary' : 'btn-primary'}`}
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
        </Modal>
      )}
    </>
  );
}
