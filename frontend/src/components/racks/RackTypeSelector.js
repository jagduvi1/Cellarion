import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { computeLayout, SLOT_RADIUS } from '../../utils/rackLayouts';
import { useFeature } from '../../utils/featureFlags';
import WallDecor from './WallDecor';
import './RackTypeSelector.css';

// In the order the form shows them: the plain grid, then the two that are
// built up from parts in the form (a wine cabinet's shelves, a wall's boxes),
// then the single shapes.
const RACK_TYPES = [
  { key: 'grid',     preview: { rows: 3, cols: 4 } },
  { key: 'cabinet',  preview: { rows: 3, cols: 3, typeConfig: { shelfRows: [1, 2, 3], twoDeep: false } } },
  // One rack built from boxes. Offered while its flag is on for this user
  // (backend config/featureFlags 'wallRack').
  {
    key: 'wall',
    feature: 'wallRack',
    preview: {
      rows: 2,
      cols: 2,
      typeConfig: {
        boxes: [
          { x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 3 },
          { x: 1, y: 0, w: 1, h: 1, kind: 'slash', perSection: 6 },
          { x: 0, y: 1, w: 1, h: 1, kind: 'rack', rows: 3, cols: 3 },
          { x: 1, y: 1, w: 1, h: 1, kind: 'closed' },
        ],
      },
    },
  },
  { key: 'x-rack',   preview: { rows: 1, cols: 1, typeConfig: { bottlesPerSection: 6 } } },
  { key: 'hex',      preview: { rows: 3, cols: 4 } },
  { key: 'triangle', preview: { rows: 1, cols: 4 } },
  { key: 'stack',    preview: { rows: 5, cols: 1 } },
  { key: 'cube',     preview: { rows: 2, cols: 2, typeConfig: { moduleRows: 2, moduleCols: 2 } } },
  { key: 'shelf',    preview: { rows: 3, cols: 2 } },
];

/** Dimension config: which inputs to show per type, with sensible defaults */
export const TYPE_DIMENSIONS = {
  grid:     { showRows: true,  showCols: true,  defaultRows: 4, defaultCols: 8, showDoubleHeightRows: true },
  'x-rack': { showRows: false, showCols: false, defaultRows: 1, defaultCols: 1, showBottlesPerSection: true },
  hex:      { showRows: true,  showCols: true,  defaultRows: 4, defaultCols: 5, showHexFlip: true },
  triangle: { showRows: false, showCols: true,  defaultRows: 1, defaultCols: 5, colLabel: 'racks.baseWidthLabel' },
  stack:    { showRows: true,  showCols: false, defaultRows: 8, defaultCols: 1, rowLabel: 'racks.heightLabel' },
  cube:     { showRows: true,  showCols: true,  defaultRows: 2, defaultCols: 3, showModule: true },
  shelf:    { showRows: true,  showCols: true,  defaultRows: 3, defaultCols: 2, showBottlesPerCell: true, showBackCols: true },
  // Wine cabinet: rows = shelves, cols = bottles across; the per-shelf stack
  // heights + two-deep flag live in typeConfig (see utils/cabinetPresets).
  cabinet:  { showRows: true,  showCols: true,  defaultRows: 5, defaultCols: 6, rowLabel: 'racks.shelvesLabel', colLabel: 'racks.bottlesAcrossLabel', showCabinet: true },
  // Wall: rows × cols are its cells, set in the builder along with the
  // boxes (components/racks/WallBuilder; the defaults are utils/wallEdit newWall).
  wall:     { showRows: false, showCols: false, defaultRows: 2, defaultCols: 2, showWall: true },
};

export default function RackTypeSelector({ value, onChange }) {
  const { t } = useTranslation();
  const wallOn = useFeature('wallRack');
  // A type behind a flag is offered while the flag is on, and stays in the
  // list while it is the one chosen.
  const types = RACK_TYPES.filter(({ key, feature }) => !feature || wallOn || value === key);

  return (
    <div className="rack-type-selector">
      <label className="rack-type-label">{t('racks.typeLabel')}</label>
      <div className="rack-type-options">
        {types.map(({ key, preview }) => (
          <button
            key={key}
            type="button"
            className={`rack-type-option ${value === key ? 'selected' : ''}`}
            onClick={() => onChange(key)}
            aria-pressed={value === key}
            title={t(`racks.type_${key}`)}
          >
            <MiniRackPreview type={key} {...preview} />
            <span className="rack-type-name">{t(`racks.type_${key}`)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MiniRackPreview({ type, rows, cols, typeConfig }) {
  const layout = useMemo(
    () => computeLayout(type, rows, cols, typeConfig),
    [type, rows, cols, typeConfig]
  );

  // Smaller for the thumbnail; a wall's cells are large, so its slots are
  // drawn nearer their own size to stay visible.
  const r = SLOT_RADIUS * (layout.wall ? 0.8 : 0.5);
  const CELL_SIZE = SLOT_RADIUS * 2 + 8;
  const half = CELL_SIZE / 2;
  const PAD = SLOT_RADIUS; // matches rackLayouts PADDING

  // Deduplicate positions for multi-bottle cells (shelf)
  const uniqueSlots = useMemo(() => {
    const seen = new Set();
    return layout.slots.filter(s => {
      const key = `${s.cx},${s.cy}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [layout.slots]);

  return (
    <svg
      viewBox={layout.wall
        // A wall without its letters and numbers: start at its first cell.
        ? `${layout.wall.origin.x - 8} ${layout.wall.origin.y - 8} ${layout.viewBox.width - layout.wall.origin.x + 2} ${layout.viewBox.height - layout.wall.origin.y + 2}`
        : `0 0 ${layout.viewBox.width} ${layout.viewBox.height}`}
      className="rack-type-preview-svg"
      aria-hidden="true"
    >
      {layout.wall ? (
        <WallDecor
          wall={layout.wall} fill="#C8AD82" frame="#9A7E58" shade={null} frameWidth={7} plankWidth={7}
          doorFill="#B89A6E" doorLine="#9A7E58" knob="#7A6240" showLabels={false}
        />
      ) : (
        <rect
          x={0} y={0}
          width={layout.viewBox.width}
          height={layout.viewBox.height}
          rx={4}
          fill={type === 'cabinet' ? '#2B2D31' : '#C8AD82'}
        />
      )}

      {/* X-Rack: two diagonal dividers forming an X */}
      {type === 'x-rack' && (
        <>
          <line x1={4} y1={4} x2={layout.viewBox.width - 4} y2={layout.viewBox.height - 4}
            stroke="#9A7E58" strokeWidth={3} opacity={0.7} />
          <line x1={layout.viewBox.width - 4} y1={4} x2={4} y2={layout.viewBox.height - 4}
            stroke="#9A7E58" strokeWidth={3} opacity={0.7} />
        </>
      )}

      {/* Shelf: horizontal plank lines between rows */}
      {type === 'shelf' && (() => {
        const rowCount = rows || 3;
        return Array.from({ length: rowCount - 1 }).map((_, i) => {
          const y = PAD + SLOT_RADIUS + (i + 1) * CELL_SIZE - half;
          return (
            <line key={`sp-${i}`} x1={4} y1={y} x2={layout.viewBox.width - 4} y2={y}
              stroke="#9A7E58" strokeWidth={3} opacity={0.5} />
          );
        });
      })()}

      {/* Cabinet: beech planks between bays, where the layout puts them */}
      {type === 'cabinet' && (layout.shelfYs || []).map((y, i) => (
        <line key={`cab-${i}`} x1={4} y1={y} x2={layout.viewBox.width - 4} y2={y}
          stroke="#D9B98A" strokeWidth={3} opacity={0.85} />
      ))}

      {/* Slots: rectangles for shelf, circles for others */}
      {type === 'shelf' ? uniqueSlots.map(({ position, cx, cy }) => (
        <rect
          key={position}
          x={cx - half * 0.85}
          y={cy - half * 0.85}
          width={half * 1.7}
          height={half * 1.7}
          fill="#B89A6E"
          stroke="#A08660"
          strokeWidth={1}
          rx={2}
        />
      )) : uniqueSlots.map(({ position, cx, cy }) => (
        <circle
          key={position}
          cx={cx}
          cy={cy}
          r={r}
          fill="#B89A6E"
          stroke="#A08660"
          strokeWidth={1}
        />
      ))}
    </svg>
  );
}
