import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { computeLayout, SLOT_RADIUS } from '../../utils/rackLayouts';
import './RackTypeSelector.css';

const RACK_TYPES = [
  { key: 'grid',     preview: { rows: 3, cols: 4 } },
  { key: 'diamond',  preview: { rows: 3, cols: 1 } },
  { key: 'hex',      preview: { rows: 3, cols: 4 } },
  { key: 'triangle', preview: { rows: 1, cols: 4 } },
  { key: 'stack',    preview: { rows: 5, cols: 1 } },
  { key: 'cube',     preview: { rows: 2, cols: 2, typeConfig: { moduleRows: 2, moduleCols: 2 } } },
  { key: 'shelf',    preview: { rows: 3, cols: 2 } },
];

/** Dimension config: which inputs to show per type, with sensible defaults */
export const TYPE_DIMENSIONS = {
  grid:     { showRows: true,  showCols: true,  defaultRows: 4, defaultCols: 8 },
  diamond:  { showRows: true,  showCols: false, defaultRows: 3, defaultCols: 1, rowLabel: 'racks.radiusLabel', showBottlesPerCell: true },
  hex:      { showRows: true,  showCols: true,  defaultRows: 4, defaultCols: 5 },
  triangle: { showRows: false, showCols: true,  defaultRows: 1, defaultCols: 5, colLabel: 'racks.baseWidthLabel' },
  stack:    { showRows: true,  showCols: false, defaultRows: 8, defaultCols: 1, rowLabel: 'racks.heightLabel' },
  cube:     { showRows: true,  showCols: true,  defaultRows: 2, defaultCols: 3, showModule: true },
  shelf:    { showRows: true,  showCols: true,  defaultRows: 3, defaultCols: 2, showBottlesPerCell: true },
};

export default function RackTypeSelector({ value, onChange }) {
  const { t } = useTranslation();

  return (
    <div className="rack-type-selector">
      <label className="rack-type-label">{t('racks.typeLabel')}</label>
      <div className="rack-type-options">
        {RACK_TYPES.map(({ key, preview }) => (
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

  const r = SLOT_RADIUS * 0.5; // smaller for thumbnail
  const CELL_SIZE = SLOT_RADIUS * 2 + 8;
  const half = CELL_SIZE / 2;
  const PAD = SLOT_RADIUS; // matches rackLayouts PADDING

  // Deduplicate positions for multi-bottle cells (diamond/shelf)
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
      viewBox={`0 0 ${layout.viewBox.width} ${layout.viewBox.height}`}
      className="rack-type-preview-svg"
      aria-hidden="true"
    >
      <rect
        x={0} y={0}
        width={layout.viewBox.width}
        height={layout.viewBox.height}
        rx={4}
        fill="#C8AD82"
      />

      {/* Diamond: X-cross lattice beams + grid lines */}
      {type === 'diamond' && (() => {
        const n = Math.max(1, rows);
        const size = 2 * n - 1;
        const els = [];
        // Grid boundary lines (horizontal + vertical)
        for (let i = 0; i <= size; i++) {
          const offset = PAD + SLOT_RADIUS + i * CELL_SIZE - half;
          els.push(
            <line key={`dh-${i}`} x1={2} y1={offset} x2={layout.viewBox.width - 2} y2={offset}
              stroke="#9A7E58" strokeWidth={1.5} opacity={0.5} />
          );
          els.push(
            <line key={`dv-${i}`} x1={offset} y1={2} x2={offset} y2={layout.viewBox.height - 2}
              stroke="#9A7E58" strokeWidth={1.5} opacity={0.5} />
          );
        }
        // X-cross diagonals in each cell
        for (let gr = 0; gr < size; gr++) {
          for (let gc = 0; gc < size; gc++) {
            const cx = PAD + SLOT_RADIUS + gc * CELL_SIZE;
            const cy = PAD + SLOT_RADIUS + gr * CELL_SIZE;
            els.push(
              <line key={`xa-${gr}-${gc}`} x1={cx - half} y1={cy - half} x2={cx + half} y2={cy + half}
                stroke="#9A7E58" strokeWidth={1.8} opacity={0.6} />,
              <line key={`xb-${gr}-${gc}`} x1={cx + half} y1={cy - half} x2={cx - half} y2={cy + half}
                stroke="#9A7E58" strokeWidth={1.8} opacity={0.6} />
            );
          }
        }
        return <>{els}</>;
      })()}

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
