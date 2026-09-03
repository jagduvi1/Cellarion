import { useTranslation } from 'react-i18next';
import Modal from './Modal';

/**
 * The closing screen every bulk action shares: how many bottles it was done
 * for, how many were skipped (and why, in one line), and a single button.
 * `extra` lets an action add its own line (the list a wine went on, say).
 */
export default function BulkOutcome({ title, done, skipped, skippedKey = 'bulk.skippedInfo', extra = null, onClose }) {
  const { t } = useTranslation();
  return (
    <Modal title={title} onClose={onClose} showClose trapFocus>
      {extra}
      <p className="move-bottle-success">{t('bulk.doneInfo', { count: done })}</p>
      {skipped > 0 && (
        <p className="move-bottle-skipped" role="status">{t(skippedKey, { count: skipped })}</p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {t('bulk.close')}
        </button>
      </div>
    </Modal>
  );
}
