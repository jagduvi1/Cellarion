import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { bulkDeleteBottles, restoreRecentlyDeleted } from '../api/bottles';
import Modal from './Modal';

// How long "Recently deleted" keeps a bottle — services/bottleTrash TRASH_DAYS.
export const TRASH_DAYS = 30;
// From this many bottles the delete asks for the number to be typed: a whole
// import is one tap away from "Select all", and a slip there should cost a
// moment of typing, not an afternoon of restoring.
export const TYPE_TO_CONFIRM_FROM = 10;
// Wines named on the confirm screen before "and N more".
const SUMMARY_LINES = 5;

/**
 * Bulk delete (forum feedback 2026-10-12: an import came in without its
 * prices and had to be deleted so it could be done again).
 *
 * The confirm screen says exactly what goes — the wines and how many of each,
 * how many sit in a rack — and that nothing is gone for good yet: the bottles
 * move to the cellar's "Recently deleted" for TRASH_DAYS. The red button names
 * the count, and from TYPE_TO_CONFIRM_FROM bottles it stays off until the
 * count is typed. After the delete, Undo brings the whole batch back at once.
 *
 * `summary` is [{ key, label, count }] for the selected bottles (the list
 * builds it from what it has loaded); `rackedCount` how many are in a rack.
 */
export default function BulkDeleteModal({ bottleIds, cellarId, summary = [], rackedCount = 0, onClose, onDone }) {
  const { t, i18n } = useTranslation();
  const { apiFetch } = useAuth();
  const count = bottleIds.length;
  const mustType = count >= TYPE_TO_CONFIRM_FROM;
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { deleted, skipped, batchId, purgeAt }
  const [undone, setUndone] = useState(null); // { restored, skipped } after Undo

  const confirmed = !mustType || typed.trim() === String(count);

  const submit = async (e) => {
    e.preventDefault();
    if (!confirmed || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await bulkDeleteBottles(apiFetch, bottleIds);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('bulk.deleteFailed'));
      setResult({ deleted: data.deleted ?? 0, skipped: (data.skipped || []).length, batchId: data.batchId, purgeAt: data.purgeAt });
    } catch (err) {
      setError(err.message || t('bulk.deleteFailed'));
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!result?.batchId || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await restoreRecentlyDeleted(apiFetch, cellarId, { batchId: result.batchId });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('trash.restoreFailed'));
      setUndone({ restored: data.restored ?? 0, skipped: (data.skipped || []).length });
    } catch (err) {
      setError(err.message || t('trash.restoreFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const until = result.purgeAt
      ? new Date(result.purgeAt).toLocaleDateString(i18n.language, { year: 'numeric', month: 'short', day: 'numeric' })
      : '';
    return (
      <Modal title={undone ? t('trash.restoredTitle') : t('bulk.deleteDoneTitle')} onClose={onDone} showClose trapFocus>
        {undone ? (
          <>
            <p className="move-bottle-success" role="status">{t('trash.restoredInfo', { count: undone.restored })}</p>
            {undone.skipped > 0 && <p className="move-bottle-skipped">{t('trash.restoreSkipped', { count: undone.skipped })}</p>}
          </>
        ) : (
          <>
            <p className="move-bottle-success" role="status">{t('bulk.deleteDoneInfo', { count: result.deleted, date: until })}</p>
            {result.skipped > 0 && <p className="move-bottle-skipped">{t('bulk.deleteSkipped', { count: result.skipped })}</p>}
            <p className="trash-where">{t('bulk.deleteWhere')}</p>
          </>
        )}
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="modal-actions">
          {!undone && result.deleted > 0 && (
            <button type="button" className="btn btn-secondary" onClick={undo} disabled={busy}>
              {busy ? t('trash.restoring') : t('bulk.deleteUndo')}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={onDone} disabled={busy}>
            {t('bulk.close')}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t('bulk.deleteTitle', { count })} onClose={onClose} showClose trapFocus>
      <form onSubmit={submit} className="bulk-form">
        {summary.length > 0 && (
          <ul className="trash-summary" aria-label={t('bulk.deleteSummaryAria')}>
            {summary.slice(0, SUMMARY_LINES).map((s) => (
              <li key={s.key}>
                <span className="trash-summary-name">{s.label}</span>
                <span className="trash-summary-count">{t('bulk.deleteBottleCount', { count: s.count })}</span>
              </li>
            ))}
            {summary.length > SUMMARY_LINES && (
              <li className="trash-summary-more">{t('bulk.deleteMoreWines', { count: summary.length - SUMMARY_LINES })}</li>
            )}
          </ul>
        )}
        <p>{t('bulk.deleteIntro', { days: TRASH_DAYS })}</p>
        {rackedCount > 0 && <p>{t('bulk.deleteRacked', { count: rackedCount })}</p>}
        {mustType && (
          <label className="form-group">
            <span>{t('bulk.deleteTypeToConfirm', { count })}</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
              autoFocus
            />
          </label>
        )}
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-danger" disabled={!confirmed || busy}>
            {busy ? t('bulk.deleting') : t('bulk.deleteSubmit', { count })}
          </button>
        </div>
      </form>
    </Modal>
  );
}
