import { useRef, useState, useMemo, useEffect } from 'react';
import { Html } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  BOTTLE_RADIUS, CELL_W, CELL_H, RACK_DEPTH, WOOD_THICK, PANEL_THICK,
  getDisplayDims,
} from '../../utils/roomConstants';

// ── Bright, visible wine colors by type ──────────────────
const GLASS_COLORS = {
  red:       '#6A2020',
  white:     '#7A8A40',
  rosé:      '#A04068',
  sparkling: '#608850',
  dessert:   '#7A4070',
  fortified: '#7A4020',
};
const WINE_COLORS = {
  red:       '#8A1028',
  white:     '#E8D880',
  rosé:      '#E07898',
  sparkling: '#E8E0B0',
  dessert:   '#B06828',
  fortified: '#8A3810',
};
const FOIL_COLORS = {
  red:       '#2A2A2A',
  white:     '#F0E8D0',
  rosé:      '#F0B0C0',
  sparkling: '#D8B030',
  dessert:   '#8A5018',
  fortified: '#3A2010',
};
// Subtle emissive so bottles glow slightly and stand out
const EMISSIVE_COLORS = {
  red:       '#200808',
  white:     '#181808',
  rosé:      '#200810',
  sparkling: '#101808',
  dessert:   '#180808',
  fortified: '#180808',
};

// ── Procedural wood texture (light pine / birch) ─────────
let _woodTex = null;
function getWoodTexture() {
  if (_woodTex) return _woodTex;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#D8C4A0';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 40; i++) {
    const y = Math.random() * 256;
    ctx.strokeStyle = `rgba(${160 + Math.random() * 30}, ${130 + Math.random() * 20}, ${80 + Math.random() * 15}, ${0.06 + Math.random() * 0.1})`;
    ctx.lineWidth = 0.5 + Math.random() * 1.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x < 256; x += 20) {
      ctx.lineTo(x, y + (Math.random() - 0.5) * 4);
    }
    ctx.stroke();
  }
  for (let i = 0; i < 2; i++) {
    const kx = Math.random() * 256, ky = Math.random() * 256;
    const grad = ctx.createRadialGradient(kx, ky, 0, kx, ky, 6 + Math.random() * 6);
    grad.addColorStop(0, 'rgba(150, 120, 70, 0.25)');
    grad.addColorStop(1, 'rgba(150, 120, 70, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(kx - 12, ky - 12, 24, 24);
  }
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.025})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  _woodTex = new THREE.CanvasTexture(c);
  _woodTex.wrapS = _woodTex.wrapT = THREE.RepeatWrapping;
  _woodTex.repeat.set(2, 2);
  return _woodTex;
}

// ── Bottle lathe geometry (reused singleton) ─────────────
const _bottleProfiles = {};
function getBottleGeometry() {
  if (_bottleProfiles.geo) return _bottleProfiles.geo;
  const pts = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(0.025, 0.005),
    new THREE.Vector2(BOTTLE_RADIUS, 0.015),
    new THREE.Vector2(BOTTLE_RADIUS, 0.19),
    new THREE.Vector2(0.030, 0.205),
    new THREE.Vector2(0.015, 0.22),
    new THREE.Vector2(0.013, 0.27),
    new THREE.Vector2(0.015, 0.275),
    new THREE.Vector2(0.014, 0.285),
    new THREE.Vector2(0, 0.285),
  ];
  _bottleProfiles.geo = new THREE.LatheGeometry(pts, 12);
  return _bottleProfiles.geo;
}

// ── Clickable bottle (no inline popup — info shown in side panel) ────
// Rotation [PI/2, 0, 0] maps local Y→Z so bottle points into rack
// with neck/foil sticking out the front (+Z).
function Bottle({ position, wineType, slot, onBottleClick, highlighted }) {
  const glassColor = GLASS_COLORS[wineType] || GLASS_COLORS.red;
  const wineColor = WINE_COLORS[wineType] || WINE_COLORS.red;
  const foilColor = FOIL_COLORS[wineType] || FOIL_COLORS.red;
  const emissive = EMISSIVE_COLORS[wineType] || EMISSIVE_COLORS.red;
  const bottleGeo = useMemo(() => getBottleGeometry(), []);

  const handleClick = (e) => {
    e.stopPropagation();
    onBottleClick?.(slot);
  };

  return (
    <group position={position} rotation={[Math.PI / 2, 0, 0]}>
      {/* Highlight glow ring behind the bottle */}
      {highlighted && (
        <mesh position={[0, -0.01, 0]}>
          <torusGeometry args={[BOTTLE_RADIUS + 0.008, 0.006, 8, 24]} />
          <meshStandardMaterial
            color="#FFD700"
            emissive="#FFD700"
            emissiveIntensity={2}
            transparent
            opacity={0.9}
          />
        </mesh>
      )}
      {/* Glass bottle */}
      <mesh
        geometry={bottleGeo}
        castShadow
        onClick={handleClick}
        onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = ''; }}
      >
        <meshPhysicalMaterial
          color={highlighted ? '#FFE060' : glassColor}
          emissive={highlighted ? '#FFD700' : emissive}
          emissiveIntensity={highlighted ? 1.2 : 0.3}
          roughness={0.15}
          metalness={0.05}
          transmission={highlighted ? 0 : 0.12}
          thickness={0.5}
          clearcoat={0.5}
          clearcoatRoughness={0.1}
        />
      </mesh>
      {/* Wine fill */}
      <mesh position={[0, 0.1, 0]}>
        <cylinderGeometry args={[BOTTLE_RADIUS - 0.004, BOTTLE_RADIUS - 0.004, 0.17, 8]} />
        <meshStandardMaterial
          color={wineColor}
          emissive={wineColor}
          emissiveIntensity={0.15}
          roughness={0.5}
          transparent
          opacity={0.85}
        />
      </mesh>
      {/* Foil capsule */}
      <mesh position={[0, 0.275, 0]}>
        <cylinderGeometry args={[0.016, 0.016, 0.025, 8]} />
        <meshStandardMaterial color={foilColor} roughness={0.3} metalness={0.6} />
      </mesh>
      {/* Label band */}
      <mesh position={[0, 0.12, 0]}>
        <cylinderGeometry args={[BOTTLE_RADIUS + 0.001, BOTTLE_RADIUS + 0.001, 0.06, 8]} />
        <meshStandardMaterial color="#F0E8D8" roughness={0.85} metalness={0} />
      </mesh>
    </group>
  );
}

// ── Empty slot (ring + invisible click disc at cubby opening) ────────
function EmptySlot({ position, slotPosition, onClick }) {
  return (
    <group position={[position[0], position[1], RACK_DEPTH / 2 - 0.005]}>
      {/* Visible ring */}
      <mesh>
        <torusGeometry args={[BOTTLE_RADIUS - 0.005, 0.003, 6, 16]} />
        <meshStandardMaterial color="#9A8A70" transparent opacity={0.3} />
      </mesh>
      {/* Larger invisible click target covering the full cell area */}
      <mesh
        onClick={(e) => { e.stopPropagation(); onClick?.(slotPosition); }}
        onPointerOver={(e) => { if (onClick) { e.stopPropagation(); document.body.style.cursor = 'pointer'; } }}
        onPointerOut={() => { document.body.style.cursor = ''; }}
      >
        <circleGeometry args={[CELL_W / 2, 16]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
  );
}

// ── Slot positions ───────────────────────────────────────
function computeSlotPositions(rows, cols, width, height) {
  const positions = [];
  const cW = width / cols;
  const cH = height / rows;
  let pos = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      positions.push({
        position: pos++,
        x: -width / 2 + cW / 2 + c * cW,
        y: height / 2 - cH / 2 - r * cH,
        z: 0,
      });
    }
  }
  return positions;
}

// X-Rack: 4 triangular sections — mirrors the SVG rackLayouts algorithm exactly
function computeXRackSlotPositions(bps, width, height) {
  let k = 1;
  while (k * (k + 1) / 2 < bps) k++;

  // SVG layout constants (from rackLayouts.js) for proportional mapping
  const CELL_SVG = 48; // SLOT_R*2 + SLOT_GAP = 20*2+8
  const SLOT_R_SVG = 20;
  const rowStepSVG = CELL_SVG * 0.78;
  const colStepSVG = CELL_SVG * 0.82;
  const centerGapSVG = CELL_SVG * 0.35;
  const halfSideSVG = k * rowStepSVG + centerGapSVG + SLOT_R_SVG;

  // Scale from SVG space to 3D inner dimensions
  const halfW = width / 2;
  const scale = halfW / halfSideSVG;

  const positions = [];
  let pos = 1;

  for (let section = 0; section < 4; section++) {
    let placed = 0;
    for (let row = 0; row < k && placed < bps; row++) {
      const bottlesInRow = Math.min(k - row, bps - placed);
      const distFromCenter = (halfSideSVG - SLOT_R_SVG - row * rowStepSVG) * scale;

      for (let col = 0; col < bottlesInRow; col++) {
        const lateral = (col - (bottlesInRow - 1) / 2) * colStepSVG * scale;
        let x, y;
        // Mirror SVG sections but flip y-axis (SVG y-down → 3D y-up)
        switch (section) {
          case 0: x = lateral;          y = distFromCenter; break;   // top
          case 1: x = distFromCenter;   y = -lateral; break;         // right
          case 2: x = -lateral;         y = -distFromCenter; break;  // bottom
          case 3: x = -distFromCenter;  y = lateral; break;          // left
          default: x = 0; y = 0;
        }
        positions.push({ position: pos++, x, y, z: 0 });
        placed++;
      }
    }
  }
  return positions;
}

// Hex: even rows have cols slots, odd rows have cols-1 (offset right)
function computeHexSlotPositions(rows, cols, width, height) {
  const positions = [];
  const cW = width / cols;
  const hexH = height / rows;
  let pos = 1;
  for (let r = 0; r < rows; r++) {
    const isOdd = r % 2 === 1;
    const rowCols = isOdd ? Math.max(1, cols - 1) : cols;
    const xOff = isOdd ? cW * 0.5 : 0;
    for (let c = 0; c < rowCols; c++) {
      positions.push({
        position: pos++,
        x: -width / 2 + cW / 2 + c * cW + xOff,
        y: height / 2 - hexH / 2 - r * hexH,
        z: 0,
      });
    }
  }
  return positions;
}

// Triangle: row 0 has base slots, row 1 has base-1, etc.
function computeTriangleSlotPositions(cols, width, height) {
  const base = Math.max(1, cols);
  const numRows = base;
  const cW = width / base;
  const cH = height / numRows;
  const positions = [];
  let pos = 1;
  for (let r = 0; r < numRows; r++) {
    const rowCols = base - r;
    const xOff = (r * cW) / 2;
    for (let c = 0; c < rowCols; c++) {
      positions.push({
        position: pos++,
        x: -width / 2 + cW / 2 + c * cW + xOff,
        y: height / 2 - cH / 2 - r * cH,
        z: 0,
      });
    }
  }
  return positions;
}

// Stack: single column
function computeStackSlotPositions(rows, height) {
  const cH = height / rows;
  const positions = [];
  for (let r = 0; r < rows; r++) {
    positions.push({
      position: r + 1,
      x: 0,
      y: height / 2 - cH / 2 - r * cH,
      z: 0,
    });
  }
  return positions;
}

// ── Main rack component ──────────────────────────────────
export default function RackMesh({
  rack,
  position,
  rotation = 0,
  widthOverride,
  depthOverride,
  scaleOverride,
  isEditMode,
  isSelected,
  groupColor,
  onSetRef,
  onDragMove,
  onClick,
  onDragStart,
  onDragEnd,
  onBottleClick,
  onEmptySlotClick,
  onSnapPosition,
  highlightBottleId,
}) {
  const groupRef = useRef();
  const [hovered, setHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const { camera, raycaster, gl } = useThree();
  const lastDragPos = useRef({ x: 0, z: 0 });

  // Register ref for group-aware dragging
  useEffect(() => {
    if (groupRef.current && onSetRef) onSetRef(groupRef.current);
  });

  const rackType = rack.type || 'grid';

  // Compute display grid dimensions per type
  const { displayRows, displayCols } = getDisplayDims(rack);

  // Default computed size; overrides allow matching real-world dimensions
  // scaleOverride applies uniform scaling via a Three.js group transform
  const rackScale = scaleOverride || 1;
  const defaultWidth = displayCols * CELL_W + PANEL_THICK * 2;
  const width = widthOverride || defaultWidth;
  const depth = depthOverride || RACK_DEPTH;
  const height = displayRows * CELL_H + PANEL_THICK * 2;
  const innerW = (width - PANEL_THICK * 2);
  const effectiveCellW = innerW / displayCols;
  const innerH = displayRows * CELL_H;
  const rotRad = (rotation * Math.PI) / 180;

  const woodTex = useMemo(() => getWoodTexture(), []);

  const slotMap = useMemo(() => {
    const m = {};
    (rack.slots || []).forEach(s => { m[s.position] = s; });
    return m;
  }, [rack.slots]);

  // Accurate total slot count per type (including bottlesPerCell multiplier)
  const totalSlots = useMemo(() => {
    const bpc = rack.typeConfig?.bottlesPerCell || 1;
    if (rack.isModular) {
      return (rack.modules || []).reduce((sum, m) => sum + (m.rows || 1) * (m.cols || 1), 0);
    }
    switch (rackType) {
      case 'x-rack': { return 4 * (rack.typeConfig?.bottlesPerSection || 10); }
      case 'hex': {
        let t = 0;
        for (let r = 0; r < (rack.rows || 4); r++) t += (r % 2 === 0) ? (rack.cols || 4) : Math.max(1, (rack.cols || 4) - 1);
        return t;
      }
      case 'triangle': { const b = Math.max(1, rack.cols || 1); return (b * (b + 1)) / 2; }
      case 'stack': return rack.rows || 4;
      case 'shelf': return displayRows * displayCols * bpc;
      default: return displayRows * displayCols;
    }
  }, [rack.isModular, rack.modules, rack.typeConfig, rackType, rack.rows, rack.cols, displayRows, displayCols]);

  const slotPositions = useMemo(() => {
    if (rackType === 'x-rack') return computeXRackSlotPositions(rack.typeConfig?.bottlesPerSection || 10, innerW, innerH);
    if (rackType === 'hex') return computeHexSlotPositions(rack.rows || 4, rack.cols || 4, innerW, innerH);
    if (rackType === 'triangle') return computeTriangleSlotPositions(rack.cols || 1, innerW, innerH);
    if (rackType === 'stack') return computeStackSlotPositions(rack.rows || 4, innerH);
    return computeSlotPositions(displayRows, displayCols, innerW, innerH);
  }, [rackType, rack.rows, rack.cols, displayRows, displayCols, innerW, innerH]);

  const edgesGeom = useMemo(() => {
    const sw = width * rackScale, sh = height * rackScale, sd = depth * rackScale;
    const box = new THREE.BoxGeometry(sw + 0.02, sh + 0.02, sd + 0.02);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    return edges;
  }, [width, height, depth, rackScale]);

  // ── Drag logic ─────────────────────────────────────────
  const floorPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const dragOffset = useRef(new THREE.Vector3());

  const handlePointerDown = (e) => {
    if (!isEditMode) return;
    e.stopPropagation();
    onClick?.(e.shiftKey);

    const intersection = new THREE.Vector3();
    raycaster.ray.intersectPlane(floorPlane, intersection);
    if (!intersection) return;

    dragOffset.current.set(
      intersection.x - position[0], 0, intersection.z - position[2]
    );
    lastDragPos.current = { x: position[0], z: position[2] };
    setIsDragging(true);
    onDragStart?.();
    gl.domElement.style.cursor = 'grabbing';

    const onMove = (ev) => {
      const rect = gl.domElement.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(mouse, camera);
      const point = new THREE.Vector3();
      raycaster.ray.intersectPlane(floorPlane, point);
      if (!point) return;
      let nx = Math.round((point.x - dragOffset.current.x) * 20) / 20;
      let nz = Math.round((point.z - dragOffset.current.z) * 20) / 20;
      if (onSnapPosition) {
        const snapped = onSnapPosition(nx, nz);
        nx = snapped.x;
        nz = snapped.z;
      }

      // Compute delta and notify group members
      const dx = nx - lastDragPos.current.x;
      const dz = nz - lastDragPos.current.z;
      if (dx !== 0 || dz !== 0) {
        lastDragPos.current = { x: nx, z: nz };
        onDragMove?.(dx, dz);
      }

      if (groupRef.current) {
        groupRef.current.position.x = nx;
        groupRef.current.position.z = nz;
      }
    };

    const onUp = () => {
      setIsDragging(false);
      gl.domElement.style.cursor = '';
      if (groupRef.current) {
        onDragEnd?.([groupRef.current.position.x, position[1], groupRef.current.position.z]);
      }
      gl.domElement.removeEventListener('pointermove', onMove);
      gl.domElement.removeEventListener('pointerup', onUp);
    };

    gl.domElement.addEventListener('pointermove', onMove);
    gl.domElement.addEventListener('pointerup', onUp);
  };

  const handleClick = (e) => { if (isEditMode) return; e.stopPropagation(); onClick?.(e.shiftKey); };

  // Light natural pine / birch colors
  const frameColor = isSelected ? '#D8A870' : hovered ? '#D0B888' : '#C8AD82';
  const shelfColor = isSelected ? '#D0A068' : '#C4A478';
  const shelfDepth = depth * 0.85;

  return (
    <group ref={groupRef} position={position} rotation={[0, rotRad, 0]}>
    <group scale={[rackScale, rackScale, rackScale]}>

      {/* ── Side panels (full height, open depth) ──── */}
      <mesh position={[-width / 2 + PANEL_THICK / 2, 0, -depth * 0.05]} castShadow>
        <boxGeometry args={[PANEL_THICK, height, shelfDepth]} />
        <meshStandardMaterial map={woodTex} color={frameColor} roughness={0.7} />
      </mesh>
      <mesh position={[width / 2 - PANEL_THICK / 2, 0, -depth * 0.05]} castShadow>
        <boxGeometry args={[PANEL_THICK, height, shelfDepth]} />
        <meshStandardMaterial map={woodTex} color={frameColor} roughness={0.7} />
      </mesh>

      {/* ── Top rail ───────────────────────────────── */}
      <mesh position={[0, height / 2 - PANEL_THICK / 2, -depth * 0.05]} castShadow>
        <boxGeometry args={[width, PANEL_THICK, shelfDepth]} />
        <meshStandardMaterial map={woodTex} color={frameColor} roughness={0.7} />
      </mesh>

      {/* ── Bottom base ────────────────────────────── */}
      <mesh position={[0, -height / 2 + PANEL_THICK / 2, -depth * 0.05]} receiveShadow>
        <boxGeometry args={[width, PANEL_THICK, shelfDepth]} />
        <meshStandardMaterial map={woodTex} color={frameColor} roughness={0.7} />
      </mesh>

      {/* ── Type-specific internal structure ─────────── */}

      {/* Grid / hex / cube / stack / triangle: shelves + scallops + rails */}
      {rackType !== 'x-rack' && rackType !== 'shelf' && (
        <>
          {/* Shelves between rows (thin planks) */}
          {Array.from({ length: Math.max(displayRows - 1, 0) }).map((_, i) => {
            const sy = height / 2 - PANEL_THICK - (i + 1) * CELL_H;
            return (
              <mesh key={`sh-${i}`} position={[0, sy, -depth * 0.05]}>
                <boxGeometry args={[innerW, WOOD_THICK, shelfDepth]} />
                <meshStandardMaterial map={woodTex} color={shelfColor} roughness={0.75} />
              </mesh>
            );
          })}

          {/* Scallop bumps — wave cradle between bottle positions */}
          {Array.from({ length: displayRows }).map((_, r) => {
            const baseY = r < displayRows - 1
              ? height / 2 - PANEL_THICK - (r + 1) * CELL_H + WOOD_THICK / 2
              : -height / 2 + PANEL_THICK;
            return Array.from({ length: displayCols + 1 }).map((__, c) => {
              const bx = -innerW / 2 + c * effectiveCellW;
              return (
                <mesh
                  key={`bump-${r}-${c}`}
                  position={[bx, baseY + 0.007, -depth * 0.05]}
                  rotation={[Math.PI / 2, 0, 0]}
                >
                  <cylinderGeometry args={[0.005, 0.005, shelfDepth * 0.85, 6]} />
                  <meshStandardMaterial map={woodTex} color={shelfColor} roughness={0.7} />
                </mesh>
              );
            });
          })}

          {/* Thin front rail per shelf */}
          {Array.from({ length: displayRows }).map((_, r) => {
            const railY = r < displayRows - 1
              ? height / 2 - PANEL_THICK - (r + 1) * CELL_H + 0.008
              : -height / 2 + PANEL_THICK + 0.008;
            return (
              <mesh key={`rail-${r}`} position={[0, railY, shelfDepth / 2 - depth * 0.05 - 0.003]}>
                <boxGeometry args={[innerW, 0.005, 0.005]} />
                <meshStandardMaterial map={woodTex} color={frameColor} roughness={0.7} />
              </mesh>
            );
          })}
        </>
      )}

      {/* Shelf: open compartments — just horizontal shelf planks, no scallops or dividers */}
      {rackType === 'shelf' && (
        <>
          {/* Horizontal shelves between rows */}
          {Array.from({ length: Math.max(displayRows - 1, 0) }).map((_, i) => {
            const sy = height / 2 - PANEL_THICK - (i + 1) * CELL_H;
            return (
              <mesh key={`shelf-${i}`} position={[0, sy, -depth * 0.05]}>
                <boxGeometry args={[innerW, WOOD_THICK, shelfDepth]} />
                <meshStandardMaterial map={woodTex} color={shelfColor} roughness={0.75} />
              </mesh>
            );
          })}
        </>
      )}

      {/* X-Rack: two diagonal beams forming an X */}
      {rackType === 'x-rack' && (() => {
        const diagLen = Math.sqrt(innerW * innerW + innerH * innerH);
        const diagAngle = Math.atan2(innerH, innerW);
        const beamW = WOOD_THICK * 1.2;
        const beamDepth = shelfDepth * 0.5;

        return (
          <>
            {/* Beam 1: top-left to bottom-right */}
            <mesh position={[0, 0, -depth * 0.05]} rotation={[0, 0, -diagAngle]}>
              <boxGeometry args={[beamW, diagLen, beamDepth]} />
              <meshStandardMaterial map={woodTex} color={shelfColor} roughness={0.7} />
            </mesh>
            {/* Beam 2: top-right to bottom-left */}
            <mesh position={[0, 0, -depth * 0.05]} rotation={[0, 0, diagAngle]}>
              <boxGeometry args={[beamW, diagLen, beamDepth]} />
              <meshStandardMaterial map={woodTex} color={shelfColor} roughness={0.7} />
            </mesh>
          </>
        );
      })()}

      {/* ── Bottles / empty slots ─────────────────── */}
      {slotPositions.map(({ position: pos, x, y }) => {
        const slot = slotMap[pos];
        const filled = !!slot;
        const wineType = slot?.bottle?.wineDefinition?.type || 'red';
        return filled ? (
          <Bottle
            key={pos}
            position={[x, y, -0.08]}
            wineType={wineType}
            slot={slot}
            onBottleClick={onBottleClick}
            highlighted={highlightBottleId && (slot.bottle?._id || slot.bottle) === highlightBottleId}
          />
        ) : (
          <EmptySlot key={pos} position={[x, y, 0]} slotPosition={pos} onClick={onEmptySlotClick} />
        );
      })}

      {/* ── Click/drag plane (behind rack, doesn't block bottle clicks) */}
      <mesh
        position={[0, 0, -depth / 2 - 0.02]}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); if (isEditMode) gl.domElement.style.cursor = 'grab'; }}
        onPointerOut={() => { setHovered(false); if (!isDragging) gl.domElement.style.cursor = ''; }}
        onPointerDown={handlePointerDown}
        onClick={handleClick}
      >
        <planeGeometry args={[width + 0.1, height + 0.1]} />
        <meshBasicMaterial transparent opacity={0} side={THREE.DoubleSide} />
      </mesh>

    </group>{/* close scale group */}

      {/* ── Floating label (outside scale group for readability) ── */}
      {(isSelected || hovered) && (
        <Html
          position={[0, height * rackScale / 2 + 0.07, 0]}
          center
          distanceFactor={5}
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          <div style={{
            background: 'rgba(30, 20, 10, 0.92)',
            color: '#E8D8C8',
            padding: '3px 10px',
            borderRadius: '6px',
            fontSize: '11px',
            fontWeight: 600,
            whiteSpace: 'nowrap',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            border: isSelected ? '1px solid rgba(241, 196, 15, 0.6)' : '1px solid rgba(160, 120, 80, 0.3)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}>
            {rack.name}
            <span style={{ opacity: 0.55, marginLeft: 6, fontSize: '10px', fontWeight: 400 }}>
              {rack.slots?.length || 0}/{totalSlots}
            </span>
          </div>
        </Html>
      )}

      {/* ── Group link indicator ring ───────────────────── */}
      {isEditMode && groupColor && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -height * rackScale / 2 + 0.003, 0]}>
          <ringGeometry args={[Math.max(width, depth) * rackScale * 0.55, Math.max(width, depth) * rackScale * 0.63, 32]} />
          <meshBasicMaterial color={groupColor} transparent opacity={0.45} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* ── Selection outline ─────────────────────────── */}
      {isSelected && (
        <lineSegments geometry={edgesGeom}>
          <lineBasicMaterial color="#f1c40f" />
        </lineSegments>
      )}

      {/* ── Edit-mode glow ring ───────────────────────── */}
      {isEditMode && isSelected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -height * rackScale / 2 + 0.005, 0]}>
          <ringGeometry args={[Math.max(width, depth) * rackScale * 0.6, Math.max(width, depth) * rackScale * 0.7, 32]} />
          <meshBasicMaterial color="#f1c40f" transparent opacity={0.25} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}
