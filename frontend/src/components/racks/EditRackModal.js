import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import BetaBadge from '../BetaBadge';
import { cabinetShelfAlternate, cabinetShelfSideways } from '../../utils/rackLayouts';
import { useFeature } from '../../utils/featureFlags';

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
 * Head to tail (early access, 'cabinetHeadToTail') is drawing only too, and
 * only for a one-deep cabinet: ticking Two deep clears it. A cabinet that
 * already has it keeps the box in view, so it can be switched off again
 * after early access is.
 * How each shelf's bottles lie (early access, 'cabinetSideways': front to
 * back, one across the front, all across) is drawing only as well, so it is
 * edited here on a loaded cabinet; a cabinet that already has a sideways
 * shelf keeps the choice in view, like head to tail.
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
  const [headToTail, setHeadToTail] = useState(rack.typeConfig?.headToTail === true);
  // Not where Two deep is locked on (rows that alternate): it could never be
  // ticked there (release audit 2026-10-12).
  const showHeadToTail = (useFeature('cabinetHeadToTail') || rack.typeConfig?.headToTail === true)
    && !(anyAlternate && twoDeep);
  const storedSide = isCabinet ? cabinetShelfSideways(rack.rows, rack.typeConfig) : [];
  const [sideways, setSideways] = useState(storedSide);
  const sidewaysOn = useFeature('cabinetSideways');
  const showSideways = isCabinet && (sidewaysOn || storedSide.some(Boolean));
  const setSide = (i, value) => setSideways((prev) => prev.map((v, k) => (k === i ? value : v)));
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
    // stored shape back untouched alongside the flags being changed. The lie
    // list is stored only while some shelf lies sideways.
    const lie = showSideways ? { shelfSideways: sideways.some(Boolean) ? sideways : undefined } : {};
    const result = await onSave({
      name: trimmed,
      group: group.trim(),
      ...(isCabinet ? { typeConfig: { ...(rack.typeConfig || {}), twoDeep, stagger, headToTail: !twoDeep && headToTail, ...lie } } : {}),
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
            {showHeadToTail && (
              <>
                <label className="form-group">
                  <span>
                    <input type="checkbox" checked={!twoDeep && headToTail} onChange={(e) => setHeadToTail(e.target.checked)} disabled={saving || twoDeep} aria-describedby="edit-rack-h2t-help" />
                    {' '}{t('racks.cabinetHeadToTailLabel', 'Bottles lie head to tail')}
                  </span>
                </label>
                <small className="help-text edit-rack-option-help" id="edit-rack-h2t-help">
                  {twoDeep
                    ? t('racks.cabinetHeadToTailNeedsSingle', 'Head to tail is for bottles that lie one deep: untick Two deep first.')
                    : t('racks.cabinetHeadToTailHelp', 'For bottles that lie one deep, base forward and neck forward in turn, so a row fits more. Every other bottle is drawn neck forward. Drawing only — the number of bottles and the slot numbers stay the same.')}
                </small>
              </>
            )}
            {showSideways && (
              <fieldset className="form-group edit-rack-sideways">
                <legend>{t('racks.cabinetSidewaysEditLabel', 'How each shelf\'s bottles lie')}</legend>
                {sideways.map((v, i) => (
                  <label key={i} className="edit-rack-sideways-row">
                    <span>{t('racks.cabinetShelfN', { n: i + 1 })}</span>
                    <select value={v} onChange={(e) => setSide(i, e.target.value)} disabled={saving}>
                      <option value="">{t('racks.cabinetSidewaysNone', 'front to back')}</option>
                      <option value="front">{t('racks.cabinetSidewaysFront', 'one across the front')}</option>
                      <option value="all">{t('racks.cabinetSidewaysAll', 'all across')}</option>
                    </select>
                  </label>
                ))}
                <small className="help-text edit-rack-option-help">
                  {t('racks.cabinetSidewaysHelp', 'Bottles lie: front to back, one bottle lying across the front of the others (as in a slim fridge), or all lying across (as in a bottom bin). Drawing only: the number of bottles and the slot numbers stay the same.')}
                </small>
              </fieldset>
            )}
            <small className="help-text">
              {anyAlternate ? `${t('racks.cabinetTwoDeepLocked', 'Two deep is part of the shape on a cabinet whose rows alternate — it sets which rows are the narrow ones — so it stays as created.')} ` : ''}
              {alternate ? `${t('racks.cabinetAlternateNests', 'Rows that alternate in width always nest: each narrow row lies in the grooves of the wide row below it.')} ` : ''}
              {t('racks.cabinetEditHint', 'These options only change how the cabinet is drawn — the number of bottles it holds and where each bottle sits stay the same. To change the shelves themselves, create a new cabinet.')}
            </small>
          </>
        )}

        {error && <p className="error-message" role="alert">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? t('common.saving') : t('racks.saveRack')}</button>
        </div>
      </form>
      {/* Outside the form: the feedback dialog has a form of its own, and a
          submit inside this one saved the rack (release audit 2026-10-12). */}
      {isCabinet && showHeadToTail && (
        <BetaBadge feature="cabinetHeadToTail" note={t('racks.cabinetHeadToTailBeta', 'Bottles head to tail is in early access.')} />
      )}
      {showSideways && (
        <BetaBadge feature="cabinetSideways" note={t('racks.cabinetSidewaysBeta', 'Bottles lying sideways is in early access.')} />
      )}
    </Modal>
  );
}
