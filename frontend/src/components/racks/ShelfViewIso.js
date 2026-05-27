import { useMemo } from 'react';
import './ShelfView.css';

const WINE_COLORS = {
  red:       { fill: '#8A1028', stroke: '#6A0820', text: '#fff' },
  white:     { fill: '#E8D87A', stroke: '#A09838', text: '#3a3000' },
  'rosé':    { fill: '#D06888', stroke: '#A04868', text: '#fff' },
  sparkling: { fill: '#B8C868', stroke: '#688830', text: '#2a3300' },
  dessert:   { fill: '#A06020', stroke: '#805018', text: '#fff' },
  fortified: { fill: '#7A3010', stroke: '#5A2008', text: '#fff' },
};

// Each bottle is a body ellipse + a neck circle. Front-row bottles sit in the
// LOWER half of the shelf (closer to viewer) with necks pointing UP toward the
// shelf centerline. Back-row bottles sit in the UPPER half with necks pointing
// DOWN toward the centerline. Necks of the two rows interlock between each
// other's bottles (back row offset by half a stride horizontally), matching
// how bottles actually lie in a real Vintec/Transtherm shelf.
const BODY_RX = 13;
const BODY_RY = 16;
const NECK_R  = 5;
const NECK_GAP = 1;
const STRIDE_X = BODY_RX * 2 + 3; // tight horizontal pack
const SHELF_PAD_TOP = 6;
const SHELF_PAD_BOTTOM = 4;
const SHELF_PLATFORM_H = 5;
const SHELF_LABEL_W = 60;
const NECK_OVERLAP = 4; // body and neck overlap a touch so they read as one shape

// One whole bottle (body+neck) is BODY_RY + (NECK_R*2 - NECK_OVERLAP) ≈ 22 px tall.
// A shelf row has two of them stacked head-to-head with NECK_GAP between necks.
const HALF_HEIGHT = BODY_RY + (NECK_R * 2 - NECK_OVERLAP);
const SHELF_INNER_H = HALF_HEIGHT * 2 + NECK_GAP;
const SHELF_ROW_HEIGHT = SHELF_PAD_TOP + SHELF_INNER_H + SHELF_PAD_BOTTOM + SHELF_PLATFORM_H;

/**
 * 2.5-dimensional shelf view — both front and back rows of a real Vintec /
 * Transtherm shelf shown in one image, with bottle necks interlocking at the
 * shelf centerline (just like the bottles physically lie). Looking straight
 * down at the shelf:
 *
 *     [body][body][body][body][body][body]    ← back row (necks pointing down)
 *       ((  ((  ((  ((  ((                    ← back necks
 *        ))  ))  ))  ))  ))                   ← front necks
 *     [body][body][body][body][body][body]    ← front row (necks pointing up)
 *     ─────────────────────────────────────   ← shelf platform
 */
export default function ShelfViewIso({ rack, activePosition, highlightPos, onSlotClick }) {
  if (rack?.type !== 'shelf') {
    return (
      <div className="shelf-view-empty">
        Isometric view is only available for Open Shelf racks.
      </div>
    );
  }

  const cols = rack.cols || 0;
  const backCols = rack.typeConfig?.backCols || 0;
  const bpc = rack.typeConfig?.bottlesPerCell || 1;
  const rows = rack.rows || 0;
  const slotsPerShelf = (cols + backCols) * bpc;
  const frontCount = cols * bpc;
  const backCount = backCols * bpc;

  const slotMap = useMemo(() => {
    const m = {};
    for (const s of (rack.slots || [])) m[s.position] = s;
    return m;
  }, [rack.slots]);

  const shelfRowWidth = SHELF_LABEL_W + BODY_RX + frontCount * STRIDE_X + BODY_RX;
  const totalHeight = rows * SHELF_ROW_HEIGHT;

  // Render shelves with the highest number at the top — matches the way most
  // people picture a cabinet they're facing.
  const shelves = [];
  for (let displayIdx = 0; displayIdx < rows; displayIdx++) {
    const shelfNumber = rows - displayIdx;
    const shelfBase = (shelfNumber - 1) * slotsPerShelf;
    const shelfY = displayIdx * SHELF_ROW_HEIGHT;

    // Vertical anchors within the shelf:
    //   backBodyCY   ← back-row body center (upper)
    //   centerY      ← necks meet here
    //   frontBodyCY  ← front-row body center (lower)
    const innerTop = shelfY + SHELF_PAD_TOP;
    const backBodyCY  = innerTop + BODY_RY;
    const backNeckCY  = backBodyCY + BODY_RY - NECK_OVERLAP + NECK_R;
    const centerY     = innerTop + HALF_HEIGHT + NECK_GAP / 2;
    const frontNeckCY = centerY + NECK_GAP / 2 + NECK_R;
    const frontBodyCY = frontNeckCY + NECK_R + (BODY_RY - NECK_OVERLAP);

    // Front bottles fill the cols positions evenly across the row.
    const front = [];
    for (let c = 0; c < frontCount; c++) {
      const position = shelfBase + c + 1;
      const cx = SHELF_LABEL_W + BODY_RX + c * STRIDE_X;
      front.push({ position, cx, bodyCY: frontBodyCY, neckCY: frontNeckCY, slot: slotMap[position] || null });
    }

    // Back bottles nest between fronts — offset by half a stride.
    const back = [];
    for (let c = 0; c < backCount; c++) {
      const position = shelfBase + frontCount + c + 1;
      const cx = SHELF_LABEL_W + BODY_RX + (c + 0.5) * STRIDE_X;
      back.push({ position, cx, bodyCY: backBodyCY, neckCY: backNeckCY, slot: slotMap[position] || null });
    }

    shelves.push({ number: shelfNumber, shelfY, front, back });
  }

  return (
    <div className="shelf-view">
      <div className="shelf-view-toolbar">
        <div className="shelf-view-hint">
          Looking straight down — bottle necks interlock at the centerline of each shelf
        </div>
      </div>

      <svg
        className="shelf-view-svg"
        viewBox={`0 0 ${shelfRowWidth} ${totalHeight}`}
        width="100%"
      >
        {shelves.map(shelf => (
          <g key={shelf.number} transform={`translate(0, ${shelf.shelfY})`}>
            {/* Shelf row wood background */}
            <rect
              x={SHELF_LABEL_W - 4}
              y={2}
              width={shelfRowWidth - SHELF_LABEL_W}
              height={SHELF_ROW_HEIGHT - SHELF_PLATFORM_H - 4}
              rx={6}
              fill="#D4BA94"
              stroke="#B89A6E"
              strokeWidth={1}
              opacity={0.55}
            />
            <text
              x={SHELF_LABEL_W - 12}
              y={SHELF_ROW_HEIGHT / 2 - SHELF_PLATFORM_H / 2}
              textAnchor="end"
              dominantBaseline="central"
              className="shelf-view-shelf-label"
            >
              Shelf {shelf.number}
            </text>

            {/* Back row first so its necks pass under front necks at the centerline */}
            {shelf.back.map(b => (
              <Bottle
                key={b.position}
                cx={b.cx}
                bodyCY={b.bodyCY}
                neckCY={b.neckCY}
                slot={b.slot}
                position={b.position}
                isActive={activePosition === b.position}
                isHighlight={highlightPos === b.position}
                onClick={() => onSlotClick?.(b.position, b.slot || null)}
              />
            ))}

            {/* Front row */}
            {shelf.front.map(f => (
              <Bottle
                key={f.position}
                cx={f.cx}
                bodyCY={f.bodyCY}
                neckCY={f.neckCY}
                slot={f.slot}
                position={f.position}
                isActive={activePosition === f.position}
                isHighlight={highlightPos === f.position}
                onClick={() => onSlotClick?.(f.position, f.slot || null)}
              />
            ))}

            {/* Wooden platform at the bottom */}
            <rect
              x={SHELF_LABEL_W - 4}
              y={SHELF_ROW_HEIGHT - SHELF_PLATFORM_H - 1}
              width={shelfRowWidth - SHELF_LABEL_W}
              height={SHELF_PLATFORM_H}
              rx={2}
              fill="#8B6A40"
              stroke="#6A4F30"
              strokeWidth={0.8}
            />
          </g>
        ))}
      </svg>
    </div>
  );
}

/**
 * A single bottle rendered top-down: oval body + small circle for the neck.
 * Neck is on the side of the body closest to the shelf centerline.
 */
function Bottle({ cx, bodyCY, neckCY, slot, position, isActive, isHighlight, onClick }) {
  const bottle = slot?.bottle;
  const wine = bottle?.wineDefinition;
  const wineType = wine?.type || 'red';
  const colors = bottle ? (WINE_COLORS[wineType] || WINE_COLORS.red) : null;
  const filled = !!bottle;
  const stroke = filled ? colors.stroke : '#B09060';
  const fill = filled ? colors.fill : 'transparent';
  const lineW = isActive || isHighlight ? 2.5 : 1.4;

  return (
    <g
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick?.()}
      role="button"
      tabIndex={0}
      className={`shelf-view-bottle ${filled ? 'filled' : 'empty'} ${isActive ? 'active' : ''} ${isHighlight ? 'highlight' : ''}`}
      aria-label={filled ? `${wine?.name || 'Wine'} ${bottle?.vintage || ''}` : `Empty slot ${position}`}
    >
      {/* Drop shadow */}
      <ellipse cx={cx + 0.5} cy={bodyCY + 1.2} rx={BODY_RX} ry={BODY_RY} fill="rgba(0,0,0,0.16)" pointerEvents="none" />
      <circle cx={cx + 0.5} cy={neckCY + 1.2} r={NECK_R} fill="rgba(0,0,0,0.16)" pointerEvents="none" />

      {/* Body */}
      <ellipse
        cx={cx}
        cy={bodyCY}
        rx={BODY_RX}
        ry={BODY_RY}
        fill={fill}
        stroke={stroke}
        strokeWidth={lineW}
        strokeDasharray={filled ? null : '3 2'}
      />
      {/* Neck */}
      <circle
        cx={cx}
        cy={neckCY}
        r={NECK_R}
        fill={fill}
        stroke={stroke}
        strokeWidth={lineW}
        strokeDasharray={filled ? null : '3 2'}
      />
      {/* Subtle highlight on body */}
      {filled && (
        <ellipse
          cx={cx}
          cy={bodyCY - BODY_RY * 0.4}
          rx={BODY_RX * 0.4}
          ry={BODY_RX * 0.32}
          fill="rgba(255,255,255,0.18)"
          pointerEvents="none"
        />
      )}
      {/* Vintage label on body */}
      {filled && bottle?.vintage && bottle.vintage !== 'NV' && (
        <text
          x={cx}
          y={bodyCY + BODY_RY * 0.15}
          textAnchor="middle"
          dominantBaseline="central"
          className="shelf-view-vintage"
          fill={colors.text}
        >
          {bottle.vintage}
        </text>
      )}
      {/* Empty slot number */}
      {!filled && (
        <text
          x={cx}
          y={bodyCY}
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
