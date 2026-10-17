import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { bulkConsumeBottles, restoreBottle } from '../api/bottles';
import { messageForResponse } from '../utils/friendlyError';
import Modal from './Modal';

// LOCAL calendar date, YYYY-MM-DD — toISOString() would give the UTC day, which
// is yesterday for anyone west of Greenwich in the evening (audit 2026-09-14).
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

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
 *
 * The outcome screen also offers Undo, as a single drink does: every bottle
 * this batch took out goes back (POST /:id/restore each, the bottle page's
 * "Move back to cellar"), unplaced. A bottle that could not come back is
 * counted, with the reason — never reported as back.
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
  const [result, setResult] = useState(null); // { done, doneIds, skipped, reserved: [ids] }
  const [undoBusy, setUndoBusy] = useState(false);
  const [undone, setUndone] = useState(null); // { restored, failed, reason } after Undo

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
    return { done: data.done ?? 0, doneIds: data.doneIds || [], skipped: skipped.length - reserved.length, reserved };
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
      setResult({ done: result.done + more.done, doneIds: [...result.doneIds, ...more.doneIds], skipped: result.skipped + more.skipped, reserved: [] });
    } catch (err) {
      setError(err.message || t('bulk.failed'));
    } finally {
      setMoreBusy(false);
    }
  };

  // One restore per bottle, one after another. A rate limit or a dropped
  // connection stops the run: the bottles not yet tried count as not back.
  const undo = async () => {
    if (undoBusy || moreBusy || !result?.doneIds.length) return;
    setUndoBusy(true);
    setError('');
    let restored = 0;
    let reason = '';
    try {
      for (const id of result.doneIds) {
        const res = await restoreBottle(apiFetch, id);
        if (res.ok) { restored += 1; continue; }
        const body = await res.json().catch(() => ({}));
        if (!reason) reason = messageForResponse(res, body, t('bottleDetail.restoreError'), t);
        if (res.status === 429) break;
      }
    } catch {
      if (!reason) reason = t('common.networkError');
    }
    setUndone({ restored, failed: result.doneIds.length - restored, reason });
    setUndoBusy(false);
  };
  const close = () => { if (!undoBusy) onDone(); };

  if (result) {
    return (
      <Modal title={undone ? t('trash.restoredTitle') : t('bulk.consumeDoneTitle')} onClose={close} showClose trapFocus>
        {undone ? (
          <>
            <p className="move-bottle-success" role="status">{t('trash.restoredInfo', { count: undone.restored })}</p>
            {undone.failed > 0 && (
              <p className="move-bottle-skipped" role="alert">
                {t('bulk.consumeUndoFailed', { count: undone.failed })}{undone.reason ? ` ${undone.reason}` : ''}
              </p>
            )}
          </>
        ) : (
          <>
            {result.reserved.length > 0 && (
              <div className="bulk-reserved-note">
                <p role="status">{t('bulk.reservedSkipped', { count: result.reserved.length })}</p>
                <button type="button" className="btn btn-secondary btn-small" onClick={consumeReservedToo} disabled={moreBusy || undoBusy}>
                  {moreBusy ? t('common.saving') : t('bulk.consumeReservedToo')}
                </button>
                {error && <p className="error-message" role="alert">{error}</p>}
              </div>
            )}
            <p className="move-bottle-success">{t('bulk.doneInfo', { count: result.done })}</p>
            {result.skipped > 0 && (
              <p className="move-bottle-skipped" role="status">{t('bulk.skippedInfo', { count: result.skipped })}</p>
            )}
          </>
        )}
        <div className="modal-actions">
          {!undone && result.doneIds.length > 0 && (
            <button type="button" className="btn btn-secondary" onClick={undo} disabled={undoBusy || moreBusy}>
              {undoBusy ? t('trash.restoring') : t('common.undo')}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={close} disabled={undoBusy}>
            {t('bulk.close')}
          </button>
        </div>
      </Modal>
    );
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
