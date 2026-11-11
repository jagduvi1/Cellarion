import { useState, useEffect, useMemo, Suspense } from 'react';
import { lazy } from '../../utils/lazyWithReload';
import { useTranslation } from 'react-i18next';
import { getTotalSlots } from '../../utils/rackLayouts';
import RackRenderer from './RackRenderer';
import RackTypeSelector, { TYPE_DIMENSIONS } from './RackTypeSelector';
import CabinetShapeFields from './CabinetShapeFields';
import BetaBadge from '../BetaBadge';
import { useFeature } from '../../utils/featureFlags';
// Lazy: ShelfView3D pulls in three.js; the form loads it only when its 3D
// preview is shown.
const ShelfView3D = lazy(() => import('./ShelfView3D'));

// Parse a comma-separated "double-height rows" input ("1, 3") into a
// deduplicated array of positive integers. Range-checking against the row
// count happens when the racks page creates the rack (handleCreateRack; the
// rows input can change afterwards) and defensively in the layout/geometry
// helpers.
function parseDoubleHeightRows(text) {
  const seen = new Set();
  return String(text)
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => {
      if (!Number.isInteger(n) || n < 1 || n > 20 || seen.has(n)) return false;
      seen.add(n);
      return true;
    });
}

// How many stand-in bottles the 3D preview draws at most (see previewSlots).
const PREVIEW_FILL_MAX = 180;

/**
 * The form for a new rack: its name and group, its type with the fields that
 * type asks for, and a preview of the result (in 3D, or as the numbered
 * map). The racks page owns the rack being typed (`newRack`) and creates it
 * on submit.
 */
export default function NewRackForm({ newRack, setNewRack, onTypeChange, onSubmit, saving, groups = [] }) {
  const { t } = useTranslation();
  const headToTailOn = useFeature('cabinetHeadToTail');
  const sidewaysOn = useFeature('cabinetSideways');
  const dims = TYPE_DIMENSIONS[newRack.type] || TYPE_DIMENSIONS.grid;
  const [showPreview, setShowPreview] = useState(false);
  // Which preview to draw. A cabinet or an open shelf is about its SHAPE, so
  // it opens in 3D; flat types open as the numbered map, which is the only
  // view that shows slot numbering. Follows the type unless the user picks.
  const prefers3d = newRack.type === 'cabinet' || newRack.type === 'shelf';
  const [previewMode, setPreviewMode] = useState(prefers3d ? '3d' : 'map');
  useEffect(() => { setPreviewMode(prefers3d ? '3d' : 'map'); }, [prefers3d]);
  // Raw text of the double-height rows input (grid only). Kept as text so
  // partial input like "1," doesn't fight the parser; cleared when the rack
  // type changes (the parent resets typeConfig at the same time).
  const [doubleRowsText, setDoubleRowsText] = useState('');
  useEffect(() => { setDoubleRowsText(''); }, [newRack.type]);

  // Synthetic rack for the preview renderer. The 3D view is filled with
  // stand-in bottles so it reads as a loaded cabinet rather than an empty
  // box; the map stays empty because its job is to show slot NUMBERING, which
  // a bottle in every cell would cover up. Nothing here is ever saved.
  const previewCapacity = getTotalSlots(newRack.type, newRack.rows, newRack.cols, newRack.typeConfig);
  const previewSlots = useMemo(() => {
    if (previewMode !== '3d') return [];
    // A plausible cellar mix, weighted to red and white.
    const mix = ['red', 'white', 'red', 'sparkling', 'white', 'red', 'rosé', 'white', 'red', 'dessert'];
    // Each bottle is a four-mesh group with its own transmissive material, so
    // a 312-bottle cabinet (the largest preset) would cost ~1250 draw calls
    // and a hand-built shape far more. Fill the first PREVIEW_FILL_MAX cells
    // and leave the rest showing their rings — the shape still reads, and the
    // phone survives it.
    const filled = Math.min(previewCapacity, PREVIEW_FILL_MAX);
    return Array.from({ length: filled }, (_, i) => ({
      position: i + 1,
      bottle: { _id: `preview-${i + 1}`, wineDefinition: { _id: `preview-w-${i + 1}`, type: mix[i % mix.length] } },
    }));
  }, [previewMode, previewCapacity]);

  const previewRack = {
    _id: 'preview',
    name: newRack.name || t('racks.namePlaceholder', 'Preview'),
    type: newRack.type,
    rows: newRack.rows,
    cols: newRack.cols,
    typeConfig: newRack.typeConfig,
    slots: previewSlots,
    isModular: false,
  };

  return (
    <>
    <form className="card new-rack-form" onSubmit={onSubmit}>
      <h3>{t('racks.newRackTitle')}</h3>

      <RackTypeSelector value={newRack.type} onChange={onTypeChange} />

      <div className="new-rack-fields">
        <div className="form-group">
          <label>{t('racks.nameLabel')}</label>
          <input
            type="text"
            value={newRack.name}
            onChange={e => setNewRack({ ...newRack, name: e.target.value })}
            placeholder={t('racks.namePlaceholder')}
            required
          />
        </div>

        <div className="form-group">
          <label>{t('racks.groupLabel', 'Group')}</label>
          <input
            type="text"
            list="new-rack-group-options"
            value={newRack.group || ''}
            onChange={e => setNewRack({ ...newRack, group: e.target.value })}
            placeholder={t('racks.groupPlaceholder', 'e.g. Basement, Kitchen fridge')}
            maxLength={40}
          />
          <datalist id="new-rack-group-options">
            {groups.map(g => <option key={g} value={g} />)}
          </datalist>
          <small className="help-text">{t('racks.groupHint', 'Optional. Racks with the same group are shown together — a room, a fridge, a cooler. Leave it empty for no group.')}</small>
        </div>

        {dims.showRows && (
          <div className="form-group">
            <label>{t(dims.rowLabel || 'racks.rowsLabel')}</label>
            <input
              type="number"
              inputMode="numeric"
              min={1} max={20}
              value={newRack.rows}
              onChange={e => setNewRack({ ...newRack, rows: parseInt(e.target.value) || dims.defaultRows })}
            />
          </div>
        )}

        {dims.showCols && (
          <div className="form-group">
            <label>{t(dims.colLabel || 'racks.colsLabel')}</label>
            <input
              type="number"
              inputMode="numeric"
              min={1} max={20}
              value={newRack.cols}
              onChange={e => setNewRack({ ...newRack, cols: parseInt(e.target.value) || dims.defaultCols })}
            />
          </div>
        )}

        {dims.showDoubleHeightRows && (
          <div className="form-group">
            <label>{t('racks.doubleHeightRowsLabel', 'Double-height rows')}</label>
            <input
              type="text"
              value={doubleRowsText}
              placeholder={t('racks.doubleHeightRowsPlaceholder', 'e.g. 1,3')}
              onChange={e => {
                const text = e.target.value;
                setDoubleRowsText(text);
                const parsed = parseDoubleHeightRows(text);
                setNewRack({
                  ...newRack,
                  typeConfig: {
                    ...newRack.typeConfig,
                    doubleHeightRows: parsed.length > 0 ? parsed : undefined,
                  },
                });
              }}
            />
            <small style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
              {t('racks.doubleHeightRowsHelp', 'Rows with headroom for bottles resting on top')}
            </small>
          </div>
        )}

        {dims.showHexFlip && (
          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={!!newRack.typeConfig?.hexFlip}
                onChange={e => setNewRack({
                  ...newRack,
                  typeConfig: { ...newRack.typeConfig, hexFlip: e.target.checked || undefined }
                })}
              />
              {' '}{t('racks.hexFlipLabel', 'Flip rows (short row on top)')}
            </label>
            <small style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
              {t('racks.hexFlipHelp', 'By default the top row is full width. Enable this to mirror the rows top-to-bottom.')}
            </small>
          </div>
        )}

        {dims.showHexFlip && (
          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={!!newRack.typeConfig?.hexEqualRows}
                onChange={e => setNewRack({
                  ...newRack,
                  typeConfig: { ...newRack.typeConfig, hexEqualRows: e.target.checked || undefined }
                })}
              />
              {' '}{t('racks.hexEqualRowsLabel', 'Equal rows (staggered)')}
            </label>
            <small style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
              {t('racks.hexEqualRowsHelp', 'Every row holds the full number of columns, offset by half a bottle — like the top and bottom shelves of many wine fridges.')}
            </small>
          </div>
        )}

        {dims.showModule && (
          <>
            <div className="form-group">
              <label>{t('racks.moduleRowsLabel')}</label>
              <input
                type="number"
                inputMode="numeric"
                min={1} max={10}
                value={newRack.typeConfig?.moduleRows || 2}
                onChange={e => setNewRack({
                  ...newRack,
                  typeConfig: { ...newRack.typeConfig, moduleRows: parseInt(e.target.value) || 2 }
                })}
              />
            </div>
            <div className="form-group">
              <label>{t('racks.moduleColsLabel')}</label>
              <input
                type="number"
                inputMode="numeric"
                min={1} max={10}
                value={newRack.typeConfig?.moduleCols || 2}
                onChange={e => setNewRack({
                  ...newRack,
                  typeConfig: { ...newRack.typeConfig, moduleCols: parseInt(e.target.value) || 2 }
                })}
              />
            </div>
          </>
        )}

        {dims.showCabinet && (
          <CabinetShapeFields newRack={newRack} setNewRack={setNewRack} />
        )}

        {dims.showBottlesPerCell && (
          <div className="form-group">
            <label>{t('racks.bottlesPerCellLabel', 'Bottles per cell')}</label>
            <input
              type="number"
              inputMode="numeric"
              min={1} max={20}
              value={newRack.typeConfig?.bottlesPerCell || 1}
              onChange={e => setNewRack({
                ...newRack,
                typeConfig: { ...newRack.typeConfig, bottlesPerCell: parseInt(e.target.value) || 1 }
              })}
            />
          </div>
        )}

        {dims.showBackCols && (
          <div className="form-group">
            <label>{t('racks.backColsLabel', 'Back row bottles (per shelf)')}</label>
            <input
              type="number"
              inputMode="numeric"
              min={0} max={20}
              value={newRack.typeConfig?.backCols ?? 0}
              onChange={e => setNewRack({
                ...newRack,
                typeConfig: { ...newRack.typeConfig, backCols: Math.max(0, parseInt(e.target.value) || 0) }
              })}
            />
          </div>
        )}

        {dims.showBottlesPerSection && (
          <div className="form-group">
            <label>{t('racks.bottlesPerSectionLabel', 'Bottles per section')}</label>
            <input
              type="number"
              inputMode="numeric"
              min={1} max={30}
              value={newRack.typeConfig?.bottlesPerSection || 10}
              onChange={e => setNewRack({
                ...newRack,
                typeConfig: { ...newRack.typeConfig, bottlesPerSection: parseInt(e.target.value) || 10 }
              })}
            />
          </div>
        )}

        <button
          type="button"
          className={`btn btn-secondary new-rack-preview-toggle ${showPreview ? 'active' : ''}`}
          onClick={() => setShowPreview(p => !p)}
        >
          {showPreview ? t('racks.hidePreview', 'Hide preview') : t('racks.preview', 'Preview')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? t('racks.creating') : t('racks.createRack')}
        </button>
      </div>

      <div className="new-rack-preview-hint">
        {t('racks.totalSlots')}: {previewCapacity}
      </div>

      {showPreview && (
        <div className="new-rack-preview-panel">
          <div className="new-rack-preview-head">
            <div className="new-rack-preview-label">
              {t('racks.previewLabel', 'Preview — this is how the rack will look once created')}
            </div>
            <div className="rack-view-mode-toggle" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={previewMode === '3d'}
                className={`view-mode-btn ${previewMode === '3d' ? 'active' : ''}`}
                onClick={() => setPreviewMode('3d')}
              >
                {t('racks.view3d')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={previewMode === 'map'}
                className={`view-mode-btn ${previewMode === 'map' ? 'active' : ''}`}
                onClick={() => setPreviewMode('map')}
              >
                {t('racks.viewCompact')}
              </button>
            </div>
          </div>
          <div className={`new-rack-preview-canvas ${previewMode === '3d' ? 'new-rack-preview-canvas--3d' : ''}`}>
            {previewMode === '3d' ? (
              <Suspense fallback={<div className="loading">{t('common.loading')}</div>}>
                {/* pullOut={false}: a look-only preview, so every free cell
                    shows its ring instead of hiding inside a closed cabinet. */}
                <ShelfView3D rack={previewRack} pullOut={false} />
              </Suspense>
            ) : (
              <RackRenderer
                rack={previewRack}
                canEdit={false}
                onSlotClick={() => {}}
              />
            )}
          </div>
        </div>
      )}
    </form>
    {/* Outside the form: the feedback dialog has a form of its own, and a
        submit inside this one would create the rack. */}
    {newRack.type === 'cabinet' && headToTailOn && (
      <BetaBadge feature="cabinetHeadToTail" note={t('racks.cabinetHeadToTailBeta', 'Bottles head to tail is in early access.')} />
    )}
    {newRack.type === 'cabinet' && sidewaysOn && (
      <BetaBadge feature="cabinetSideways" note={t('racks.cabinetSidewaysBeta', 'Bottles lying sideways is in early access.')} />
    )}
    </>
  );
}
