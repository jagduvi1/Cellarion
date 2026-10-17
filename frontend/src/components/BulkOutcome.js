import { useTranslation } from 'react-i18next';
import Modal from './Modal';

/**
 * The closing screen every bulk action shares: how many bottles it was done
 * for, how many were skipped (and why, in one line), and a single button.
 * `extra` lets an action add its own line (the list a wine went on, say).
 * `actions` are buttons beside the closing one (bulk "mark as drunk" puts its
 * Undo there); `doneKey` words the count, and `busy` holds the screen open
 * while one of those actions runs.
 */
export default function BulkOutcome({
  title, done, skipped, doneKey = 'bulk.doneInfo', skippedKey = 'bulk.skippedInfo', extra = null, actions = null, busy = false, onClose,
}) {
  const { t } = useTranslation();
  const close = () => { if (!busy) onClose(); };
  return (
    <Modal title={title} onClose={close} showClose trapFocus>
      {extra}
      <p className="move-bottle-success">{t(doneKey, { count: done })}</p>
      {skipped > 0 && (
        <p className="move-bottle-skipped" role="status">{t(skippedKey, { count: skipped })}</p>
      )}
      <div className="modal-actions">
        {actions}
        <button type="button" className="btn btn-primary" onClick={close} disabled={busy}>
          {t('bulk.close')}
        </button>
      </div>
    </Modal>
  );
}
