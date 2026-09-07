import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';

/**
 * Rename a rack and set its group — the room or appliance it belongs to
 * (support ticket 2026-09-06: "the basement is not one rack, it is several").
 * The group input suggests the cellar's existing group names so "Basement"
 * keeps one spelling across racks; an empty group means ungrouped.
 */
export default function EditRackModal({ rack, groups = [], onSave, onClose }) {
  const { t } = useTranslation();
  const [name, setName] = useState(rack.name || '');
  const [group, setGroup] = useState(rack.group || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    const trimmed = name.trim();
    if (!trimmed) { setError(t('racks.nameRequired', 'Give the rack a name.')); return; }
    setSaving(true);
    setError('');
    const result = await onSave({ name: trimmed, group: group.trim() });
    if (result?.ok) {
      onClose();
    } else {
      setError(result?.error || t('racks.editFailed', 'Could not save the rack.'));
      setSaving(false);
    }
  };

  return (
    <Modal title={t('racks.editRackTitle', 'Rack name and group')} onClose={onClose} showClose trapFocus>
      <form onSubmit={submit} className="edit-rack-form">
        <label className="form-group">
          <span>{t('racks.nameLabel')}</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required disabled={saving} autoFocus />
        </label>
        <label className="form-group">
          <span>{t('racks.groupLabel', 'Group')}</span>
          <input
            type="text"
            list="edit-rack-group-options"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            maxLength={40}
            placeholder={t('racks.groupPlaceholder', 'e.g. Basement, Kitchen fridge')}
            disabled={saving}
          />
          <datalist id="edit-rack-group-options">
            {groups.map((g) => <option key={g} value={g} />)}
          </datalist>
          <small className="help-text">{t('racks.groupHint', 'Optional. Racks with the same group are shown together — a room, a fridge, a cooler. Leave it empty for no group.')}</small>
        </label>

        {error && <p className="error-message" role="alert">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? t('common.saving') : t('racks.saveRack')}</button>
        </div>
      </form>
    </Modal>
  );
}
