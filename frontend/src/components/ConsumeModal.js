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
export function ConsumeModal({ wineName, defaultRatingScale, reservationText, onConfirm, onCancel }) {
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
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box" onClick={e => e.stopPropagation()} ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h2 id={titleId}>{t('bottleDetail.removeBottleTitle')}</h2>
        {wineName && <p className="modal-wine-name">{wineName}</p>}
        {reservationText && (
          <div className="alert alert-warning" role="alert">
            <span aria-hidden="true">🔖</span>{' '}
            {t('bottleDetail.consumeReservedWarning', { reservation: reservationText })}
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>{t('common.reason')}</label>
            <select value={reason} onChange={e => setReason(e.target.value)}>
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
            <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-consume" disabled={saving}>
              {saving ? t('common.saving') : t('common.confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
