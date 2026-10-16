import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import RatingInput from './RatingInput';
import { useDialogA11y } from '../utils/useDialogA11y';

// Local calendar date, YYYY-MM-DD — what <input type="date"> speaks.
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// `reservationText`: when the bottle is reserved ("spoken for"), the caller
// passes a one-line summary and the modal shows a warning above the form —
// the confirm button then doubles as the reservation acknowledgment.
//
// onConfirm(reason, note, rating, ratingScale, consumedAt): consumedAt is the
// day the bottle was actually drunk (YYYY-MM-DD), defaulting to today — a
// bottle logged after the fact used to be stamped with the logging day, and
// the only way to say otherwise was the bulk action (support ticket
// 2026-09-13). Same field and rule as BulkConsumeModal: never in the future.
//
// `onJustAGlass`: the rack page and the 3D room open this dialog straight
// from a slot, where the bottle page's own "Open bottle…" button is not at
// hand. They pass this, and the dialog first offers "Just a glass — keep the
// bottle" (open it and pour one glass instead of taking it out). Without it
// — the bottle page, "Drink one" — that choice is not shown. The racks and
// the room used to carry copies of this dialog for the sake of that one
// button, and those copies never learned the reservation warning
// (usability plan 2026-10-14, D2).
export function ConsumeModal({ wineName, defaultRatingScale, reservationText, onConfirm, onCancel, onJustAGlass }) {
  const { t } = useTranslation();
  const [reason,       setReason]      = useState('drank');
  const [note,         setNote]        = useState('');
  const [rating,       setRating]      = useState('');
  const [ratingScale,  setRatingScale] = useState(defaultRatingScale || '5');
  const [date,         setDate]        = useState(today);
  const [saving,       setSaving]      = useState(false);
  const titleId = useId();
  const dateId = useId();
  const boxRef = useDialogA11y(onCancel);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onConfirm(reason, note || undefined, rating || undefined, ratingScale, date || undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    // While the take-out is on its way, a tap beside the dialog does not
    // close it: a refusal keeps the dialog open with what was typed (the
    // racks, the room), and a stray tap must not throw that away. Escape and
    // Back still close it — those are meant.
    <div className="modal-overlay" onClick={saving ? undefined : onCancel}>
      <div className="modal-box" onClick={e => e.stopPropagation()} ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h2 id={titleId}>{t('bottleDetail.removeBottleTitle')}</h2>
        {wineName && <p className="modal-wine-name">{wineName}</p>}
        {reservationText && (
          <div className="alert alert-warning" role="alert">
            <span aria-hidden="true">🔖</span>{' '}
            {t('bottleDetail.consumeReservedWarning', { reservation: reservationText })}
          </div>
        )}
        {onJustAGlass && (
          // Disabled while the take-out is saving: a glass poured from a
          // bottle the server is taking out at that moment would land on a
          // drunk bottle.
          <div className="consume-partial-row">
            <button type="button" className="btn btn-secondary consume-partial-btn" onClick={onJustAGlass} disabled={saving}>
              🍷 {t('openBottle.partialOption')}
            </button>
            <span className="consume-partial-or">{t('openBottle.partialOr')}</span>
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>{t('common.reason')}</label>
            {/* The first focus is the form, also when "Just a glass" sits
                above it: a stray Enter must not pour a glass. */}
            <select value={reason} onChange={e => setReason(e.target.value)} autoFocus>
              <option value="drank">{t('bottleDetail.drinkReason')}</option>
              <option value="gifted">{t('bottleDetail.giftedReason')}</option>
              <option value="sold">{t('bottleDetail.soldReason')}</option>
              <option value="other">{t('bottleDetail.otherReason')}</option>
            </select>
          </div>
          <div className="form-group">
            <label htmlFor={dateId}>{t('bulk.consumeDate')}</label>
            <input
              id={dateId}
              type="date"
              value={date}
              max={today()}
              onChange={e => setDate(e.target.value)}
              disabled={saving}
            />
          </div>
          {reason === 'drank' && (
            <div className="form-group">
              <label>{t('bottleDetail.ratingOptional')}</label>
              <RatingInput
                value={rating}
                scale={ratingScale}
                onChange={v => setRating(v ?? '')}
                onScaleChange={s => { setRatingScale(s); setRating(''); }}
                allowScaleOverride
              />
            </div>
          )}
          <div className="form-group">
            <label>{t('bottleDetail.noteOptional')}</label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={3}
              placeholder={t('bottleDetail.notePlaceholder')}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-consume" disabled={saving}>
              {saving ? t('common.saving') : t('common.confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
