import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { bulkUpdateBottles } from '../api/bottles';
import { DRINK_YEAR_MIN, DRINK_YEAR_MAX } from '../utils/drinkStatus';
import Modal from './Modal';
import BulkOutcome from './BulkOutcome';

/**
 * Bulk reservation ("spoken for"): mark every selected bottle as reserved for
 * someone or something, until a year — or clear the reservation on all of
 * them. Same two fields and the same year rule as the single bottle edit form.
 */
export default function BulkReserveModal({ bottleIds, onClose, onDone }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const count = bottleIds.length;
  const [mode, setMode] = useState('reserve'); // 'reserve' | 'clear'
  const [reservedFor, setReservedFor] = useState('');
  const [reservedUntil, setReservedUntil] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    let fields;
    if (mode === 'clear') {
      fields = { reservedFor: null, reservedUntil: null };
    } else {
      const who = reservedFor.trim();
      const yearText = reservedUntil.trim();
      if (!who && !yearText) { setError(t('bulk.reserveNeedsSomething')); return; }
      fields = {};
      if (who) fields.reservedFor = who;
      if (yearText) {
        const y = parseInt(yearText, 10);
        if (!Number.isInteger(y) || String(y) !== yearText || y < DRINK_YEAR_MIN || y > DRINK_YEAR_MAX) {
          setError(t('bottleDetail.reservedUntilInvalid', { min: DRINK_YEAR_MIN, max: DRINK_YEAR_MAX }));
          return;
        }
        fields.reservedUntil = y;
      }
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await bulkUpdateBottles(apiFetch, bottleIds, fields);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('bulk.failed'));
      setResult({ done: data.done ?? 0, skipped: (data.skipped || []).length });
    } catch (err) {
      setError(err.message || t('bulk.failed'));
      setSubmitting(false);
    }
  };

  if (result) {
    return <BulkOutcome title={t('bulk.reserveDoneTitle')} done={result.done} skipped={result.skipped} onClose={onDone} />;
  }

  return (
    <Modal title={t('bulk.reserveTitle', { count })} onClose={onClose} showClose trapFocus>
      <p>{t('bulk.reserveIntro')}</p>
      <form onSubmit={submit} className="bulk-form">
        <div className="form-group bulk-mode-row" role="radiogroup" aria-label={t('bottleDetail.reservationLabel')}>
          <label>
            <input type="radio" name="bulk-reserve-mode" value="reserve" checked={mode === 'reserve'} onChange={() => setMode('reserve')} disabled={submitting} />
            {' '}{t('bulk.reserveMode')}
          </label>
          <label>
            <input type="radio" name="bulk-reserve-mode" value="clear" checked={mode === 'clear'} onChange={() => setMode('clear')} disabled={submitting} />
            {' '}{t('bulk.clearMode')}
          </label>
        </div>
        {mode === 'reserve' && (
          <>
            <label className="form-group">
              <span>{t('bottleDetail.reservedForLabel')}</span>
              <input type="text" value={reservedFor} onChange={(e) => setReservedFor(e.target.value)} maxLength={200}
                placeholder={t('bottleDetail.reservedForPlaceholder')} disabled={submitting} />
            </label>
            <label className="form-group">
              <span>{t('bottleDetail.reservedUntilLabel')}</span>
              <input type="number" inputMode="numeric" min={DRINK_YEAR_MIN} max={DRINK_YEAR_MAX} value={reservedUntil}
                onChange={(e) => setReservedUntil(e.target.value)} placeholder={t('bottleDetail.reservedUntilPlaceholder')} disabled={submitting} />
            </label>
          </>
        )}

        {error && <p className="error-message" role="alert">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? t('common.saving') : (mode === 'clear' ? t('bulk.clearSubmit') : t('bulk.reserveSubmit'))}
          </button>
        </div>
      </form>
    </Modal>
  );
}
