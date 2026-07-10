import { useState, useMemo, useRef } from 'react';
import useSlotDrag from '../../hooks/useSlotDrag';
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
 * Top-down "shelf view" of a shelf rack. Renders bottles as ovals from above,
 * one row per shelf, with a Front/Back toggle for racks that have a back row.
 *
 * Designed for Oeno-style cabinets but works for any rack with type === 'shelf'.
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
  const cols = rack?.cols || 0;
  const backCols = rack?.typeConfig?.backCols || 0;
  const bpc = rack?.typeConfig?.bottlesPerCell || 1;
  const rows = rack?.rows || 0;
  const slotsPerShelf = (cols + backCols) * bpc;
  const hasBack = backCols > 0;

  // Per-shelf positions for the active layer.
  // Display order: highest shelf-NUMBER label at the top of the SVG (matches
  // how a user faces the cabinet — top of view = top of cabinet).
  // Position MAPPING: positions count row-major from the top, matching the
  // Compact and 3D views (position 1 = top-left of the rack). So the top
  // shelf shows the LOW positions, not the high ones.
  const layerCols = layerMode === 'front' ? cols : backCols;
  const layerBpc = bpc;
  const shelfRowWidth = SHELF_LABEL_W + layerCols * layerBpc * (BOTTLE_RX * 2 + BOTTLE_GAP) + BOTTLE_GAP;
  const shelfRowHeight = BOTTLE_RY * 2 + SHELF_PAD_Y * 2;
  const totalHeight = rows * shelfRowHeight;

  // Absolute svg coords of every visible oval on the active layer — the
  // drag hit map (mirrors the geometry in the render loop below).
  const slotCenters = useMemo(() => {
    const centers = [];
    const count = (layerMode === 'front' ? cols : backCols) * bpc;
    const offset = layerMode === 'front' ? 0 : cols * bpc;
    for (let displayIdx = 0; displayIdx < rows; displayIdx++) {
      const shelfBase = displayIdx * slotsPerShelf;
      for (let c = 1; c <= count; c++) {
        centers.push({
          position: shelfBase + offset + c,
          cx: SHELF_LABEL_W + BOTTLE_GAP + BOTTLE_RX + (c - 1) * (BOTTLE_RX * 2 + BOTTLE_GAP),
          cy: displayIdx * shelfRowHeight + shelfRowHeight / 2,
          r: BOTTLE_RY,
        });
      }
    }
    return centers;
  }, [rows, cols, backCols, bpc, slotsPerShelf, layerMode, shelfRowHeight]);

  const { drag, startDrag, shouldSuppressClick } = useSlotDrag({
    svgRef,
    slotCenters,
    isValidTarget: (pos) => !disabledSet.has(pos),
    onMove: onSlotMove,
    enabled: !!onSlotMove && isShelf,
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

  if (!isShelf) {
    return (
      <div className="shelf-view-empty">
        Shelf view is only available for Open Shelf racks. Switch back to the compact view to see this rack.
      </div>
    );
  }

  const shelves = [];
  for (let displayIdx = 0; displayIdx < rows; displayIdx++) {
    const shelfNumber = rows - displayIdx;
    const shelfBase = displayIdx * slotsPerShelf;
    const slotsForLayer = [];
    const slotCount = layerMode === 'front' ? cols * bpc : backCols * bpc;
    const offset = layerMode === 'front' ? 0 : cols * bpc;
    for (let c = 1; c <= slotCount; c++) {
      const position = shelfBase + offset + c;
      slotsForLayer.push({ position, slot: slotMap[position] || null });
    }
    shelves.push({ number: shelfNumber, slots: slotsForLayer, y: displayIdx * shelfRowHeight });
  }

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
            Top-down view — bottle necks toward {layerMode === 'front' ? 'you' : 'the back of the rack'}
          </div>
        </div>
      )}

      {layerCols === 0 ? (
        <div className="shelf-view-empty">This shelf has no {layerMode} cells.</div>
      ) : (
        <svg
          ref={svgRef}
          className={`shelf-view-svg ${drag ? 'shelf-view-svg--dragging' : ''}`}
          viewBox={`0 0 ${shelfRowWidth} ${totalHeight}`}
          width="100%"
        >
          {shelves.map(shelf => (
            <g key={shelf.number} transform={`translate(0, ${shelf.y})`}>
              <rect
                x={SHELF_LABEL_W - 4}
                y={SHELF_PAD_Y / 2}
                width={shelfRowWidth - SHELF_LABEL_W}
                height={shelfRowHeight - SHELF_PAD_Y}
                rx={6}
                fill="#D4BA94"
                stroke="#B89A6E"
                strokeWidth={1}
                opacity={0.55}
              />
              <text
                x={SHELF_LABEL_W - 12}
                y={shelfRowHeight / 2}
                textAnchor="end"
                dominantBaseline="central"
                className="shelf-view-shelf-label"
              >
                Shelf {shelf.number}
              </text>
              {shelf.slots.map((s, i) => {
                const cx = SHELF_LABEL_W + BOTTLE_GAP + BOTTLE_RX + i * (BOTTLE_RX * 2 + BOTTLE_GAP);
                const cy = shelfRowHeight / 2;
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
      aria-label={filled ? `${wine?.name || 'Wine'} ${bottle?.vintage || ''}` : `Empty slot ${position}`}
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
