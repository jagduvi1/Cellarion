import { useState, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import useSlotDrag from '../../hooks/useSlotDrag';
import { isReserved } from '../../utils/reservation';
import { ReservedRibbon } from './RackRenderer';
import { cabinetShelfRows } from '../../utils/rackLayouts';
import './ShelfView.css';

const WINE_COLORS = {
  red:       { fill: '#8A1028', stroke: '#6A0820', text: '#fff' },
  white:     { fill: '#E8D87A', stroke: '#A09838', text: '#3a3000' },
  'rosé':    { fill: '#D06888', stroke: '#A04868', text: '#fff' },
  sparkling: { fill: '#B8C868', stroke: '#688830', text: '#2a3300' },
  dessert:   { fill: '#A06020', stroke: '#805018', text: '#fff' },
  fortified: { fill: '#7A3010', stroke: '#5A2008', text: '#fff' },
};

const BOTTLE_RX = 16; // horizontal radius (oval — top-down silhouette)
const BOTTLE_RY = 22; // vertical radius (longer axis = bottle length)
const BOTTLE_GAP = 8;  // gap between bottles in a row
const SHELF_PAD_Y = 12;
const SHELF_LABEL_W = 64;

/**
 * "Shelf view" of a shelf rack or a wine cabinet. Shelf racks: bottles as
 * ovals from above, one row per shelf, with a Front/Back toggle for racks
 * that have a back row. Cabinets: each shelf is a bay of stacked rows (row 1
 * on the plank, higher levels above it); the Front/Back toggle picks the
 * front or back row of every level when the cabinet is two deep.
 *
 * Falls back to a friendly message for other rack types.
 */
export default function ShelfView({ rack, activePosition, highlightPos, onSlotClick, getSlotStyle, onSlotMove }) {
  const [layerMode, setLayerMode] = useState('front');
  const svgRef = useRef(null);
  // All hooks must run before the non-shelf early return below, or a rack
  // type change on a mounted instance breaks the Rules of Hooks.
  const slotMap = useMemo(() => {
    const m = {};
    for (const s of (rack?.slots || [])) m[s.position] = s;
    return m;
  }, [rack?.slots]);

  const disabledSet = useMemo(
    () => new Set(rack?.disabledPositions || []),
    [rack?.disabledPositions]
  );

  const isShelf = rack?.type === 'shelf';
  const isCabinet = rack?.type === 'cabinet';
  const cols = rack?.cols || 0;
  const backCols = rack?.typeConfig?.backCols || 0;
  const bpc = rack?.typeConfig?.bottlesPerCell || 1;
  const rows = rack?.rows || 0;
  const twoDeep = rack?.typeConfig?.twoDeep !== false;
  const stagger = rack?.typeConfig?.stagger !== false;
  const hasBack = isCabinet ? twoDeep : backCols > 0;
  // Ovals per row on the active layer (drives the "no cells" message + width).
  const layerCols = isCabinet ? cols : (layerMode === 'front' ? cols : backCols);
  const rowPitch = BOTTLE_RY * 2 + BOTTLE_GAP;

  // Per-shelf geometry for the active layer — every slot with its own centre.
  // Display order: highest shelf-NUMBER label at the top of the SVG (matches
  // how a user faces the cabinet: top of view = top of cabinet).
  // Position MAPPING: positions count from the top, matching the Compact and
  // 3D views (position 1 = top-left of the rack), so the top shelf shows the
  // LOW positions. Cabinet bays follow rackLayouts.cabinetLayout's contract:
  // position = cols × Σ shelfRows[k<i] + (row − 1) × cols + slot, row 1 on
  // the plank; two-deep pairs odd (front) and even (back) rows per level.
  const geometry = useMemo(() => {
    const slotX = (c) => SHELF_LABEL_W + BOTTLE_GAP + BOTTLE_RX + c * (BOTTLE_RX * 2 + BOTTLE_GAP);
    const shelves = [];
    let y = 0;
    let perRow = 1;
    if (isCabinet) {
      const shelfRows = cabinetShelfRows(rows, rack?.typeConfig);
      perRow = Math.max(1, cols);
      let base = 0;
      shelfRows.forEach((rowCount, i) => {
        const levels = twoDeep ? Math.ceil(rowCount / 2) : rowCount;
        const height = SHELF_PAD_Y * 2 + levels * rowPitch - BOTTLE_GAP;
        const slots = [];
        for (let r = 1; r <= rowCount; r++) {
          const isBackRow = twoDeep && r % 2 === 0;
          if (twoDeep && (layerMode === 'back') !== isBackRow) continue;
          const level = twoDeep ? Math.ceil(r / 2) : r;
          const cy = height - SHELF_PAD_Y - BOTTLE_RY - (level - 1) * rowPitch;
          // Nested levels alternate half a bottle left and right.
          const nudge = stagger && level % 2 === 0 ? BOTTLE_RX : 0;
          for (let c = 0; c < cols; c++) {
            slots.push({ position: base + (r - 1) * cols + c + 1, cx: slotX(c) + nudge, cy });
          }
        }
        shelves.push({ number: shelfRows.length - i, y, height, slots });
        y += height;
        base += rowCount * cols;
      });
    } else {
      const slotsPerShelf = (cols + backCols) * bpc;
      const count = (layerMode === 'front' ? cols : backCols) * bpc;
      const offset = layerMode === 'front' ? 0 : cols * bpc;
      const height = BOTTLE_RY * 2 + SHELF_PAD_Y * 2;
      perRow = Math.max(1, count);
      for (let displayIdx = 0; displayIdx < rows; displayIdx++) {
        const shelfBase = displayIdx * slotsPerShelf;
        const slots = [];
        for (let c = 1; c <= count; c++) {
          slots.push({ position: shelfBase + offset + c, cx: slotX(c - 1), cy: height / 2 });
        }
        shelves.push({ number: rows - displayIdx, y, height, slots });
        y += height;
      }
    }
    const width = SHELF_LABEL_W + BOTTLE_GAP + perRow * (BOTTLE_RX * 2 + BOTTLE_GAP)
      + (isCabinet && stagger ? BOTTLE_RX : 0);
    return { shelves, width, height: y };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCabinet, rows, cols, backCols, bpc, twoDeep, stagger, layerMode, rack?.typeConfig?.shelfRows, rowPitch]);

  // Absolute svg coords of every visible oval on the active layer — the
  // drag hit map (mirrors the geometry in the render loop below).
  const slotCenters = useMemo(() => {
    const centers = [];
    for (const sh of geometry.shelves) {
      for (const sl of sh.slots) centers.push({ position: sl.position, cx: sl.cx, cy: sh.y + sl.cy, r: BOTTLE_RY });
    }
    return centers;
  }, [geometry]);

  const { drag, startDrag, shouldSuppressClick } = useSlotDrag({
    svgRef,
    slotCenters,
    isValidTarget: (pos) => !disabledSet.has(pos),
    onMove: onSlotMove,
    enabled: !!onSlotMove && (isShelf || isCabinet),
  });

  // A click that lands right after a drop must not open the slot popup.
  const handleSlotClick = (pos, slotData) => {
    if (shouldSuppressClick()) return;
    if (onSlotClick) onSlotClick(pos, slotData);
  };

  // position → zone color, for the soft halos behind the ovals
  const zoneColorByPos = useMemo(() => {
    const m = new Map();
    for (const z of rack?.zones || []) {
      for (const p of z.positions || []) m.set(p, z.color || '#888888');
    }
    return m;
  }, [rack?.zones]);

  if (!isShelf && !isCabinet) {
    return (
      <div className="shelf-view-empty">
        Shelf view is only available for Open Shelf and Wine cabinet racks. Switch back to the compact view to see this rack.
      </div>
    );
  }

  const shelves = geometry.shelves.map((sh) => ({
    ...sh,
    slots: sh.slots.map((sl) => ({ ...sl, slot: slotMap[sl.position] || null })),
  }));

  return (
    <div className="shelf-view">
      {hasBack && (
        <div className="shelf-view-toolbar">
          <div className="shelf-view-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={layerMode === 'front'}
              className={`shelf-view-tab ${layerMode === 'front' ? 'active' : ''}`}
              onClick={() => setLayerMode('front')}
            >
              Front view
            </button>
            <button
              role="tab"
              aria-selected={layerMode === 'back'}
              className={`shelf-view-tab ${layerMode === 'back' ? 'active' : ''}`}
              onClick={() => setLayerMode('back')}
            >
              Back view
            </button>
          </div>
          <div className="shelf-view-hint">
            {isCabinet
              ? (layerMode === 'front'
                ? 'Front of the cabinet — the front row of every level'
                : 'Front of the cabinet — the back row behind the front bottles')
              : `Top-down view — bottle necks toward ${layerMode === 'front' ? 'you' : 'the back of the rack'}`}
          </div>
        </div>
      )}

      {layerCols === 0 ? (
        <div className="shelf-view-empty">This shelf has no {layerMode} cells.</div>
      ) : (
        <svg
          ref={svgRef}
          className={`shelf-view-svg ${drag ? 'shelf-view-svg--dragging' : ''}`}
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          width="100%"
        >
          {shelves.map(shelf => (
            <g key={shelf.number} transform={`translate(0, ${shelf.y})`}>
              <rect
                x={SHELF_LABEL_W - 4}
                y={SHELF_PAD_Y / 2}
                width={geometry.width - SHELF_LABEL_W}
                height={shelf.height - SHELF_PAD_Y}
                rx={6}
                fill="#D4BA94"
                stroke="#B89A6E"
                strokeWidth={1}
                opacity={0.55}
              />
              <text
                x={SHELF_LABEL_W - 12}
                y={shelf.height / 2}
                textAnchor="end"
                dominantBaseline="central"
                className="shelf-view-shelf-label"
              >
                Shelf {shelf.number}
              </text>
              {shelf.slots.map((s) => {
                const { cx, cy } = s;
                return (
                  <BottleOval
                    key={s.position}
                    cx={cx}
                    cy={cy}
                    slot={s.slot}
                    position={s.position}
                    disabled={disabledSet.has(s.position)}
                    isActive={activePosition === s.position}
                    isHighlight={highlightPos === s.position}
                    onClick={() => handleSlotClick(s.position, s.slot || null)}
                    getSlotStyle={getSlotStyle}
                    onDragStart={onSlotMove ? startDrag : undefined}
                    isDragOrigin={drag?.from === s.position}
                    isDragTarget={drag?.over === s.position}
                    zoneColor={zoneColorByPos.get(s.position) || null}
                  />
                );
              })}
            </g>
          ))}

          {/* Drag ghost — a floating oval that follows the pointer */}
          {drag && (() => {
            const originSlot = slotMap[drag.from];
            const wineType = originSlot?.bottle?.wineDefinition?.type || 'red';
            const colors = WINE_COLORS[wineType] || WINE_COLORS.red;
            const custom = getSlotStyle && originSlot ? getSlotStyle(originSlot) : null;
            return (
              <g pointerEvents="none">
                <ellipse cx={drag.x + 0.5} cy={drag.y + 1.5} rx={BOTTLE_RX} ry={BOTTLE_RY} fill="rgba(0,0,0,0.12)" />
                <ellipse
                  cx={drag.x} cy={drag.y}
                  rx={BOTTLE_RX} ry={BOTTLE_RY}
                  fill={custom?.fill || colors.fill}
                  stroke={custom?.stroke || colors.stroke}
                  strokeWidth={1.5}
                  opacity={0.85}
                />
              </g>
            );
          })()}
        </svg>
      )}
    </div>
  );
}

function BottleOval({ cx, cy, slot, position, disabled, isActive, isHighlight, onClick, getSlotStyle, onDragStart, isDragOrigin, isDragTarget, zoneColor }) {
  const { t } = useTranslation();
  const bottle = slot?.bottle;
  const wine = bottle?.wineDefinition;
  const wineType = wine?.type || 'red';
  const colors = bottle ? (WINE_COLORS[wineType] || WINE_COLORS.red) : null;
  const filled = !!bottle;
  // Lens/search style: overrides fill/stroke/text for filled ovals, dims
  // non-matching slots while a search is active.
  const custom = getSlotStyle ? getSlotStyle(slot || null) : null;
  // Drag origin fades harder than a search dim so the "lifted" bottle reads
  // as coming from that slot.
  const dimStyle = isDragOrigin ? { opacity: 0.3 } : custom?.dim ? { opacity: 0.22 } : null;
  const draggable = !!(filled && onDragStart);

  // Disabled (unusable) position: greyed oval with a subtle diagonal cross.
  // Still clickable so editors can re-enable it from the slot popup.
  if (disabled) {
    const dx = BOTTLE_RX * 0.5;
    const dy = BOTTLE_RY * 0.5;
    return (
      <g
        onClick={onClick}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick?.()}
        role="button"
        tabIndex={0}
        className="shelf-view-bottle disabled"
        aria-label={`Disabled slot ${position}`}
        style={{ cursor: 'default', ...dimStyle }}
      >
        <ellipse
          cx={cx}
          cy={cy}
          rx={BOTTLE_RX}
          ry={BOTTLE_RY}
          fill="rgba(90, 74, 56, 0.12)"
          stroke="#A89880"
          strokeWidth={1.5}
        />
        <line x1={cx - dx} y1={cy - dy} x2={cx + dx} y2={cy + dy}
          stroke="rgba(90, 74, 56, 0.45)" strokeWidth={1.5} strokeLinecap="round" pointerEvents="none" />
        <line x1={cx - dx} y1={cy + dy} x2={cx + dx} y2={cy - dy}
          stroke="rgba(90, 74, 56, 0.45)" strokeWidth={1.5} strokeLinecap="round" pointerEvents="none" />
      </g>
    );
  }

  const fillColor = filled ? (custom?.fill || colors.fill) : 'transparent';
  const strokeColor = filled ? (custom?.stroke || colors.stroke) : '#B09060';
  const textColor = custom?.text || colors?.text;

  return (
    <g
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick?.()}
      onPointerDown={draggable ? (e) => onDragStart(e, position) : undefined}
      role="button"
      tabIndex={0}
      className={`shelf-view-bottle ${filled ? 'filled' : 'empty'} ${isActive ? 'active' : ''} ${isHighlight ? 'highlight' : ''}`}
      aria-label={filled
        ? `${wine?.name || 'Wine'} ${bottle?.vintage || ''}${isReserved(bottle) ? ` — ${t('rackView.reservedAria', 'reserved')}` : ''}`
        : `Empty slot ${position}`}
      style={{ ...(draggable ? { cursor: 'grab' } : null), ...dimStyle }}
    >
      {zoneColor && (
        <ellipse
          cx={cx}
          cy={cy}
          rx={BOTTLE_RX + 4}
          ry={BOTTLE_RY + 4}
          fill={zoneColor}
          opacity={0.3}
          pointerEvents="none"
        />
      )}
      <ellipse
        cx={cx + 0.5}
        cy={cy + 1}
        rx={BOTTLE_RX}
        ry={BOTTLE_RY}
        fill="rgba(0,0,0,0.10)"
        pointerEvents="none"
      />
      <ellipse
        cx={cx}
        cy={cy}
        rx={BOTTLE_RX}
        ry={BOTTLE_RY}
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth={isActive || isHighlight ? 2.5 : 1.5}
        strokeDasharray={filled ? null : '3 2'}
      />
      {filled && (
        <ellipse
          cx={cx}
          cy={cy - BOTTLE_RY * 0.45}
          rx={BOTTLE_RX * 0.42}
          ry={BOTTLE_RX * 0.35}
          fill="rgba(0,0,0,0.35)"
          pointerEvents="none"
        />
      )}
      {filled && isReserved(bottle) && <ReservedRibbon cx={cx} cy={cy} r={BOTTLE_RY * 0.9} />}
      {filled && bottle?.vintage && bottle.vintage !== 'NV' && (
        <text
          x={cx}
          y={cy + BOTTLE_RY * 0.15}
          textAnchor="middle"
          dominantBaseline="central"
          className="shelf-view-vintage"
          fill={textColor}
        >
          {bottle.vintage}
        </text>
      )}
      {!filled && (
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          className="shelf-view-empty-num"
        >
          {position}
        </text>
      )}
      {isDragTarget && (
        <ellipse
          cx={cx} cy={cy}
          rx={BOTTLE_RX + 3} ry={BOTTLE_RY + 3}
          fill="none"
          stroke="#7A1E2D"
          strokeWidth={2.5}
          strokeDasharray="5 3"
        />
      )}
    </g>
  );
}
