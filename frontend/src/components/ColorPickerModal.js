import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { updateCellarColor } from '../api/cellars';
import CellarColorPicker from './CellarColorPicker';
import Modal from './Modal';

export function ColorPickerModal({ currentColor, cellarId, onSaved, onClose }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [color, setColor] = useState(currentColor || null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await updateCellarColor(apiFetch, cellarId, color);
      if (res.ok) onSaved(color);
    } catch {}
    setSaving(false);
  };

  return (
    <Modal title={t('cellarDetail.myCellarColor')} onClose={onClose}>
      <p className="modal-subtitle">{t('cellarDetail.colorOnlyYou')}</p>
      <CellarColorPicker value={color} onChange={setColor} />
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </Modal>
  );
}
