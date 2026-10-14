import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { restoreBottle, restoreRecentlyDeleted } from '../api/bottles';
import { TRASH_DAYS } from './BulkDeleteModal';
import './BottleUndoNotice.css';

/**
 * The line a list shows after the bottle page took a bottle away — with the
 * way back right there.
 *
 *  - kind 'consumed' (drank / gifted / sold): Undo puts it back as active
 *    (POST /:id/restore — the same restore the drunk bottle's own page offers
 *    for two days, which nobody found from History).
 *  - kind 'deleted' ("Added by mistake?" / "Cancel order"): the bottle went to
 *    Recently deleted; Undo brings that batch back.
 *
 * `notice` = { kind, name, bottleId, batchId?, reason? } — handed over in the
 * navigation's router state by BottleDetail. `onUndone` refreshes the list.
 */
export default function BottleUndoNotice({ notice, cellarId, onUndone, onDismiss }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState(false);
  const [failure, setFailure] = useState(null);

  const undo = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = notice.kind === 'deleted'
        ? await restoreRecentlyDeleted(apiFetch, cellarId, { batchId: notice.batchId })
        : await restoreBottle(apiFetch, notice.bottleId);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setFailure(body?.error || t('trash.restoreFailed', 'Couldn’t restore. Please try again.'));
        return;
      }
      setUndone(true);
      if (onUndone) onUndone();
    } catch {
      setFailure(t('common.networkError', 'Network error'));
    } finally {
      setBusy(false);
    }
  };

  const name = notice.name || t('bottleNotice.thisBottle', 'The bottle');
  let text;
  if (undone) {
    text = t('bottleNotice.restored', '“{{name}}” is back in the cellar.', { name });
  } else if (notice.kind === 'deleted') {
    text = t('bottleNotice.deleted', '“{{name}}” moved to Recently deleted. You can bring it back for {{days}} days.', { name, days: TRASH_DAYS });
  } else if (notice.reason === 'drank') {
    text = t('bottleNotice.drunk', '“{{name}}” is marked as drunk.', { name });
  } else {
    text = t('bottleNotice.takenOut', '“{{name}}” is taken out of the cellar.', { name });
  }

  return (
    <div className="alert alert-success bottle-undo-notice" role="status">
      <span className="bottle-undo-notice__text">
        {text}
        {failure && <span className="bottle-undo-notice__error" role="alert"> {failure}</span>}
      </span>
      {!undone && (
        <button type="button" className="btn btn-small btn-secondary" onClick={undo} disabled={busy}>
          {busy ? t('trash.restoring', 'Restoring…') : t('common.undo', 'Undo')}
        </button>
      )}
      <button
        type="button"
        className="btn btn-small btn-secondary bottle-undo-notice__close"
        onClick={onDismiss}
        aria-label={t('common.close', 'Close')}
        disabled={busy}
      >
        ✕
      </button>
    </div>
  );
}
