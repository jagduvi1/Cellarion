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
 *
 * Reserved ("spoken for") bottles are left alone on the first pass and
 * reported; the outcome screen then offers to mark those too. The single
 * flow warns before consuming a reservation, so bulk must not be the one
 * path that does it silently.
 */
export default function BulkConsumeModal({ bottleIds, onClose, onDone }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const count = bottleIds.length;
  const [reason, setReason] = useState('drank');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { done, skipped, reserved: [ids] }

  const send = (ids, includeReserved) => bulkConsumeBottles(apiFetch, ids, {
    reason,
    note: note.trim() || undefined,
    consumedAt: date || undefined,
    includeReserved,
  });
  const parse = async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('bulk.failed'));
    const skipped = data.skipped || [];
    const reserved = skipped.filter((s) => s.reason === 'reserved').map((s) => s.id);
    return { done: data.done ?? 0, skipped: skipped.length - reserved.length, reserved };
  };

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      setResult(await parse(await send(bottleIds, false)));
    } catch (err) {
      setError(err.message || t('bulk.failed'));
      setSubmitting(false);
    }
  };

  const consumeReservedToo = async () => {
    if (!result?.reserved.length || moreBusy) return;
    setMoreBusy(true);
    setError('');
    try {
      const more = await parse(await send(result.reserved, true));
      setResult({ done: result.done + more.done, skipped: result.skipped + more.skipped, reserved: [] });
    } catch (err) {
      setError(err.message || t('bulk.failed'));
    } finally {
      setMoreBusy(false);
    }
  };

  if (result) {
    const extra = result.reserved.length > 0 ? (
      <div className="bulk-reserved-note">
        <p role="status">{t('bulk.reservedSkipped', { count: result.reserved.length })}</p>
        <button type="button" className="btn btn-secondary btn-small" onClick={consumeReservedToo} disabled={moreBusy}>
          {moreBusy ? t('common.saving') : t('bulk.consumeReservedToo')}
        </button>
        {error && <p className="error-message" role="alert">{error}</p>}
      </div>
    ) : null;
    return <BulkOutcome title={t('bulk.consumeDoneTitle')} done={result.done} skipped={result.skipped} extra={extra} onClose={onDone} />;
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
