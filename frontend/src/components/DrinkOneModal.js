import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { consumeBottle } from '../api/bottles';
import { ConsumeModal } from './ConsumeModal';
import { useDialogA11y } from '../utils/useDialogA11y';
import { isReserved, reservationSummary } from '../utils/reservation';
import './DrinkOneModal.css';

/**
 * "Drink one" from a grouped entry or the vintage page (support ticket
 * 2026-10-09): pick WHICH bottle of the group leaves — by rack slot, with
 * its purchase and reservation beside it — then the ordinary consume form.
 * One bottle, one request: the group's other bottles are never touched.
 *
 * `rackMap` (cellar list) or `bottle.rackInfo` (vintage page) names the slot.
 * With a single bottle the picker is skipped. onDone(bottle, reason) fires
 * after the server confirmed, so the caller can refresh and offer the
 * journal prompt as the bottle page does.
 */
export default function DrinkOneModal({ bottles, rackMap, wineName, onClose, onDone }) {
  const { t, i18n } = useTranslation();
  const { apiFetch, user } = useAuth();
  const [picked, setPicked] = useState(() => (bottles.length === 1 ? bottles[0] : null));
  const [error, setError] = useState(null);
  const titleId = useId();
  const boxRef = useDialogA11y(onClose);

  const slotOf = (b) => b.rackInfo || rackMap?.get(String(b._id)) || null;
  const slotLabel = (b) => {
    const s = slotOf(b);
    if (!s) return t('drinkOne.unplaced', 'Not in a rack');
    return s.position != null
      ? t('drinkOne.slot', '{{rack}} · slot {{position}}', { rack: s.rackName, position: s.position })
      : s.rackName;
  };
  const purchaseLabel = (b) => {
    const parts = [];
    if (b.purchaseDate) parts.push(new Date(b.purchaseDate).toLocaleDateString(i18n.language, { year: 'numeric', month: 'short' }));
    if (b.price != null && b.price !== '') parts.push(`${b.price} ${b.currency || ''}`.trim());
    if (b.purchaseLocation) parts.push(b.purchaseLocation);
    return parts.join(' · ');
  };

  // A refusal goes back to the picker, which is where the error shows — the
  // consume form has no room for one. With a single bottle too: the picker
  // then lists that one bottle, so the error is read and the retry is a tap
  // (before, a failed single-bottle drink silently kept the form open).
  const handleConfirm = async (reason, note, rating, consumedRatingScale, consumedAt) => {
    try {
      const res = await consumeBottle(apiFetch, picked._id, { reason, note, rating, consumedRatingScale, consumedAt });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPicked(null);
        setError(data.error || t('drinkOne.failed', 'Could not log the bottle. Please try again.'));
        return;
      }
      onDone(picked, reason);
    } catch {
      setPicked(null);
      setError(t('drinkOne.failed', 'Could not log the bottle. Please try again.'));
    }
  };

  if (picked) {
    return (
      <ConsumeModal
        wineName={wineName}
        defaultRatingScale={user?.preferences?.ratingScale || '5'}
        reservationText={isReserved(picked) ? reservationSummary(picked, t) : undefined}
        onConfirm={handleConfirm}
        onCancel={bottles.length === 1 ? onClose : () => setPicked(null)}
      />
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box drink-one" onClick={(e) => e.stopPropagation()} ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h2 id={titleId}>{t('drinkOne.title', 'Which bottle?')}</h2>
        {wineName && <p className="modal-wine-name">{wineName}</p>}
        <p className="drink-one__hint">{t('drinkOne.hint', 'Pick the bottle you are taking out. The others stay as they are.')}</p>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <ul className="drink-one__list">
          {bottles.map((b) => {
            const reserved = isReserved(b);
            return (
              <li key={b._id}>
                <button type="button" className="drink-one__row" onClick={() => setPicked(b)}>
                  <span className="drink-one__slot">{slotLabel(b)}</span>
                  <span className="drink-one__meta">
                    {purchaseLabel(b)}
                    {reserved && <span className="reserved-badge"><span aria-hidden="true">🔖</span> {reservationSummary(b, t)}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </div>
    </div>
  );
}
