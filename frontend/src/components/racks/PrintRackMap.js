import { useMemo } from 'react';
import { computeLayout, computeModularLayout, SLOT_RADIUS, multiBottleCells, cellNumberSize } from '../../utils/rackLayouts';
import { swatchType } from '../../utils/wineColour';

// Print-tuned wine-type palette — same hues as the compact rack view, kept
// saturated so slots stay distinguishable in color print; the position
// number carries the information in grayscale.
const TYPE_FILLS = {
  red:       '#8A1028',
  white:     '#C8B850',
  'rosé':    '#D06888',
  sparkling: '#88A848',
  dessert:   '#A06020',
  fortified: '#7A3010',
};
const DARK_TEXT_TYPES = new Set(['white', 'sparkling']);

/**
 * Static, print-friendly rack map: white background, every slot numbered.
 * Filled slots are type-colored with the position number on the bottle;
 * empty slots are dashed outlines; disabled slots are crossed out.
 * Unlike the interactive RackRenderer, the number is the point here — it is
 * the lookup key into the printed bottle list next to the map.
 */
export default function PrintRackMap({ rack }) {
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

  // A shelf cell holding several bottles: the layout gives them all the
  // cell's centre, so they are fanned out the way the rack view draws them
  // (as given they printed on top of each other, numbers and all).
  const cells = useMemo(() => multiBottleCells(layout, { fit: true }), [layout]);
  const digits = String(layout.totalSlots).length;

  const R = SLOT_RADIUS;

  // One slot's drawing, split into its shape and its number so a cell's
  // numbers can go on top of all its bottles. `numberSize(ratio)` turns a
  // ratio of the bottle's radius into the number's font size.
  const slotParts = ({ position, cx, cy, r, isSideways, numberSize }) => {
    const slot = slotMap[position];
    // A bottle lying across prints as a bar in its cell (same numbering).
    const shape = (props) => (isSideways
      ? <rect x={cx - r} y={cy - r * 0.55} width={r * 2} height={r * 1.1} rx={r * 0.5} {...props} />
      : <circle cx={cx} cy={cy} r={r} {...props} />);
    if (disabledSet.has(position)) {
      const d = r * 0.5;
      return {
        shape: (
          <>
            {shape({ fill: '#F0F0EC', stroke: '#C8C8C0', strokeWidth: 1 })}
            <line x1={cx - d} y1={cy - d} x2={cx + d} y2={cy + d} stroke="#B0B0A8" strokeWidth={1.2} />
            <line x1={cx - d} y1={cy + d} x2={cx + d} y2={cy - d} stroke="#B0B0A8" strokeWidth={1.2} />
          </>
        ),
        number: null,
      };
    }
    if (!slot) {
      return {
        shape: shape({ fill: 'none', stroke: '#BBB', strokeWidth: 1, strokeDasharray: '3 2' }),
        number: (
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={numberSize(0.62)} fill="#AAA">
            {position}
          </text>
        ),
      };
    }
    const type = swatchType(slot.bottle?.wineDefinition, 'red');
    const fill = TYPE_FILLS[type] || TYPE_FILLS.red;
    const textFill = DARK_TEXT_TYPES.has(type) ? '#332B00' : '#fff';
    return {
      shape: shape({ fill, stroke: '#00000030', strokeWidth: 1 }),
      number: (
        <text
          x={cx} y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={numberSize(0.66)}
          fontWeight="600"
          fill={textFill}
        >
          {position}
        </text>
      ),
    };
  };

  return (
    <svg
      viewBox={`0 0 ${layout.viewBox.width} ${layout.viewBox.height}`}
      className="print-rack-map"
      role="img"
      aria-label={`${rack.name} map`}
    >
      <rect
        x={1} y={1}
        width={layout.viewBox.width - 2}
        height={layout.viewBox.height - 2}
        rx={7}
        fill="#fff"
        stroke="#999"
        strokeWidth={1.5}
      />
      {!cells && layout.slots.map(({ position, cx, cy, isBack, isSideways }) => {
        const r = isBack ? R * 0.7 : R;
        const { shape, number } = slotParts({ position, cx, cy, r, isSideways, numberSize: (ratio) => r * ratio });
        return <g key={position}>{shape}{number}</g>;
      })}
      {/* Each cell: its outline, every bottle, then every number on top —
          neighbouring bottles of a full cell overlap a little. */}
      {cells && cells.map(cell => {
        const parts = cell.bottles.map(b => ({
          position: b.position,
          ...slotParts({ ...b, r: cell.r, numberSize: (ratio) => cellNumberSize(cell, ratio, digits) }),
        }));
        return (
          <g key={`cell-${cell.cx},${cell.cy}`}>
            <rect
              x={cell.cx - cell.size / 2}
              y={cell.cy - cell.size / 2}
              width={cell.size}
              height={cell.size}
              rx={5}
              fill="none"
              stroke="#C8C8C0"
              strokeWidth={0.75}
            />
            {parts.map(p => <g key={p.position}>{p.shape}</g>)}
            {parts.map(p => p.number && <g key={`n-${p.position}`}>{p.number}</g>)}
          </g>
        );
      })}
    </svg>
  );
}
