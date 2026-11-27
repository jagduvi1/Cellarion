/**
 * What a wall rack draws around its slots: every box with its frame and the
 * planks or doors inside it, and along the wall's edges the column letters
 * and row numbers a box is named by ("B2"). The geometry comes from
 * utils/wallLayout.js (layout.wall); this only paints it, so the racks page,
 * the zone editor and the printed map show the same wall.
 *
 * Rendered inside the caller's <svg>, before the slots. The defaults are the
 * racks page's wood (RackRenderer); a caller with another palette, such as
 * the printed map, passes its own colours.
 */
const WOOD_BG = '#DCC8A4';
const WOOD_FRAME = '#C8AD82';
const WOOD_SHADE = 'rgba(60, 40, 10, 0.07)';
const DOOR_FILL = '#D4BA94';
const DOOR_LINE = '#B89B6E';
const KNOB = '#8E7448';
const LABEL = '#6E5A38';

export default function WallDecor({
  wall,
  fill = WOOD_BG,
  frame = WOOD_FRAME,
  shade = WOOD_SHADE,
  doorFill = DOOR_FILL,
  doorLine = DOOR_LINE,
  knob = KNOB,
  labelColor = LABEL,
  frameWidth = 9,
  plankWidth = 8,
  showLabels = true,
}) {
  if (!wall) return null;
  return (
    <g className="wall-decor" aria-hidden="true">
      {wall.boxes.map((box) => (
        <g key={box.key} data-wall-box={box.label}>
          <rect x={box.x} y={box.y} width={box.width} height={box.height} fill={fill} stroke={frame} strokeWidth={frameWidth} />
          {box.kind !== 'closed' && shade && (
            <rect
              x={box.x + box.inset} y={box.y + box.inset}
              width={box.width - 2 * box.inset} height={box.height - 2 * box.inset}
              fill={shade}
            />
          )}
          {box.planks.map((p, i) => (
            <line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={frame} strokeWidth={plankWidth} strokeLinecap="round" />
          ))}
          {box.doors.map((d, i) => (
            <g key={i}>
              <rect x={d.x} y={d.y} width={d.width} height={d.height} rx={3} fill={doorFill} stroke={doorLine} strokeWidth={2.5} />
              {d.width > 60 && d.height > 70 && (
                <rect
                  x={d.x + 22} y={d.y + 22} width={d.width - 44} height={d.height - 44} rx={2}
                  fill="none" stroke={doorLine} strokeWidth={2} opacity={0.7}
                />
              )}
              <circle cx={d.knobX} cy={d.knobY} r={5} fill={knob} />
            </g>
          ))}
        </g>
      ))}
      {/* The column letters and row numbers a box is named by ("B2"). */}
      {showLabels && wall.axes.map((a) => (
        <text
          key={a.key} className="wall-axis" x={a.x} y={a.y}
          textAnchor="middle" dominantBaseline="central" fontSize={20} fontWeight={600} fill={labelColor}
        >
          {a.label}
        </text>
      ))}
    </g>
  );
}
