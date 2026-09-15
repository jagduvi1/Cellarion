import { useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { PANEL_THICK, BOTTLE_RADIUS, WOOD_THICK } from '../../utils/roomConstants';

/**
 * 3D parts of a `cabinet` rack — the wine fridge. RackMesh owns the slot
 * positions, bottles, pull-out bays and interaction; these are the pieces
 * that make it read as an appliance instead of a wooden rack:
 *
 *   - CabinetBody   dark steel carcass with a lit grey interior, a control
 *                   strip with a temperature display, vertical LED strips
 *                   down both inner front edges and a plinth
 *   - CabinetDoor   full-height glass door on a left hinge with a stainless
 *                   handle; clicking the handle swings it open (~110°). The
 *                   glass never catches clicks, so bottles and shelf handles
 *                   stay reachable with the door closed.
 *
 * Colours are deliberately not wood: the wood lives on the beech shelves
 * RackMesh renders inside.
 */

export const CABINET_COLORS = {
  body: '#26282C',
  bodyHover: '#31343A',
  bodySelected: '#3A3D44',
  interior: '#3B3E44',
  interiorBack: '#34373C',
  steel: '#B9BEC4',
  led: '#DCEBFF',
  display: '#5FB8FF',
};

const DOOR_OPEN_ANGLE = -1.95; // radians, swings toward the viewer's left
const GLASS_THICK = 0.008;

/** Reusable steel material props for frame bars and the handle. */
const steelProps = { color: CABINET_COLORS.steel, metalness: 0.85, roughness: 0.3 };

/**
 * Carcass: sides, back, top (with the control strip), bottom + plinth,
 * interior lighting. `topStrip` and `bottomExtra` are the extra thickness
 * above the top bay and below the bottom bay (roomConstants.getCabinetGeometry).
 */
export function CabinetBody({ width, height, depth, topStrip, bottomExtra, bodyColor, hovered, lit = false }) {
  const halfW = width / 2;
  const halfH = height / 2;
  const halfD = depth / 2;
  const innerW = width - PANEL_THICK * 2;
  const innerH = height - PANEL_THICK * 2 - topStrip - bottomExtra;
  const innerCenterY = halfH - PANEL_THICK - topStrip - innerH / 2;
  const color = bodyColor || (hovered ? CABINET_COLORS.bodyHover : CABINET_COLORS.body);

  return (
    <group>
      {/* Side walls */}
      <mesh position={[-halfW + PANEL_THICK / 2, 0, 0]} castShadow>
        <boxGeometry args={[PANEL_THICK, height, depth]} />
        <meshStandardMaterial color={color} metalness={0.4} roughness={0.45} />
      </mesh>
      <mesh position={[halfW - PANEL_THICK / 2, 0, 0]} castShadow>
        <boxGeometry args={[PANEL_THICK, height, depth]} />
        <meshStandardMaterial color={color} metalness={0.4} roughness={0.45} />
      </mesh>
      {/* Back wall */}
      <mesh position={[0, 0, -halfD + PANEL_THICK / 2]}>
        <boxGeometry args={[innerW, height, PANEL_THICK]} />
        <meshStandardMaterial color={color} metalness={0.4} roughness={0.45} />
      </mesh>
      {/* Top: outer skin + the control strip that hangs under it */}
      <mesh position={[0, halfH - PANEL_THICK / 2, 0]} castShadow>
        <boxGeometry args={[width, PANEL_THICK, depth]} />
        <meshStandardMaterial color={color} metalness={0.4} roughness={0.45} />
      </mesh>
      <mesh position={[0, halfH - PANEL_THICK - topStrip / 2, halfD - topStrip / 2 - 0.01]}>
        <boxGeometry args={[innerW, topStrip, topStrip + 0.02]} />
        <meshStandardMaterial color={CABINET_COLORS.body} metalness={0.5} roughness={0.35} />
      </mesh>
      {/* Temperature display on the control strip */}
      <mesh position={[0, halfH - PANEL_THICK - topStrip / 2, halfD - 0.004]}>
        <boxGeometry args={[Math.min(0.09, innerW * 0.35), Math.min(0.016, topStrip * 0.5), 0.003]} />
        <meshStandardMaterial color="#0E2238" emissive={CABINET_COLORS.display} emissiveIntensity={1.6} roughness={0.2} />
      </mesh>
      {/* Bottom panel + plinth (the machine compartment) */}
      <mesh position={[0, -halfH + PANEL_THICK / 2 + bottomExtra, 0]} receiveShadow>
        <boxGeometry args={[width, PANEL_THICK, depth]} />
        <meshStandardMaterial color={color} metalness={0.4} roughness={0.45} />
      </mesh>
      <mesh position={[0, -halfH + bottomExtra / 2, -0.01]}>
        <boxGeometry args={[width, bottomExtra, depth - 0.02]} />
        <meshStandardMaterial color="#1C1E21" metalness={0.3} roughness={0.6} />
      </mesh>
      {/* Ventilation grille hint on the plinth */}
      <mesh position={[0, -halfH + bottomExtra / 2, halfD - 0.006]}>
        <boxGeometry args={[innerW * 0.8, bottomExtra * 0.45, 0.002]} />
        <meshStandardMaterial color="#111214" roughness={0.9} />
      </mesh>

      {/* Interior lining (lighter grey) */}
      <mesh position={[0, innerCenterY, -halfD + PANEL_THICK + 0.001]}>
        <planeGeometry args={[innerW, innerH]} />
        <meshStandardMaterial color={CABINET_COLORS.interiorBack} roughness={0.85} />
      </mesh>
      <mesh position={[-halfW + PANEL_THICK + 0.001, innerCenterY, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[depth - PANEL_THICK * 2, innerH]} />
        <meshStandardMaterial color={CABINET_COLORS.interior} roughness={0.85} />
      </mesh>
      <mesh position={[halfW - PANEL_THICK - 0.001, innerCenterY, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[depth - PANEL_THICK * 2, innerH]} />
        <meshStandardMaterial color={CABINET_COLORS.interior} roughness={0.85} />
      </mesh>

      {/* Vertical LED strips down both inner front edges + a top bar */}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * (innerW / 2 - 0.006), innerCenterY, halfD - 0.03]}>
          <boxGeometry args={[0.006, innerH - 0.02, 0.004]} />
          <meshStandardMaterial color={CABINET_COLORS.led} emissive={CABINET_COLORS.led} emissiveIntensity={1.8} roughness={0.4} />
        </mesh>
      ))}
      <mesh position={[0, halfH - PANEL_THICK - topStrip - 0.004, halfD - 0.03]}>
        <boxGeometry args={[innerW - 0.02, 0.004, 0.004]} />
        <meshStandardMaterial color={CABINET_COLORS.led} emissive={CABINET_COLORS.led} emissiveIntensity={1.8} roughness={0.4} />
      </mesh>
      {/* The glow itself: one soft cool light inside, near the top front.
          Only in the single-rack 3D view — every extra light in the room
          scene recompiles every material and adds a loop to every fragment,
          and the emissive strips already read as a lit interior there. */}
      {lit && (
        <pointLight
          position={[0, halfH - PANEL_THICK - topStrip - 0.05, halfD - 0.08]}
          intensity={0.55}
          color="#DCE8FF"
          distance={Math.max(height, depth) * 2.2}
          decay={1.6}
        />
      )}
    </group>
  );
}

/**
 * Glass door on a left hinge. The pane ignores raycasts so everything behind
 * it stays clickable; the handle toggles open/closed with a damped swing.
 */
export function CabinetDoor({ width, height, depth, bottomExtra }) {
  const [open, setOpen] = useState(false);
  const hinge = useRef();
  const doorH = height - bottomExtra - PANEL_THICK * 0.5;
  const doorCenterY = bottomExtra / 2 + PANEL_THICK * 0.25;
  const doorW = width - 0.004;
  const frame = 0.022;
  const zFront = depth / 2 + GLASS_THICK / 2 + 0.006;

  useFrame((_, delta) => {
    if (!hinge.current) return;
    const target = open ? DOOR_OPEN_ANGLE : 0;
    const cur = hinge.current.rotation.y;
    hinge.current.rotation.y = cur + (target - cur) * Math.min(1, delta * 6);
  });

  const toggle = (e) => { e.stopPropagation(); setOpen((v) => !v); };
  const hoverOn = (e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; };
  const hoverOff = () => { document.body.style.cursor = ''; };

  return (
    <group ref={hinge} position={[-width / 2, doorCenterY, zFront]}>
      <group position={[doorW / 2, 0, 0]}>
        {/* Glass — tinted, see-through, click-transparent */}
        <mesh raycast={() => null}>
          <boxGeometry args={[doorW - frame * 2, doorH - frame * 2, GLASS_THICK]} />
          <meshPhysicalMaterial
            color="#BFD3E6"
            transparent
            opacity={0.18}
            roughness={0.05}
            metalness={0.1}
            clearcoat={1}
            clearcoatRoughness={0.05}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
        {/* Frame bars */}
        <mesh position={[0, doorH / 2 - frame / 2, 0]} raycast={() => null}>
          <boxGeometry args={[doorW, frame, GLASS_THICK + 0.004]} />
          <meshStandardMaterial {...steelProps} />
        </mesh>
        <mesh position={[0, -doorH / 2 + frame / 2, 0]} raycast={() => null}>
          <boxGeometry args={[doorW, frame, GLASS_THICK + 0.004]} />
          <meshStandardMaterial {...steelProps} />
        </mesh>
        <mesh position={[-doorW / 2 + frame / 2, 0, 0]} raycast={() => null}>
          <boxGeometry args={[frame, doorH, GLASS_THICK + 0.004]} />
          <meshStandardMaterial {...steelProps} />
        </mesh>
        <mesh position={[doorW / 2 - frame / 2, 0, 0]} raycast={() => null}>
          <boxGeometry args={[frame, doorH, GLASS_THICK + 0.004]} />
          <meshStandardMaterial {...steelProps} />
        </mesh>
        {/* Handle: vertical stainless bar on the opening side, with a
            generous invisible hitbox so it is easy to click */}
        <group position={[doorW / 2 - frame - 0.02, 0, GLASS_THICK / 2 + 0.02]}>
          <mesh onClick={toggle} onPointerOver={hoverOn} onPointerOut={hoverOff}>
            <boxGeometry args={[0.05, Math.min(0.5, doorH * 0.6) + 0.04, 0.06]} />
            <meshBasicMaterial transparent opacity={0} />
          </mesh>
          <mesh rotation={[0, 0, 0]}>
            <cylinderGeometry args={[0.007, 0.007, Math.min(0.5, doorH * 0.6), 12]} />
            <meshStandardMaterial {...steelProps} />
          </mesh>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[0, s * (Math.min(0.5, doorH * 0.6) / 2 - 0.02), -0.012]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.005, 0.005, 0.024, 8]} />
              <meshStandardMaterial {...steelProps} />
            </mesh>
          ))}
        </group>
      </group>
    </group>
  );
}

/**
 * Beech shelf plank with a small front lip — the sliding shelf of a wine
 * cabinet. Used by RackMesh inside each pull-out bay.
 */
export function CabinetShelfPlank({ innerW, shelfDepth, y, woodTex, color }) {
  return (
    <group position={[0, y, 0]}>
      <mesh position={[0, 0, -shelfDepth * 0.02]}>
        <boxGeometry args={[innerW, WOOD_THICK, shelfDepth]} />
        <meshStandardMaterial map={woodTex} color={color} roughness={0.7} />
      </mesh>
      <mesh position={[0, WOOD_THICK * 0.9, shelfDepth / 2 - shelfDepth * 0.02]}>
        <boxGeometry args={[innerW, WOOD_THICK * 1.6, WOOD_THICK * 0.8]} />
        <meshStandardMaterial map={woodTex} color={color} roughness={0.7} />
      </mesh>
    </group>
  );
}

/** Radius used for cabinet bottle stacking math (kept next to the parts). */
export const CABINET_BOTTLE_RADIUS = BOTTLE_RADIUS;
