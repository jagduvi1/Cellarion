import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { bulkConsumeBottles } from '../api/bottles';
import Modal from './Modal';
import BulkOutcome from './BulkOutcome';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Bulk "Mark as drunk / gifted / sold": one reason and ONE date for every
 * selected bottle (the dinner was Saturday, the logging is today). Ratings and
 * per-bottle notes stay per bottle — they can be added from the history.
 * Bottles already consumed are reported as skipped by the server.
 */
export default function BulkConsumeModal({ bottleIds, onClose, onDone }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const count = bottleIds.length;
  const [reason, setReason] = useState('drank');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await bulkConsumeBottles(apiFetch, bottleIds, {
        reason,
        note: note.trim() || undefined,
        consumedAt: date || undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('bulk.failed'));
      setResult({ done: data.done ?? 0, skipped: (data.skipped || []).length });
    } catch (err) {
      setError(err.message || t('bulk.failed'));
      setSubmitting(false);
    }
  };

  if (result) {
    return <BulkOutcome title={t('bulk.consumeDoneTitle')} done={result.done} skipped={result.skipped} onClose={onDone} />;
  }

  return (
    <Modal title={t('bulk.consumeTitle', { count })} onClose={onClose} showClose trapFocus>
      <p>{t('bulk.consumeIntro')}</p>
      <form onSubmit={submit} className="bulk-form">
        <label className="form-group">
          <span>{t('common.reason')}</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)} disabled={submitting}>
            <option value="drank">{t('bottleDetail.drinkReason')}</option>
            <option value="gifted">{t('bottleDetail.giftedReason')}</option>
            <option value="sold">{t('bottleDetail.soldReason')}</option>
            <option value="other">{t('bottleDetail.otherReason')}</option>
          </select>
        </label>
        <label className="form-group">
          <span>{t('bulk.consumeDate')}</span>
          <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} disabled={submitting} />
        </label>
        <label className="form-group">
          <span>{t('bottleDetail.noteOptional')}</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000}
            placeholder={t('bottleDetail.notePlaceholder')} disabled={submitting} />
        </label>

        {error && <p className="error-message" role="alert">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-consume" disabled={submitting}>
            {submitting ? t('common.saving') : t('bulk.consumeSubmit', { count })}
          </button>
        </div>
      </form>
    </Modal>
  );
}
