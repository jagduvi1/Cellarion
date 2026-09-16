import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { cabinetShelfAlternate } from '../../utils/rackLayouts';

/**
 * Rename a rack and set its group — the room or appliance it belongs to
 * (support ticket 2026-09-06: "the basement is not one rack, it is several").
 * The group input suggests the cellar's existing group names so "Basement"
 * keeps one spelling across racks; an empty group means ungrouped.
 *
 * For a wine cabinet it also edits the two DRAWING-ONLY options, two-deep and
 * nesting: both change how the cabinet is drawn and neither changes its
 * capacity or where a bottle sits, so they are safe to flip on a loaded rack —
 * except two-deep on a cabinet whose rows alternate, where it decides which
 * rows are the narrow ones (6/5 vs 5/6) and so is part of the shape.
 * The shape itself (shelves, bottles across, rows per shelf, and whether the
 * rows alternate in width) stays creation-only, because changing it would
 * renumber the slots and move every bottle — same reason the honeycomb
 * options are creation-only. On a cabinet whose rows alternate, nesting is
 * implied (a narrow row lies in the grooves of the wide row below), so the
 * nesting box is shown ticked and locked.
 */
export default function EditRackModal({ rack, groups = [], onSave, onClose }) {
  const { t } = useTranslation();
  const [name, setName] = useState(rack.name || '');
  const [group, setGroup] = useState(rack.group || '');
  const isCabinet = rack.type === 'cabinet' && !rack.isModular;
  // Nesting is implied on every bay that alternates; the box is locked only
  // when all of them do (otherwise it still governs the other bays).
  const altList = isCabinet ? cabinetShelfAlternate(rack.rows, rack.typeConfig) : [];
  const alternate = isCabinet && altList.every(Boolean);
  // Two-deep decides which rows of an alternating bay are the narrow ones, so
  // on such a cabinet it stays as created; the route refuses the flip on a
  // loaded rack (audit 2026-09-16).
  const anyAlternate = altList.some(Boolean);
  const [twoDeep, setTwoDeep] = useState(rack.typeConfig?.twoDeep !== false);
  const [stagger, setStagger] = useState(alternate || rack.typeConfig?.stagger !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    const trimmed = name.trim();
    if (!trimmed) { setError(t('racks.nameRequired', 'Give the rack a name.')); return; }
    setSaving(true);
    setError('');
    // A cabinet's typeConfig is replaced wholesale by the route, so send the
    // stored shape back untouched alongside the two flags being changed.
    const result = await onSave({
      name: trimmed,
      group: group.trim(),
      ...(isCabinet ? { typeConfig: { ...(rack.typeConfig || {}), twoDeep, stagger } } : {}),
    });
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

        {isCabinet && (
          <>
            <label className="form-group">
              <span>
                <input type="checkbox" checked={twoDeep} onChange={(e) => setTwoDeep(e.target.checked)} disabled={saving || anyAlternate} />
                {' '}{t('racks.cabinetTwoDeepLabel', 'Two deep (neck to neck)')}
              </span>
            </label>
            <label className="form-group">
              <span>
                <input type="checkbox" checked={stagger} onChange={(e) => setStagger(e.target.checked)} disabled={saving || alternate} />
                {' '}{t('racks.cabinetStaggerLabel', 'Stacked rows nest (staggered)')}
              </span>
            </label>
            <small className="help-text">
              {anyAlternate ? `${t('racks.cabinetTwoDeepLocked', 'Two deep is part of the shape on a cabinet whose rows alternate — it sets which rows are the narrow ones — so it stays as created.')} ` : ''}
              {alternate ? `${t('racks.cabinetAlternateNests', 'Rows that alternate in width always nest: each narrow row lies in the grooves of the wide row below it.')} ` : ''}
              {t('racks.cabinetEditHint', 'Both options only change how the cabinet is drawn — the number of bottles it holds and where each bottle sits stay the same. To change the shelves themselves, create a new cabinet.')}
            </small>
          </>
        )}

        {error && <p className="error-message" role="alert">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? t('common.saving') : t('racks.saveRack')}</button>
        </div>
      </form>
    </Modal>
  );
}
