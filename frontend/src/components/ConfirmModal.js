import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import './ConfirmModal.css';

/**
 * Reusable confirmation dialog that replaces window.confirm().
 *
 * Props:
 *  - title         — modal title (default: "Confirm")
 *  - message       — main message (string or JSX)
 *  - warning       — optional warning text shown in red below the message
 *  - confirmLabel  — text for the confirm button (default: "Delete")
 *  - confirmClass  — CSS class for the confirm button (default: "btn btn-danger btn-small")
 *  - confirmText   — if set, user must type this exact text to enable confirm (e.g. cellar name)
 *  - onConfirm     — called when user clicks confirm
 *  - onCancel      — called when user clicks cancel or closes the modal
 */
function ConfirmModal({ title, message, warning, confirmLabel, confirmClass, confirmText, onConfirm, onCancel }) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const needsTyping = !!confirmText;
  const isConfirmEnabled = !submitting && (!needsTyping || typed === confirmText);

  const handleConfirm = async () => {
    setSubmitting(true);
    try { await onConfirm(); } catch { /* caller handles */ }
  };

  return (
    <Modal title={title || t('common.confirm', 'Confirm')} onClose={onCancel}>
      {message && <p className="confirm-modal__message">{message}</p>}
      {warning && <p className="confirm-modal__warning">{warning}</p>}
      {needsTyping && (
        <div className="confirm-modal__typing">
          <label htmlFor="confirm-type-input" className="confirm-modal__label">
            {t('common.typeToConfirm', { name: confirmText })}
          </label>
          <input
            id="confirm-type-input"
            type="text"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            placeholder={confirmText}
            autoFocus
            className="confirm-modal__input"
            aria-label={t('common.typeToConfirm', { name: confirmText })}
          />
        </div>
      )}
      <div className="confirm-modal__actions">
        <button className="btn btn-outline btn-small" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button
          className={confirmClass || 'btn btn-danger btn-small'}
          onClick={handleConfirm}
          disabled={!isConfirmEnabled}
        >
          {confirmLabel || t('common.delete', 'Delete')}
        </button>
      </div>
    </Modal>
  );
}

export default ConfirmModal;
