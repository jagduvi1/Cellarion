import { WOOD_THICK } from '../../utils/roomConstants';

/**
 * The woodwork of a wall rack in the 3D room: every box with its own frame,
 * the planks that divide it (an X, a diagonal, shelves) and the doors of a
 * closed box. The 2D drawing's twin is components/racks/WallDecor.js; both
 * read the same geometry (utils/wallLayout.js), here scaled to metres by
 * roomConstants.buildScaledLayout, centred on the rack with y up.
 *
 * A wall has no frame around the whole of it: a cell that no box covers is
 * open wall, in the room as on the racks page.
 */
export default function WallStructure({ wall, depth, woodTex, frameColor, plankColor }) {
  const z = -depth * 0.05;
  const panelDepth = depth * 0.85;
  const plankDepth = depth * 0.8;
  const T = WOOD_THICK;

  return (
    <>
      {wall.boxes.map((box) => {
        const left = box.cx - box.w / 2, right = box.cx + box.w / 2;
        const top = box.cy + box.h / 2, bottom = box.cy - box.h / 2;
        return (
          <group key={box.key}>
            {/* The box's four sides, each inside the box's own edge so that
                neighbouring boxes never share a face. */}
            <mesh position={[left + T / 2, box.cy, z]} castShadow>
              <boxGeometry args={[T, box.h, panelDepth]} />
              <meshStandardMaterial map={woodTex} color={frameColor} roughness={0.7} />
            </mesh>
            <mesh position={[right - T / 2, box.cy, z]} castShadow>
              <boxGeometry args={[T, box.h, panelDepth]} />
              <meshStandardMaterial map={woodTex} color={frameColor} roughness={0.7} />
            </mesh>
            <mesh position={[box.cx, top - T / 2, z]} castShadow>
              <boxGeometry args={[box.w - 2 * T, T, panelDepth]} />
              <meshStandardMaterial map={woodTex} color={frameColor} roughness={0.7} />
            </mesh>
            <mesh position={[box.cx, bottom + T / 2, z]} receiveShadow>
              <boxGeometry args={[box.w - 2 * T, T, panelDepth]} />
              <meshStandardMaterial map={woodTex} color={frameColor} roughness={0.7} />
            </mesh>

            {/* Planks: a diagonal runs corner to corner, a shelf side to side. */}
            {box.planks.map((p, i) => {
              const length = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
              return (
                <mesh
                  key={`plank-${i}`}
                  position={[(p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2, z]}
                  rotation={[0, 0, Math.atan2(p.y2 - p.y1, p.x2 - p.x1)]}
                >
                  <boxGeometry args={[length, T, plankDepth]} />
                  <meshStandardMaterial map={woodTex} color={plankColor} roughness={0.7} />
                </mesh>
              );
            })}

            {/* A closed box: its doors at the front, each with a knob. */}
            {box.doors.map((d, i) => (
              <group key={`door-${i}`}>
                <mesh position={[d.cx, d.cy, z + panelDepth / 2 - T / 2]} castShadow>
                  <boxGeometry args={[d.w, d.h, T]} />
                  <meshStandardMaterial map={woodTex} color={plankColor} roughness={0.65} />
                </mesh>
                <mesh position={[d.knobX, d.knobY, z + panelDepth / 2 + T * 0.4]}>
                  <sphereGeometry args={[T * 0.55, 12, 12]} />
                  <meshStandardMaterial color="#8E7448" roughness={0.5} metalness={0.2} />
                </mesh>
              </group>
            ))}
          </group>
        );
      })}
    </>
  );
}
