import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';

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
  const needsTyping = !!confirmText;
  const isConfirmEnabled = !needsTyping || typed === confirmText;

  return (
    <Modal title={title || t('common.confirm', 'Confirm')} onClose={onCancel}>
      {message && <p style={{ margin: '0 0 0.5rem' }}>{message}</p>}
      {warning && (
        <p style={{ margin: '0 0 1rem', color: 'var(--color-danger)', fontSize: '0.85rem' }}>{warning}</p>
      )}
      {needsTyping && (
        <div style={{ margin: '0.75rem 0' }}>
          <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--color-text-muted)', marginBottom: '0.35rem' }}>
            {t('common.typeToConfirm', { name: confirmText })}
          </label>
          <input
            type="text"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            placeholder={confirmText}
            autoFocus
            style={{ width: '100%', padding: '0.5rem', border: '1px solid var(--color-input-border)', borderRadius: 'var(--radius-sm)', fontSize: '0.85rem' }}
          />
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
        <button className="btn btn-outline btn-small" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button
          className={confirmClass || 'btn btn-danger btn-small'}
          onClick={onConfirm}
          disabled={!isConfirmEnabled}
        >
          {confirmLabel || t('common.delete', 'Delete')}
        </button>
      </div>
    </Modal>
  );
}

export default ConfirmModal;
