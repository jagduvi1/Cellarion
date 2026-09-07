import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { bulkUpdateBottles } from '../api/bottles';
import { DRINK_YEAR_MIN, DRINK_YEAR_MAX, validateDrinkWindowFields } from '../utils/drinkStatus';
import Modal from './Modal';
import BulkOutcome from './BulkOutcome';

/**
 * Bulk drink window: the years a wine and vintage share, written to every
 * selected bottle at once (support ticket 2026-09-06 — a case of six meant
 * six identical edits). A blank field stays as it is on each bottle; "clear"
 * removes all four. Same year rule and peak-inside-window rule as the single
 * edit form; a bottle whose own years conflict with the new ones is reported
 * as skipped rather than failing the batch.
 */
const FIELDS = ['drinkFrom', 'drinkTo', 'peakFrom', 'peakUntil'];
const LABELS = { drinkFrom: 'addBottle.drinkFrom', drinkTo: 'addBottle.drinkTo', peakFrom: 'addBottle.peakFrom', peakUntil: 'addBottle.peakUntil' };
const PLACEHOLDERS = { drinkFrom: 'addBottle.drinkFromPlaceholder', drinkTo: 'addBottle.drinkToPlaceholder', peakFrom: 'addBottle.peakFromPlaceholder', peakUntil: 'addBottle.peakUntilPlaceholder' };

export default function BulkDrinkWindowModal({ bottleIds, onClose, onDone }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const count = bottleIds.length;
  const [mode, setMode] = useState('set'); // 'set' | 'clear'
  const [form, setForm] = useState({ drinkFrom: '', drinkTo: '', peakFrom: '', peakUntil: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    let fields;
    if (mode === 'clear') {
      fields = { drinkFrom: null, drinkTo: null, peakFrom: null, peakUntil: null };
    } else {
      const filled = FIELDS.filter((k) => form[k].trim() !== '');
      if (!filled.length) { setError(t('bulk.windowNeedsSomething')); return; }
      const windowError = validateDrinkWindowFields(form, t);
      if (windowError) { setError(windowError); return; }
      fields = {};
      for (const k of filled) fields[k] = parseInt(form[k], 10);
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
    return <BulkOutcome title={t('bulk.windowDoneTitle')} done={result.done} skipped={result.skipped} skippedKey="bulk.windowSkippedInfo" onClose={onDone} />;
  }

  return (
    <Modal title={t('bulk.windowTitle', { count })} onClose={onClose} showClose trapFocus>
      <p>{t('bulk.windowIntro')}</p>
      <form onSubmit={submit} className="bulk-form">
        <div className="form-group bulk-mode-row" role="radiogroup" aria-label={t('addBottle.drinkWindow')}>
          <label>
            <input type="radio" name="bulk-window-mode" value="set" checked={mode === 'set'} onChange={() => setMode('set')} disabled={submitting} />
            {' '}{t('bulk.windowMode')}
          </label>
          <label>
            <input type="radio" name="bulk-window-mode" value="clear" checked={mode === 'clear'} onChange={() => setMode('clear')} disabled={submitting} />
            {' '}{t('bulk.windowClearMode')}
          </label>
        </div>
        {mode === 'set' && (
          <div className="bulk-year-grid">
            {FIELDS.map((k) => (
              <label className="form-group" key={k}>
                <span>{t(LABELS[k])}</span>
                <input type="number" inputMode="numeric" min={DRINK_YEAR_MIN} max={DRINK_YEAR_MAX} step="1" value={form[k]}
                  onChange={set(k)} placeholder={t(PLACEHOLDERS[k])} disabled={submitting} />
              </label>
            ))}
          </div>
        )}

        {error && <p className="error-message" role="alert">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? t('common.saving') : (mode === 'clear' ? t('bulk.windowClearSubmit') : t('bulk.windowSubmit'))}
          </button>
        </div>
      </form>
    </Modal>
  );
}
