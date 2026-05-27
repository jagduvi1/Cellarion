import { useState, useMemo } from 'react';
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
export default function ShelfView({ rack, activePosition, highlightPos, onSlotClick }) {
  const [layerMode, setLayerMode] = useState('front');

  if (rack?.type !== 'shelf') {
    return (
      <div className="shelf-view-empty">
        Shelf view is only available for Open Shelf racks. Switch back to the compact view to see this rack.
      </div>
    );
  }

  const cols = rack.cols || 0;
  const backCols = rack.typeConfig?.backCols || 0;
  const bpc = rack.typeConfig?.bottlesPerCell || 1;
  const rows = rack.rows || 0;
  const slotsPerShelf = (cols + backCols) * bpc;
  const hasBack = backCols > 0;
  const slotMap = useMemo(() => {
    const m = {};
    for (const s of (rack.slots || [])) m[s.position] = s;
    return m;
  }, [rack.slots]);

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
          className="shelf-view-svg"
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
                    isActive={activePosition === s.position}
                    isHighlight={highlightPos === s.position}
                    onClick={() => onSlotClick && onSlotClick(s.position, s.slot || null)}
                  />
                );
              })}
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}

function BottleOval({ cx, cy, slot, position, isActive, isHighlight, onClick }) {
  const bottle = slot?.bottle;
  const wine = bottle?.wineDefinition;
  const wineType = wine?.type || 'red';
  const colors = bottle ? (WINE_COLORS[wineType] || WINE_COLORS.red) : null;
  const filled = !!bottle;

  return (
    <g
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick?.()}
      role="button"
      tabIndex={0}
      className={`shelf-view-bottle ${filled ? 'filled' : 'empty'} ${isActive ? 'active' : ''} ${isHighlight ? 'highlight' : ''}`}
      aria-label={filled ? `${wine?.name || 'Wine'} ${bottle?.vintage || ''}` : `Empty slot ${position}`}
    >
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
        fill={filled ? colors.fill : 'transparent'}
        stroke={filled ? colors.stroke : '#B09060'}
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
          fill={colors.text}
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
    </g>
  );
}
