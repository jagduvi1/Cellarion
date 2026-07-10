import { useMemo } from 'react';
import { computeLayout, computeModularLayout, SLOT_RADIUS } from '../../utils/rackLayouts';

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

  const R = SLOT_RADIUS;

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
      {layout.slots.map(({ position, cx, cy, isBack }) => {
        const slot = slotMap[position];
        const r = isBack ? R * 0.7 : R;
        if (disabledSet.has(position)) {
          const d = r * 0.5;
          return (
            <g key={position}>
              <circle cx={cx} cy={cy} r={r} fill="#F0F0EC" stroke="#C8C8C0" strokeWidth={1} />
              <line x1={cx - d} y1={cy - d} x2={cx + d} y2={cy + d} stroke="#B0B0A8" strokeWidth={1.2} />
              <line x1={cx - d} y1={cy + d} x2={cx + d} y2={cy - d} stroke="#B0B0A8" strokeWidth={1.2} />
            </g>
          );
        }
        if (!slot) {
          return (
            <g key={position}>
              <circle cx={cx} cy={cy} r={r} fill="none" stroke="#BBB" strokeWidth={1} strokeDasharray="3 2" />
              <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={r * 0.62} fill="#AAA">
                {position}
              </text>
            </g>
          );
        }
        const type = slot.bottle?.wineDefinition?.type || 'red';
        const fill = TYPE_FILLS[type] || TYPE_FILLS.red;
        const textFill = DARK_TEXT_TYPES.has(type) ? '#332B00' : '#fff';
        return (
          <g key={position}>
            <circle cx={cx} cy={cy} r={r} fill={fill} stroke="#00000030" strokeWidth={1} />
            <text
              x={cx} y={cy}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={r * 0.66}
              fontWeight="600"
              fill={textFill}
            >
              {position}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
