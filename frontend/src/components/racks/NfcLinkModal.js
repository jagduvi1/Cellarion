import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import DialogBox from '../DialogBox';

/**
 * Link a rack to an NFC tag. On a device that can write tags, the rack's
 * address is written to one; elsewhere the dialog shows the address to write
 * by hand and lets the user mark the rack as linked. `onSave` gets the rack's
 * id to mark it linked, or an empty string to unlink it.
 */
export default function NfcLinkModal({ rack, onSave, onCancel }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState('idle'); // idle | writing | success | error
  const [errorMsg, setErrorMsg] = useState('');
  const supportsNfc = typeof window !== 'undefined' && 'NDEFReader' in window;

  const nfcUrl = `${window.location.origin}/nfc/rack/${rack?._id}`;

  const handleWrite = async () => {
    if (!supportsNfc) return;
    setStatus('writing');
    setErrorMsg('');
    try {
      const reader = new window.NDEFReader();
      await reader.write({
        records: [{ recordType: 'url', data: nfcUrl }]
      });
      setStatus('success');
      // Save rfidTag marker on the rack
      onSave(rack._id);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err.message || t('nfc.writeFailed'));
    }
  };

  const handleUnlink = () => {
    onSave('');
  };

  return (
    <div className="slot-modal-overlay" onClick={onCancel}>
      <DialogBox
        className="slot-modal"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 400 }}
        onClose={onCancel}
        label={t('nfc.linkTitle')}
      >
        <div className="slot-popup-header">
          <span className="slot-popup-title">{t('nfc.linkTitle')}</span>
          <button className="slot-popup-close" onClick={onCancel} aria-label="Close">&times;</button>
        </div>
        <div style={{ padding: '1rem' }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', margin: '0 0 1rem' }}>
            {t('nfc.linkDescription')}
          </p>

          {rack?.rfidTag && (
            <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(var(--color-primary-rgb), 0.08)', borderRadius: 'var(--radius-sm)', marginBottom: '1rem', fontSize: '0.85rem' }}>
              {t('nfc.currentlyLinked')}
            </div>
          )}

          <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', wordBreak: 'break-all', marginBottom: '1rem', padding: '0.5rem', background: 'var(--color-surface-raised)', borderRadius: 'var(--radius-sm)' }}>
            <strong>URL:</strong> {nfcUrl}
          </div>

          {supportsNfc ? (
            <>
              <button
                className="btn btn-primary"
                onClick={handleWrite}
                disabled={status === 'writing'}
                style={{ width: '100%', marginBottom: '0.5rem' }}
              >
                {status === 'writing' ? t('nfc.writing') : t('nfc.writeToTag')}
              </button>
              {status === 'success' && (
                <p style={{ color: 'var(--color-success)', fontSize: '0.85rem', margin: '0.5rem 0 0' }}>
                  {t('nfc.writeSuccess')}
                </p>
              )}
              {status === 'error' && (
                <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem', margin: '0.5rem 0 0' }}>
                  {errorMsg}
                </p>
              )}
            </>
          ) : (
            <div style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
              <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>{t('nfc.notSupported')}</p>
              <p style={{ margin: 0 }}>{t('nfc.manualInstructions')}</p>
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
            {rack?.rfidTag && (
              <button className="btn btn-danger btn-small" onClick={handleUnlink}>
                {t('nfc.unlink')}
              </button>
            )}
            {!supportsNfc && !rack?.rfidTag && (
              <button className="btn btn-primary btn-small" onClick={() => onSave(rack._id)}>
                {t('nfc.markAsLinked')}
              </button>
            )}
          </div>
        </div>
      </DialogBox>
    </div>
  );
}
