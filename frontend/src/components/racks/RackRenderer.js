import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { computeLayout, computeModularLayout, SLOT_RADIUS, CELL_SIZE } from '../../utils/rackLayouts';
import './RackRenderer.css';

const WINE_COLORS = {
  red:       { fill: '#8A1028', stroke: '#6A0820' },
  white:     { fill: '#C8B850', stroke: '#A09838' },
  rosé:      { fill: '#D06888', stroke: '#A04868' },
  sparkling: { fill: '#88A848', stroke: '#688830' },
  dessert:   { fill: '#A06020', stroke: '#805018' },
  fortified: { fill: '#7A3010', stroke: '#5A2008' },
};

const EMPTY_FILL   = '#C4A478';
const EMPTY_STROKE  = '#B09060';
const ACTIVE_STROKE = '#7A1E2D';
const WOOD_BG       = '#DCC8A4';
const WOOD_FRAME    = '#C8AD82';
const SHELF_COLOR   = '#D4BA94';
// Disabled (unusable) slots — muted, greyed-out wood tones
const DISABLED_FILL   = '#BFB09A';
const DISABLED_STROKE = '#A89880';
const DISABLED_CROSS  = 'rgba(90, 74, 56, 0.45)';

/** Sub-circle offsets for multi-bottle cells (dx, dy from cell centre) */
function getSubOffsets(bpc, R) {
  const g = R * 0.42;
  switch (bpc) {
    case 2: return [{ dx: -g, dy: 0 }, { dx: g, dy: 0 }];
    case 3: {
      // Equilateral triangle, slightly tighter so the cluster reads as one unit
      const t = R * 0.38;
      return [
        { dx: 0,             dy: -t * 0.85 },
        { dx: -t * 0.85,     dy:  t * 0.55 },
        { dx:  t * 0.85,     dy:  t * 0.55 },
      ];
    }
    case 4: return [{ dx: -g, dy: -g }, { dx: g, dy: -g }, { dx: -g, dy: g }, { dx: g, dy: g }];
    default: {
      // General grid arrangement
      const cols = Math.ceil(Math.sqrt(bpc));
      const rows = Math.ceil(bpc / cols);
      const offsets = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (offsets.length >= bpc) break;
          offsets.push({
            dx: -g + (2 * g * c) / Math.max(cols - 1, 1),
            dy: -g + (2 * g * r) / Math.max(rows - 1, 1),
          });
        }
      }
      return offsets;
    }
  }
}

/** Sub-circle radius for multi-bottle cells */
function getSubRadius(bpc, R) {
  if (bpc <= 2) return R * 0.45;
  if (bpc <= 4) return R * 0.40;
  return R * 0.3;
}

/** Wood-tone cell tray colour — slightly darker than the rack background */
const CELL_TRAY_FILL = '#C8AD82';
const CELL_TRAY_STROKE = '#A89070';

export default function RackRenderer({
  rack,
  canEdit,
  activeRackId,
  activePosition,
  highlightPos,
  onSlotClick,
  onDelete,
  onNfcLink,
}) {
  const { t } = useTranslation();
  const isModular = rack.isModular && rack.modules?.length > 0;
  const layout = useMemo(
    () => isModular
      ? computeModularLayout(rack.modules)
      : computeLayout(rack.type || 'grid', rack.rows, rack.cols, rack.typeConfig),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isModular, rack.modules, rack.type, rack.rows, rack.cols, rack.typeConfig]
  );

  const slotMap = useMemo(() => {
    const m = {};
    (rack.slots || []).forEach(s => { m[s.position] = s; });
    return m;
  }, [rack.slots]);

  const disabledSet = useMemo(
    () => new Set(rack.disabledPositions || []),
    [rack.disabledPositions]
  );

  const activePos = activeRackId === rack._id ? activePosition : null;
  const R = SLOT_RADIUS;

  return (
    <div className="rack-container card">
      <div className="rack-header">
        <div>
          <h2>{rack.name}</h2>
          <span className="rack-dims">
            {isModular ? (
              <span className="rack-type-badge">{t('racks.modular')}</span>
            ) : rack.type && rack.type !== 'grid' ? (
              <span className="rack-type-badge">{t(`racks.type_${rack.type}`)}</span>
            ) : null}
            {(rack.slots || []).length}/{layout.totalSlots - disabledSet.size} {t('racks.filled')}
          </span>
        </div>
        <div className="rack-header-actions">
          {canEdit && onNfcLink && (
            <button
              className={`rack-icon-btn ${rack.rfidTag ? 'rack-icon-btn--active' : ''}`}
              onClick={onNfcLink}
              title={rack.rfidTag ? t('racks.nfcLinked') : t('racks.nfcLink')}
              aria-label={rack.rfidTag ? t('racks.nfcLinked') : t('racks.nfcLink')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 8.32a7.43 7.43 0 0 1 0 7.36" /><path d="M9.46 6.21a11.76 11.76 0 0 1 0 11.58" /><path d="M12.91 4.1a15.91 15.91 0 0 1 .01 15.8" /><path d="M16.37 2a20.16 20.16 0 0 1 0 20" />
              </svg>
            </button>
          )}
          {canEdit && (
            <button
              className="rack-icon-btn rack-icon-btn--danger"
              onClick={onDelete}
              title={t('racks.deleteRack')}
              aria-label={t('racks.deleteRack')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="rack-svg-wrapper">
        <svg
          viewBox={`0 0 ${layout.viewBox.width} ${layout.viewBox.height}`}
          className="rack-svg"
          role="group"
          aria-label={`${rack.name} rack`}
        >
          <defs>
            {/* Subtle wood grain pattern */}
            <pattern id="wood-grain" patternUnits="userSpaceOnUse" width="200" height="6">
              <rect width="200" height="6" fill={WOOD_BG} />
              <line x1="0" y1="3" x2="200" y2="3.5" stroke="rgba(160,130,80,0.15)" strokeWidth="0.8" />
            </pattern>
          </defs>

          {/* Wood background with grain */}
          <rect
            x={0} y={0}
            width={layout.viewBox.width}
            height={layout.viewBox.height}
            rx={8}
            fill="url(#wood-grain)"
          />

          {/* Frame border */}
          <rect
            x={1} y={1}
            width={layout.viewBox.width - 2}
            height={layout.viewBox.height - 2}
            rx={7}
            fill="none"
            stroke={WOOD_FRAME}
            strokeWidth={3}
          />

          {/* Shelf lines (horizontal) between rows. X-racks have no shelves —
              their many distinct slot heights would draw spurious planks
              straight through the diagonal dividers below. */}
          {!layout.isXRack && <ShelfLines layout={layout} />}

          {/* Module separators for cube type */}
          {!isModular && rack.type === 'cube' && <CubeModuleLines rack={rack} layout={layout} />}

          {/* X-Rack: two diagonal dividers forming an X */}
          {!isModular && rack.type === 'x-rack' && (
            <>
              <line x1={6} y1={6} x2={layout.viewBox.width - 6} y2={layout.viewBox.height - 6}
                stroke={WOOD_FRAME} strokeWidth={3} opacity={0.6} />
              <line x1={layout.viewBox.width - 6} y1={6} x2={6} y2={layout.viewBox.height - 6}
                stroke={WOOD_FRAME} strokeWidth={3} opacity={0.6} />
            </>
          )}

          {/* Module boundaries for modular racks */}
          {isModular && layout.moduleLayouts?.map(ml => (
            <rect
              key={`mod-${ml.moduleIndex}`}
              x={ml.x + 4}
              y={ml.y + 4}
              width={ml.width - 8}
              height={ml.height - 8}
              rx={6}
              fill="none"
              stroke={WOOD_FRAME}
              strokeWidth={1.5}
              strokeDasharray="6 4"
              opacity={0.6}
            />
          ))}

          {/* Slots */}
          {(() => {
            const bpc = layout.bottlesPerCell || 1;
            const backR = layout.backRadius;

            if (bpc === 1) {
              return layout.slots.map(({ position, cx, cy, isBack }) => (
                <SlotCircle
                  key={position}
                  position={position}
                  cx={cx} cy={cy} R={isBack && backR ? backR : R}
                  slot={slotMap[position]}
                  disabled={disabledSet.has(position)}
                  isActive={activePos === position}
                  isHighlight={highlightPos === position}
                  onSlotClick={onSlotClick}
                />
              ));
            }

            // Multi-bottle cells: group positions sharing the same (cx,cy),
            // then render a wood-tone "tray" behind each cell so the cluster
            // of sub-circles visually reads as a single cell, then each
            // bottle as an individual smaller circle in a sub-grid.
            const cellMap = {};
            layout.slots.forEach(s => {
              const key = `${s.cx},${s.cy}`;
              if (!cellMap[key]) cellMap[key] = { cx: s.cx, cy: s.cy, isBack: !!s.isBack, positions: [] };
              cellMap[key].positions.push(s.position);
            });

            const subOffsets = getSubOffsets(bpc, R);
            const subR = getSubRadius(bpc, R);
            const backSubOffsets = backR ? getSubOffsets(bpc, backR) : subOffsets;
            const backSubR = backR ? getSubRadius(bpc, backR) : subR;

            const trayPad = 3;
            const traySize = CELL_SIZE - trayPad * 2;
            const backTraySize = backR ? backR * 2 + 4 : traySize;

            return Object.values(cellMap).map(cell => {
              const useOff = cell.isBack ? backSubOffsets : subOffsets;
              const useR = cell.isBack ? backSubR : subR;
              const sz = cell.isBack ? backTraySize : traySize;
              return (
                <g key={`cell-${cell.cx},${cell.cy}`}>
                  <rect
                    x={cell.cx - sz / 2}
                    y={cell.cy - sz / 2}
                    width={sz}
                    height={sz}
                    rx={5}
                    fill={CELL_TRAY_FILL}
                    stroke={CELL_TRAY_STROKE}
                    strokeWidth={0.75}
                    opacity={0.7}
                    pointerEvents="none"
                  />
                  {cell.positions.map((pos, idx) => {
                    const off = useOff[idx] || { dx: 0, dy: 0 };
                    return (
                      <SlotCircle
                        key={pos}
                        position={pos}
                        cx={cell.cx + off.dx}
                        cy={cell.cy + off.dy}
                        R={useR}
                        slot={slotMap[pos]}
                        disabled={disabledSet.has(pos)}
                        isActive={activePos === pos}
                        isHighlight={highlightPos === pos}
                        onSlotClick={onSlotClick}
                      />
                    );
                  })}
                </g>
              );
            });
          })()}
        </svg>
      </div>
    </div>
  );
}

/** Single slot circle (bpc=1 standard rendering) */
function SlotCircle({ position, cx, cy, R, slot, disabled, isActive, isHighlight, onSlotClick }) {
  const wine = slot?.bottle?.wineDefinition;
  const wineType = wine?.type || 'red';
  const colors = slot ? (WINE_COLORS[wineType] || WINE_COLORS.red) : null;

  // Disabled (unusable) position: greyed circle with a subtle diagonal cross.
  // Still clickable so editors can re-enable it from the slot popup.
  if (disabled) {
    const d = R * 0.5;
    return (
      <g
        className="rack-slot-g disabled"
        onClick={() => onSlotClick(position, null)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSlotClick(position, null)}
        role="button"
        tabIndex={0}
        aria-label={`Disabled slot ${position}`}
        style={{ cursor: 'default' }}
      >
        <circle
          cx={cx} cy={cy} r={R}
          fill={DISABLED_FILL}
          stroke={DISABLED_STROKE}
          strokeWidth={1.5}
          opacity={0.65}
        />
        <line x1={cx - d} y1={cy - d} x2={cx + d} y2={cy + d}
          stroke={DISABLED_CROSS} strokeWidth={1.5} strokeLinecap="round" pointerEvents="none" />
        <line x1={cx - d} y1={cy + d} x2={cx + d} y2={cy - d}
          stroke={DISABLED_CROSS} strokeWidth={1.5} strokeLinecap="round" pointerEvents="none" />
      </g>
    );
  }

  return (
    <g
      className={`rack-slot-g ${slot ? 'filled' : 'empty'} ${isActive ? 'active' : ''} ${isHighlight ? 'highlighted' : ''}`}
      onClick={() => onSlotClick(position, slot || null)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSlotClick(position, slot || null)}
      role="button"
      tabIndex={0}
      aria-label={slot ? `${wine?.name || '?'} (${slot.bottle?.vintage || ''})` : `Empty slot ${position}`}
      style={{ cursor: 'pointer' }}
    >
      <circle cx={cx + 1} cy={cy + 1} r={R} fill="rgba(0,0,0,0.08)" pointerEvents="none" />
      <circle
        cx={cx} cy={cy} r={R}
        fill={slot ? colors.fill : EMPTY_FILL}
        stroke={isActive || isHighlight ? ACTIVE_STROKE : (slot ? colors.stroke : EMPTY_STROKE)}
        strokeWidth={isActive || isHighlight ? 3 : 1.5}
      />
      <circle cx={cx} cy={cy} r={R * 0.82} fill="none"
        stroke={slot ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.08)'} strokeWidth={0.8} pointerEvents="none" />
      {slot && <circle cx={cx} cy={cy} r={R * 0.3} fill="rgba(0,0,0,0.4)" pointerEvents="none" />}
      {slot && <circle cx={cx} cy={cy} r={R * 0.18} fill="rgba(255,255,255,0.15)" pointerEvents="none" />}
      {!slot && (
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" className="slot-number" pointerEvents="none">
          {position}
        </text>
      )}
      {isHighlight && (
        <circle cx={cx} cy={cy} r={R + 4} fill="none" stroke={ACTIVE_STROKE} strokeWidth={2} className="highlight-ring" />
      )}
    </g>
  );
}

/** Renders horizontal shelf lines between rows for the open-shelf look */
function ShelfLines({ layout }) {
  if (!layout.slots.length) return null;

  const R = SLOT_RADIUS;
  let lineYs;
  if (layout.shelfYs && layout.shelfYs.length) {
    lineYs = layout.shelfYs;
  } else {
    const yValues = [...new Set(layout.slots.map(s => Math.round(s.cy)))].sort((a, b) => a - b);
    if (yValues.length < 2) return null;
    lineYs = [];
    for (let i = 0; i < yValues.length - 1; i++) {
      lineYs.push((yValues[i] + yValues[i + 1]) / 2);
    }
  }

  const lines = [];
  lineYs.forEach((midY, i) => {
    lines.push(
      <rect
        key={`shelf-${i}`}
        x={4}
        y={midY - 2}
        width={layout.viewBox.width - 8}
        height={4}
        fill={SHELF_COLOR}
        rx={1}
      />
    );
    lines.push(
      <line
        key={`rail-${i}`}
        x1={6}
        y1={midY + 2}
        x2={layout.viewBox.width - 6}
        y2={midY + 2}
        stroke="rgba(160,120,70,0.3)"
        strokeWidth={1}
      />
    );
  });

  // Scallop bumps between front-row slots only (back row sits above, no
  // plank below it). Double-height top-layer slots (isTop) rest on the base
  // bottles below them, not on a plank — no bumps under those either.
  const rowSlots = {};
  layout.slots.forEach(s => {
    if (s.isBack || s.isTop) return;
    const ry = Math.round(s.cy);
    if (!rowSlots[ry]) rowSlots[ry] = [];
    rowSlots[ry].push(s);
  });
  Object.values(rowSlots).forEach(slots => {
    slots.sort((a, b) => a.cx - b.cx);
    for (let i = 0; i < slots.length - 1; i++) {
      const midX = (slots[i].cx + slots[i + 1].cx) / 2;
      const cy = slots[i].cy;
      lines.push(
        <circle
          key={`bump-${slots[i].position}`}
          cx={midX}
          cy={cy + R + 3}
          r={2.5}
          fill={SHELF_COLOR}
          stroke="rgba(160,120,70,0.2)"
          strokeWidth={0.5}
        />
      );
    }
  });

  return <>{lines}</>;
}

/** Renders thin separator lines between cube modules */
function CubeModuleLines({ rack, layout }) {
  if (rack.type !== 'cube') return null;
  const mr = rack.typeConfig?.moduleRows || 2;
  const mc = rack.typeConfig?.moduleCols || 2;
  const lines = [];

  // Find the gap positions by looking at coordinate jumps
  // between adjacent modules. Use the first slot of each module row/col.
  const CELL = SLOT_RADIUS * 2 + 8;  // matches rackLayouts.js
  const moduleGap = CELL * 0.6;

  // Vertical separators (between module columns)
  for (let c = 1; c < rack.cols; c++) {
    const x = 20 + c * mc * CELL + (c - 1) * moduleGap + moduleGap / 2;
    lines.push(
      <line key={`v${c}`} x1={x} y1={8} x2={x} y2={layout.viewBox.height - 8}
        stroke={WOOD_FRAME} strokeWidth={2} strokeDasharray="4 4" />
    );
  }

  // Horizontal separators (between module rows)
  for (let r = 1; r < rack.rows; r++) {
    const y = 20 + r * mr * CELL + (r - 1) * moduleGap + moduleGap / 2;
    lines.push(
      <line key={`h${r}`} x1={8} y1={y} x2={layout.viewBox.width - 8} y2={y}
        stroke={WOOD_FRAME} strokeWidth={2} strokeDasharray="4 4" />
    );
  }

  return <>{lines}</>;
}
