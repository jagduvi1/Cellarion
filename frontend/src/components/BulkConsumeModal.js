import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { bulkConsumeBottles, bulkRestoreBottles } from '../api/bottles';
import { messageForResponse, friendlyError } from '../utils/friendlyError';
import Modal from './Modal';
import BulkOutcome from './BulkOutcome';

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
 * this batch took out goes back, unplaced, in ONE request (POST /bulk
 * action 'restore' — the bottle page's "Move back to cellar" per bottle, with
 * its two-day rule). A bottle that did not come back is counted, never
 * reported as back, and Retry tries only those again.
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
  // After an Undo: how many are back, the ids that are not (offered again),
  // and why the request itself failed, if it did.
  const [undone, setUndone] = useState(null); // { restored, pending: [ids], reason }

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

  // Undo, and Retry for the bottles a first Undo did not bring back.
  // 'not_consumed' means it is back already (moved back from its own page
  // meanwhile) — it counts as back, not as a failure.
  const undo = async () => {
    const ids = undone ? undone.pending : result?.doneIds;
    if (undoBusy || moreBusy || !ids?.length) return;
    setUndoBusy(true);
    let restored = undone?.restored || 0;
    let pending = ids;
    let reason = '';
    try {
      const res = await bulkRestoreBottles(apiFetch, ids);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        reason = messageForResponse(res, data, t('bottleDetail.restoreError'), t);
      } else {
        const skipped = data.skipped || [];
        const alreadyBack = skipped.filter((s) => s.reason === 'not_consumed').length;
        restored += (data.doneIds || []).length + alreadyBack;
        pending = skipped.filter((s) => s.reason !== 'not_consumed').map((s) => s.id);
      }
    } catch (err) {
      reason = friendlyError(err, t);
    }
    setUndone({ restored, pending, reason });
    setUndoBusy(false);
  };

  if (result) {
    const pending = undone ? undone.pending : result.doneIds;
    const undoButton = pending.length > 0 ? (
      <button type="button" className="btn btn-secondary" onClick={undo} disabled={undoBusy || moreBusy}>
        {undoBusy ? t('trash.restoring') : undone ? t('common.retry', 'Retry') : t('common.undo')}
      </button>
    ) : null;
    if (undone) {
      // Titled by what came back: nothing back yet keeps the take-out's title.
      const someBack = undone.restored > 0;
      return (
        <BulkOutcome
          title={someBack ? t('trash.restoredTitle') : t('bulk.consumeDoneTitle')}
          done={someBack ? undone.restored : result.done}
          doneKey={someBack ? 'trash.restoredInfo' : 'bulk.doneInfo'}
          skipped={undone.pending.length}
          skippedKey="bulk.consumeUndoFailed"
          extra={undone.reason ? <p className="error-message" role="alert">{undone.reason}</p> : null}
          actions={undoButton}
          busy={undoBusy}
          onClose={onDone}
        />
      );
    }
    const extra = result.reserved.length > 0 ? (
      <div className="bulk-reserved-note">
        <p role="status">{t('bulk.reservedSkipped', { count: result.reserved.length })}</p>
        <button type="button" className="btn btn-secondary btn-small" onClick={consumeReservedToo} disabled={moreBusy || undoBusy}>
          {moreBusy ? t('common.saving') : t('bulk.consumeReservedToo')}
        </button>
        {error && <p className="error-message" role="alert">{error}</p>}
      </div>
    ) : null;
    return (
      <BulkOutcome
        title={t('bulk.consumeDoneTitle')}
        done={result.done}
        skipped={result.skipped}
        extra={extra}
        actions={undoButton}
        busy={undoBusy}
        onClose={onDone}
      />
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
