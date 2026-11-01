import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { PRESERVATION_METHODS } from '../../utils/openBottle';
import TakeOutOfRackChoice, { takeOutState } from './TakeOutOfRackChoice';
import './PreservationPickerModal.css';

/**
 * Preservation-method picker used by the "just a glass — keep the bottle"
 * flow in the rack views. Confirming reports the chosen method and whether
 * the bottle leaves its rack slot (onConfirm(method, takeOutOfRack)); the
 * caller opens the bottle, records the pour and navigates on.
 */
export default function PreservationPickerModal({ onConfirm, onClose, busy }) {
  const { t } = useTranslation();
  const [method, setMethod] = useState('coravin');
  // null: follow the method's default; true/false once the user chose.
  const [takeOutTouched, setTakeOutTouched] = useState(null);
  const takeOut = takeOutState(method, takeOutTouched);

  return (
    <Modal title={t('openBottle.pickerTitle', 'Open this bottle')} onClose={busy ? undefined : onClose} showClose={!busy}>
      <p>{t('openBottle.pickerText', 'How will you preserve it? This sets the drink-by window — the bottle stays in your cellar until you finish it.')}</p>
      <div className="bd-open-methods">
        {PRESERVATION_METHODS.map(m => (
          <label key={m.id} className={`bd-open-method ${method === m.id ? 'active' : ''}`}>
            <input
              type="radio"
              name="partial-preservation"
              value={m.id}
              checked={method === m.id}
              onChange={() => setMethod(m.id)}
              disabled={busy}
            />
            <span>
              <strong>{t(`openBottle.method.${m.id}`, m.id)}</strong>
              <small>{t('openBottle.freshness', 'about {{days}} days', { days: m.freshnessDays })}</small>
            </span>
          </label>
        ))}
      </div>
      {/* Opened from a rack slot, so the bottle is in a rack. */}
      <TakeOutOfRackChoice checked={takeOut} onChange={setTakeOutTouched} disabled={busy} />
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button className="btn btn-primary" onClick={() => onConfirm(method, takeOut)} disabled={busy}>
          {busy ? t('common.saving', 'Saving...') : t('openBottle.partialConfirmBtn', 'Open & pour a glass')}
        </button>
      </div>
    </Modal>
  );
}
