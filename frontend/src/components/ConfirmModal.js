import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import { friendlyError } from '../utils/friendlyError';
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
  const [failure, setFailure] = useState(null);
  const needsTyping = !!confirmText;
  const isConfirmEnabled = !submitting && (!needsTyping || typed === confirmText);

  const mounted = useRef(true);
  useEffect(() => {
    // Set here as well as cleared: StrictMode runs the cleanup and then the
    // effect again, and a ref only cleared would stay false for good.
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // A confirm whose action throws used to leave the button disabled for good
  // and say nothing. Now the dialog stays open, says why, and can be tried
  // again. (Callers that close the dialog themselves are unaffected.)
  const handleConfirm = async () => {
    setSubmitting(true);
    setFailure(null);
    try {
      await onConfirm();
    } catch (err) {
      if (mounted.current) setFailure(friendlyError(err, t));
    } finally {
      if (mounted.current) setSubmitting(false);
    }
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
      {failure && <p className="confirm-modal__warning" role="alert">{failure}</p>}
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
