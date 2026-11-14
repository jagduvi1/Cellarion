import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CABINET_PRESETS, CABINET_PRESET_GROUPS, CABINET_MAX_ROWS_PER_SHELF, fitShelfRows, cabinetCapacity } from '../../utils/cabinetPresets';
import { cabinetShelfCols, cabinetShelfAlternate, cabinetShelfSideways } from '../../utils/rackLayouts';
import { useFeature } from '../../utils/featureFlags';
import IntegerField from '../IntegerField';

// The shape of a wine cabinet in the new-rack form: preset, rows of bottles
// per shelf, two deep.
// A preset is a STARTING shape — makers ship sliding shelves and tell owners
// to pull shelves out and stack bottles, so two owners of one model end up
// with different layouts. The per-shelf list is always kept the length of the
// shelves input (fitShelfRows) so a changed shelf count never desyncs it.
// `alternate` (rows alternate cols / cols−1, the honeycomb of a Liebherr
// GrandCru shelf) changes capacity and the slot
// numbering, so unlike two-deep and nesting it is offered here only, never
// in the edit dialog; and since a narrow row can only nest, it forces nesting.
// Every shelf can then differ from the cabinet — its rows, its width and its
// pattern — so a preset is the maker's loading diagram and the owner edits it
// into their own cabinet (a GrandCru 5001, for one, has 4-wide staggered
// shelves top and bottom around 6-wide honeycomb ones).
export default function CabinetShapeFields({ newRack, setNewRack }) {
  const { t } = useTranslation();
  const [presetKey, setPresetKey] = useState('custom');
  const shelfRows = fitShelfRows(newRack.typeConfig?.shelfRows, newRack.rows);
  const shelfCols = cabinetShelfCols(newRack.rows, newRack.cols, newRack.typeConfig);
  const shelfAlt = cabinetShelfAlternate(newRack.rows, newRack.typeConfig);
  const twoDeep = newRack.typeConfig?.twoDeep !== false;
  const alternate = newRack.typeConfig?.alternate === true;
  const allAlternate = shelfAlt.length > 0 && shelfAlt.every(Boolean);
  const stagger = allAlternate || newRack.typeConfig?.stagger !== false;
  const headToTailOn = useFeature('cabinetHeadToTail');
  const headToTail = !twoDeep && newRack.typeConfig?.headToTail === true;
  // How each shelf's bottles lie (early access, 'cabinetSideways'): the
  // per-shelf choice and the presets built on it show only with the flag.
  const sidewaysOn = useFeature('cabinetSideways');
  const shelfSide = cabinetShelfSideways(newRack.rows, newRack.typeConfig);
  const presetShown = (p) => !p.feature || (p.feature === 'cabinetSideways' && sidewaysOn);
  const preset = CABINET_PRESETS.find((p) => p.key === presetKey);
  // The shelves / bottles-across inputs live in the parent form, so editing
  // them must drop the preset label: the shape is no longer that model.
  useEffect(() => {
    if (preset && (newRack.rows !== preset.shelves || newRack.cols !== preset.cols)) setPresetKey('custom');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newRack.rows, newRack.cols]);

  const applyPreset = (key) => {
    setPresetKey(key);
    const p = CABINET_PRESETS.find((x) => x.key === key);
    if (!p) return;
    setNewRack({
      ...newRack,
      rows: p.shelves,
      cols: p.cols,
      typeConfig: {
        ...newRack.typeConfig,
        shelfRows: [...p.shelfRows], twoDeep: p.twoDeep, stagger: p.stagger !== false, alternate: p.alternate === true,
        shelfCols: p.shelfCols ? [...p.shelfCols] : undefined,
        shelfAlternate: p.shelfAlternate ? [...p.shelfAlternate] : undefined,
        shelfSideways: p.shelfSideways ? [...p.shelfSideways] : undefined,
      },
    });
  };
  const setShelf = (patch) => {
    setPresetKey('custom');
    setNewRack({ ...newRack, typeConfig: { ...newRack.typeConfig, ...patch } });
  };
  const setRow = (i, rows) => {
    const next = [...shelfRows];
    next[i] = rows;
    setShelf({ shelfRows: next });
  };
  const setWidth = (i, across) => {
    const next = [...shelfCols];
    next[i] = across;
    setShelf({ shelfCols: next });
  };
  const setPattern = (i, value) => {
    const next = [...shelfAlt];
    next[i] = !!value;
    setShelf({ shelfAlternate: next });
  };
  const setSide = (i, value) => {
    const next = [...shelfSide];
    next[i] = value;
    setShelf({ shelfSideways: next });
  };

  return (
    <>
      <div className="form-group">
        <label>{t('racks.cabinetPresetLabel', 'Start from')}</label>
        <select value={presetKey} onChange={(e) => applyPreset(e.target.value)}>
          <option value="custom">{t('racks.cabinetPresetCustom', 'Custom shape')}</option>
          {CABINET_PRESET_GROUPS.filter((group) => CABINET_PRESETS.some((p) => p.group === group && presetShown(p))).map((group) => (
            <optgroup key={group} label={t(`racks.cabinetPresetGroup_${group}`, group)}>
              {CABINET_PRESETS.filter((p) => p.group === group && presetShown(p)).map((p) => (
                <option key={p.key} value={p.key}>{t(`racks.cabinetPreset_${p.key}`, p.key)}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <small style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
          {t('racks.cabinetPresetHint', 'Starting shapes only. Owners pull shelves out and stack bottles, so edit the rows below to match your cabinet.')}
          {preset?.capacity
            ? ` ${t('racks.cabinetPresetCapacity', 'The maker quotes {{model}} bottles; this shape holds {{shape}}.', { model: preset.capacity, shape: cabinetCapacity(newRack.cols, shelfRows, newRack.typeConfig) })}`
            : ''}
        </small>
      </div>

      <div className="form-group">
        <label>{t('racks.cabinetShelfRowsLabel', 'Each shelf, top shelf first: rows of bottles, bottles across, rows alternating')}</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {shelfRows.map((v, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.35rem 0.6rem', fontSize: '0.85rem' }}>
              <span style={{ minWidth: '4.5rem' }}>{t('racks.cabinetShelfN', { n: i + 1 })}</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <IntegerField
                  min={1} max={CABINET_MAX_ROWS_PER_SHELF}
                  value={v}
                  onCommit={(rows) => setRow(i, rows)}
                  style={{ width: '4.2rem' }}
                  aria-label={`${t('racks.cabinetShelfN', { n: i + 1 })} ${t('racks.cabinetShelfRowsShort', 'rows')}`}
                />
                <span>{t('racks.cabinetShelfRowsShort', 'rows')}</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <IntegerField
                  min={1} max={newRack.cols || 1}
                  value={shelfCols[i]}
                  onCommit={(across) => setWidth(i, across)}
                  style={{ width: '4.2rem' }}
                  aria-label={`${t('racks.cabinetShelfN', { n: i + 1 })} ${t('racks.cabinetShelfAcrossShort', 'across')}`}
                />
                <span>{t('racks.cabinetShelfAcrossShort', 'across')}</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <input
                  type="checkbox"
                  checked={shelfAlt[i]}
                  onChange={(e) => setPattern(i, e.target.checked)}
                  aria-label={`${t('racks.cabinetShelfN', { n: i + 1 })} ${t('racks.cabinetShelfAlternateShort', '6 / 5 alternating')}`}
                />
                <span>{t('racks.cabinetShelfAlternateShort', '6 / 5 alternating')}</span>
              </label>
              {sidewaysOn && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <span>{t('racks.cabinetShelfSidewaysShort', 'bottles lie')}</span>
                  <select
                    value={shelfSide[i]}
                    onChange={(e) => setSide(i, e.target.value)}
                    aria-label={`${t('racks.cabinetShelfN', { n: i + 1 })} ${t('racks.cabinetShelfSidewaysShort', 'bottles lie')}`}
                  >
                    <option value="">{t('racks.cabinetSidewaysNone', 'front to back')}</option>
                    <option value="front">{t('racks.cabinetSidewaysFront', 'one across the front')}</option>
                    <option value="all">{t('racks.cabinetSidewaysAll', 'all across')}</option>
                  </select>
                </label>
              )}
            </div>
          ))}
        </div>
        <small style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
          {t('racks.cabinetShelfRowsHelp', 'Rows: 1 = a sliding shelf with a single row, more = a stacking bay. Across: a shelf narrower than the cabinet is drawn centred. Alternating: the rows of that shelf go full width, one fewer, full width … (6 in front of 5, then 5 in front of 6). The maker\'s presets fill this in; change any shelf to match how you load yours.')}
          {sidewaysOn ? ` ${t('racks.cabinetSidewaysHelp', 'Bottles lie: front to back, one bottle lying across the front of the others (as in a slim fridge), or all lying across (as in a bottom bin). On a shelf stacked in levels of a one-deep cabinet, the level above a bottle lying across rests on the bottles behind it, so it holds one fewer. Otherwise the number of bottles and the slot numbers stay the same.')}` : ''}
        </small>
      </div>

      <div className="form-group">
        <label>
          <input
            type="checkbox"
            checked={twoDeep}
            onChange={(e) => setNewRack({ ...newRack, typeConfig: { ...newRack.typeConfig, twoDeep: e.target.checked } })}
          />
          {' '}{t('racks.cabinetTwoDeepLabel', 'Two deep (neck to neck)')}
        </label>
        <small style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
          {t('racks.cabinetTwoDeepHelp', 'Bottles lie neck to neck, two rows per level. This changes how the cabinet is drawn, not how many bottles it holds.')}
        </small>
      </div>

      <div className="form-group">
        <label>
          <input
            type="checkbox"
            checked={alternate}
            onChange={(e) => {
              // The cabinet-wide setting: every shelf follows it until one is changed.
              setShelf({ alternate: e.target.checked, shelfAlternate: undefined });
            }}
          />
          {' '}{t('racks.cabinetAlternateLabel', 'Rows alternate in width on every shelf (6 / 5 / 6 …)')}
        </label>
        <small style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
          {t('racks.cabinetAlternateHelp', 'The first level holds a full row in front of one bottle fewer behind it; the level above nests in its grooves, one fewer in front of a full row, and so on — the honeycomb of a Liebherr GrandCru shelf. Sets every shelf at once; untick single shelves above. This changes how many bottles the cabinet holds, so it is set when the cabinet is created.')}
        </small>
      </div>

      <div className="form-group">
        <label>
          <input
            type="checkbox"
            checked={stagger}
            disabled={allAlternate}
            onChange={(e) => setNewRack({ ...newRack, typeConfig: { ...newRack.typeConfig, stagger: e.target.checked } })}
          />
          {' '}{t('racks.cabinetStaggerLabel', 'Stacked rows nest (staggered)')}
        </label>
        <small style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
          {allAlternate
            ? t('racks.cabinetAlternateNests', 'Rows that alternate in width always nest: each narrow row lies in the grooves of the wide row below it.')
            : t('racks.cabinetStaggerHelp', 'Each stacked row sits in the grooves of the row below, offset half a bottle, the way bottles actually stack on a shelf. Turn it off for rows stacked squarely on top of each other. Drawing only — the number of bottles is the same.')}
        </small>
      </div>

      {headToTailOn && (
        <div className="form-group">
          <label>
            <input
              type="checkbox"
              checked={headToTail}
              disabled={twoDeep}
              onChange={(e) => setNewRack({ ...newRack, typeConfig: { ...newRack.typeConfig, headToTail: e.target.checked } })}
            />
            {' '}{t('racks.cabinetHeadToTailLabel', 'Bottles lie head to tail')}
          </label>
          <small style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
            {twoDeep
              ? t('racks.cabinetHeadToTailNeedsSingle', 'Head to tail is for bottles that lie one deep: untick Two deep first.')
              : t('racks.cabinetHeadToTailHelp', 'For bottles that lie one deep, base forward and neck forward in turn, so a row fits more. Every other bottle is drawn neck forward. Drawing only — the number of bottles and the slot numbers stay the same.')}
          </small>
        </div>
      )}
    </>
  );
}
