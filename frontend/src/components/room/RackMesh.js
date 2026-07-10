import { useRef, useState, useMemo, useEffect } from 'react';
import { Html } from '@react-three/drei';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  BOTTLE_RADIUS, CELL_W, CELL_H, RACK_DEPTH, WOOD_THICK, PANEL_THICK,
  getDisplayDims, buildScaledLayout, getGridDoubleRows,
} from '../../utils/roomConstants';
import { getTotalSlots, getModularTotalSlots, DOUBLE_ROW_HEADROOM } from '../../utils/rackLayouts';

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
// Default rotation [PI/2, 0, 0] maps local Y→Z so the bottle lies on its
// side with neck/foil sticking out the front (+Z, toward the viewer).
// For shelf-style racks with a back row, `flipNeck` reverses the bottle so
// its neck points -Z (into the cabinet). Front-row bottles get the default
// orientation; back-row bottles get flipNeck=true. The two rows then meet
// neck-to-neck at the shelf's depth centerline — matching how bottles
// actually lie in a Vintec/Transtherm cabinet.
// Restore the default document cursor if a hover-cursor mesh unmounts while
// hovered. R3F doesn't fire onPointerOut on unmount, so without this the
// page-wide 'pointer' cursor can get stuck (e.g. after Ctrl+Z removes a rack
// under a stationary cursor).
function useResetCursorOnUnmount() {
  useEffect(() => () => { document.body.style.cursor = ''; }, []);
}

function Bottle({ position, wineType, slot, onBottleClick, highlighted, scale = 1, flipNeck = false, lensStyle }) {
  // Lens/search style: a lens color re-tints the whole bottle (glass + wine
  // + glow) so the room reads as a heatmap; dim greys a non-matching bottle
  // out while a search is active. Highlight (gold) still wins below.
  const dim = !!lensStyle?.dim;
  const lensColor = dim ? null : lensStyle?.color || null;
  const glassColor = dim ? '#4A453E' : (lensColor || GLASS_COLORS[wineType] || GLASS_COLORS.red);
  const wineColor = dim ? '#4A453E' : (lensColor || WINE_COLORS[wineType] || WINE_COLORS.red);
  const foilColor = dim ? '#3A362F' : (FOIL_COLORS[wineType] || FOIL_COLORS.red);
  const emissive = dim ? '#000000' : (lensColor || EMISSIVE_COLORS[wineType] || EMISSIVE_COLORS.red);
  const emissiveIntensity = highlighted ? 1.2 : dim ? 0 : lensColor ? 0.25 : 0.3;
  const labelColor = dim ? '#6A645C' : '#F0E8D8';
  const bottleGeo = useMemo(() => getBottleGeometry(), []);
  useResetCursorOnUnmount();

  const handleClick = (e) => {
    e.stopPropagation();
    onBottleClick?.(slot);
  };

  // Inverse X-rotation lays the bottle on its side with the neck pointing
  // -Z instead of the default +Z. Wine fill, foil, and label offsets are
  // all on the bottle's local +Y axis so they stay in the right place after
  // the rotation; only the world-space orientation of the bottle flips.
  const rotation = flipNeck ? [-Math.PI / 2, 0, 0] : [Math.PI / 2, 0, 0];

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* Highlight is conveyed by the bottle material itself (brighter
          glass colour + emissive boost when highlighted) — see the
          meshPhysicalMaterial below. No external ring/halo geometry, so
          the highlighted bottle looks lit up instead of having a flat
          torus sitting under its foot on the shelf. */}
      {/* Glass bottle */}
      <mesh
        geometry={bottleGeo}
        castShadow
        onClick={handleClick}
        onPointerOver={(e) => { if (onBottleClick) { e.stopPropagation(); document.body.style.cursor = 'pointer'; } }}
        onPointerOut={() => { document.body.style.cursor = ''; }}
      >
        <meshPhysicalMaterial
          color={highlighted ? '#FFE060' : glassColor}
          emissive={highlighted ? '#FFD700' : emissive}
          emissiveIntensity={emissiveIntensity}
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
        <meshStandardMaterial color={labelColor} roughness={0.85} metalness={0} />
      </mesh>
    </group>
  );
}

// ── Empty slot (ring + invisible click disc at cubby opening) ────────
// Default (grid/hex/etc): position[2] is 0 and we offset to the cabinet
// front face. For shelf racks, the caller passes an absolute z (the cubby
// opening for that row) and useAbsoluteZ=true so we don't double-offset.
function EmptySlot({ position, slotPosition, onClick, isBack, useAbsoluteZ = false }) {
  useResetCursorOnUnmount();
  const zBase = useAbsoluteZ
    ? (position[2] || 0)
    : RACK_DEPTH / 2 - 0.005 + (position[2] || 0);
  const ringR = isBack ? (BOTTLE_RADIUS - 0.005) * 0.7 : BOTTLE_RADIUS - 0.005;
  return (
    <group position={[position[0], position[1], zBase]}>
      <mesh>
        <torusGeometry args={[ringR, 0.003, 6, 16]} />
        <meshStandardMaterial color="#9A8A70" transparent opacity={isBack ? 0.35 : 0.5} />
      </mesh>
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

// ── Disabled slot (small flat dark disc, non-interactive) ────────────
// Marks a position the user disabled as unusable. Deliberately cheap:
// one low-segment circle, no ring, no pointer handlers — the hole just
// reads as intentional. Sized like EmptySlot's ring.
function DisabledSlotDisc({ position, isBack }) {
  const r = (isBack ? 0.7 : 1) * (BOTTLE_RADIUS - 0.005);
  return (
    <mesh position={position}>
      <circleGeometry args={[r, 12]} />
      <meshStandardMaterial color="#3A3229" roughness={0.95} />
    </mesh>
  );
}

// ── Slot positions ───────────────────────────────────────
// Grid (and unknown-type fallback), with optional double-height rows.
//
// POSITION NUMBERING CONTRACT (double-height rows): the base grid keeps
// positions 1..rows*cols row-major EXACTLY as a plain grid — existing
// bottles never move. Top-layer positions are APPENDED after rows*cols:
// iterate valid double-height rows in ascending row order, each contributing
// cols-1 positions left-to-right (x staggered into the gaps between base
// bottles, y raised into the row's headroom). Example 4x6 grid with
// doubleHeightRows [2]: base 1..24 unchanged, top layer of row 2 =
// positions 25..29. Mirrors rackLayouts.gridLayout / backend rackGeometry.
function computeSlotPositions(rows, cols, width, height, doubleRows = []) {
  const positions = [];
  const cW = width / cols;
  // `height` includes DOUBLE_ROW_HEADROOM extra cell heights per double
  // row (see getGridExtraHeight); back the base cell height out of it.
  const cH = height / (rows + DOUBLE_ROW_HEADROOM * doubleRows.length);
  const extra = cH * DOUBLE_ROW_HEADROOM;
  const doubleSet = new Set(doubleRows);

  // Cumulative headroom above each 0-indexed row (3D is y-up, so headroom
  // above a row pushes the row itself and everything below it down).
  const yOffset = new Array(rows);
  let acc = 0;
  for (let r = 0; r < rows; r++) {
    if (doubleSet.has(r + 1)) acc += extra;
    yOffset[r] = acc;
  }
  const rowY = (r) => height / 2 - cH / 2 - r * cH - (yOffset[r] || 0);

  let pos = 1;
  // Base grid: positions 1..rows*cols, row-major.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      positions.push({
        position: pos++,
        x: -width / 2 + cW / 2 + c * cW,
        y: rowY(r),
        z: 0,
      });
    }
  }
  // Top layer: appended after rows*cols, ascending row order, left-to-right
  // (same X stagger pattern as computeShelfSlotPositions' back row).
  for (const d of doubleRows) {
    const r = d - 1;
    for (let c = 0; c < cols - 1; c++) {
      positions.push({
        position: pos++,
        x: -width / 2 + cW / 2 + (c + 0.5) * cW,
        y: rowY(r) + extra,
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

// Shelf with optional back row.
// Standard two-deep storage: both rows at the same shelf height, both with
// necks toward the viewer; the back row is positioned deeper in the rack and
// staggered in x so its necks peek between the front bottles.
//
// `depth` is the rack's actual frame depth (honours depthOverride) so the
// bottle bases and empty-ring openings track the cabinet instead of being
// pinned to the default depth. `bpc` (bottlesPerCell) renders multiple
// bottles per cubby, stacked slightly in z, matching the backend's
// 1..cells*bpc slot numbering (rackLayouts.shelfLayout).
function computeShelfSlotPositions(rows, cols, backCols, width, height, bpc = 1, depth = RACK_DEPTH) {
  const positions = [];
  const cW = width / cols;
  const cH = height / rows;
  const hasBack = backCols > 0;
  const halfDepth = depth / 2;
  // For a shelf with a back row, bottles lie neck-to-neck at the shelf
  // centerline:
  //   - Front row: BASE near the cabinet front (+Z), NECK pointing -Z toward
  //     the centerline. Rotation flipped via flipNeck=true.
  //   - Back row:  BASE near the cabinet back (-Z), NECK pointing +Z toward
  //     the centerline. Default rotation.
  // A bottle's local +Y axis has length 0.285 (LatheGeometry); its base sits
  // ~0.029 in from the cabinet face so the neck stops short of the centerline.
  const frontBottleZ = hasBack ? (halfDepth - 0.029) : -0.08;
  const backBottleZ  = -(halfDepth - 0.029);
  // Empty-slot ring positions sit at the cubby openings (front face for the
  // front row, back face for the back row) so users see where to drop a
  // bottle. These are absolute z within the rack, used with EmptySlot's
  // `useAbsoluteZ`.
  const frontEmptyZ = halfDepth - 0.005;
  const backEmptyZ  = -halfDepth + 0.005;
  // Per-bottle z step when a cubby holds more than one bottle (front-to-back).
  const Z_STEP = 0.03;
  // Keep the staggered back row inside the side panels (fixes overflow when
  // backCols approaches cols) and the per-bottle stagger inside the cabinet
  // depth (a high bottlesPerCell would otherwise push bottles out the open
  // back); for extreme configs bottles pile at the limit rather than escape.
  const xLimit = width / 2 - BOTTLE_RADIUS;
  const clampZ = (z) => Math.max(-halfDepth + 0.005, Math.min(halfDepth - 0.005, z));
  let pos = 1;
  for (let r = 0; r < rows; r++) {
    const y = height / 2 - cH / 2 - r * cH;
    for (let c = 0; c < cols; c++) {
      const x = -width / 2 + cW / 2 + c * cW;
      for (let b = 0; b < bpc; b++) {
        positions.push({
          position: pos++,
          x,
          y,
          z: clampZ(frontEmptyZ - b * Z_STEP),
          bottleZ: clampZ(frontBottleZ - b * Z_STEP),
          isBack: false,
          flipNeck: hasBack, // front-row bottles face into the shelf
          row: r,
        });
      }
    }
    if (hasBack) {
      for (let c = 0; c < backCols; c++) {
        const x = Math.max(-xLimit, Math.min(xLimit, -width / 2 + cW / 2 + (c + 0.5) * cW));
        for (let b = 0; b < bpc; b++) {
          positions.push({
            position: pos++,
            x,
            y,
            z: clampZ(backEmptyZ + b * Z_STEP),
            bottleZ: clampZ(backBottleZ + b * Z_STEP),
            isBack: true,
            flipNeck: false,
            row: r,
          });
        }
      }
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

// Fraction of the rack's depth a pulled-out shelf row travels in +Z
// (toward the viewer). At 0.85 the shelf telescopes out almost completely
// — for a shelf with a back row, this brings the back-row cubby openings
// past the cabinet's front face so the back rings are clickable instead
// of buried under the shelf above.
const PULL_OUT_FRACTION = 0.85;

/**
 * One shelf row's worth of geometry that can slide forward when "pulled".
 * Wraps the row's plank, bottles, empty rings, and a small pull-handle in
 * a single group whose Z position is lerped via useFrame — so all pieces
 * move together, like a real telescopic Vintec drawer.
 */
function PullOutShelfRow({
  row,
  isPulled,
  plankY,
  rackHeight,
  innerW,
  shelfDepth,
  depth,
  woodTex,
  shelfColor,
  frameColor,
  rowSlots,
  slotMap,
  disabledSet,
  onTogglePull,
  onBottleClick,
  onEmptySlotClick,
  highlightBottleId,
  getBottleStyle,
}) {
  useResetCursorOnUnmount();
  const groupRef = useRef();
  const targetZ = isPulled ? depth * PULL_OUT_FRACTION : 0;
  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const current = groupRef.current.position.z;
    // Critically-damped-ish lerp: covers ~95% of the remaining distance per ~0.4s
    const t = Math.min(1, delta * 8);
    groupRef.current.position.z = current + (targetZ - current) * t;
  });

  // Pull-handle: a small wooden bar at the front of the shelf row that the
  // user can click to slide it forward. Hovering changes the cursor.
  // The bottom row has no plank, so derive its handle Y from the rack's actual
  // bottom panel (rackHeight) rather than a fixed offset that floated the
  // handle below the floor.
  const handleY = plankY != null
    ? plankY + 0.012
    : -rackHeight / 2 + PANEL_THICK + 0.012;
  // Place the handle at the cabinet's actual front face so it's reachable
  // before the shelf is pulled, and remains reachable after for retracting.
  const handleZ = depth / 2 - 0.005;

  return (
    <group ref={groupRef}>
      {/* Wooden shelf plank — only present for rows that have one
          (every row except the bottom one, whose floor is the rack's
          bottom panel) */}
      {plankY != null && (
        <mesh position={[0, plankY, -depth * 0.05]}>
          <boxGeometry args={[innerW, WOOD_THICK_LOCAL, shelfDepth]} />
          <meshStandardMaterial map={woodTex} color={shelfColor} roughness={0.75} />
        </mesh>
      )}

      {/* Bottles for this row. Empty-slot rings are hidden by default to
          keep the closed-rack view clean; they only appear once the user
          has pulled the shelf out, so the click targets are then in clear
          space in front of the cabinet rather than buried inside it. */}
      {rowSlots.map(({ position: pos, x, y, z = 0, bottleZ, isBack, flipNeck }) => {
        const slot = slotMap[pos];
        const filled = !!slot;
        const wineType = slot?.bottle?.wineDefinition?.type || 'red';
        const finalBottleZ = bottleZ !== undefined ? bottleZ : (-0.08 + z);
        if (!filled && disabledSet?.has(pos)) {
          return <DisabledSlotDisc key={pos} position={[x, y, z]} isBack={isBack} />;
        }
        if (filled) {
          return (
            <Bottle
              key={pos}
              position={[x, y, finalBottleZ]}
              wineType={wineType}
              slot={slot}
              onBottleClick={onBottleClick}
              highlighted={highlightBottleId && (slot.bottle?._id || slot.bottle) === highlightBottleId}
              flipNeck={!!flipNeck}
              lensStyle={getBottleStyle ? getBottleStyle(slot) : null}
            />
          );
        }
        if (!isPulled) return null;
        return (
          <EmptySlot
            key={pos}
            position={[x, y, z]}
            slotPosition={pos}
            onClick={onEmptySlotClick}
            isBack={isBack}
            useAbsoluteZ
          />
        );
      })}

      {/* Pull handle — wooden bar at the front of the shelf. The visible
          mesh is small (Vintec-style); a separate invisible hitbox makes
          it easy to click without hunting for a millimetre-thin target. */}
      <group position={[0, handleY, handleZ]}>
        <mesh
          onClick={(e) => { e.stopPropagation(); onTogglePull(); }}
          onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
          onPointerOut={() => { document.body.style.cursor = ''; }}
        >
          {/* Invisible larger hitbox: wider, taller, and deeper than the
              visible bar so the cursor can reasonably land on it. */}
          <boxGeometry args={[innerW * 0.65, 0.04, 0.05]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>
        <mesh>
          {/* Visible handle — slightly larger than before for visibility. */}
          <boxGeometry args={[innerW * 0.55, 0.018, 0.022]} />
          <meshStandardMaterial color={frameColor} roughness={0.5} metalness={0.15} />
        </mesh>
      </group>
    </group>
  );
}

// Re-export of WOOD_THICK inside this file so the sub-component can read it
// without importing from roomConstants (already imported at file top).
const WOOD_THICK_LOCAL = 0.012;

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
  getBottleStyle,
  enableShelfPullOut = false,
}) {
  // Which shelf row is currently pulled out (or null). Telescopic-drawer
  // behaviour: only one row at a time; clicking the active row's pull
  // handle retracts it.
  const [pulledShelfRow, setPulledShelfRow] = useState(null);
  const groupRef = useRef();
  const [hovered, setHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const { camera, raycaster, gl } = useThree();
  const lastDragPos = useRef({ x: 0, z: 0 });
  // Store active drag listeners for cleanup on unmount (declared early so cleanup effect can use it)
  const dragListenersRef = useRef(null);

  // Register ref for group-aware dragging (only re-run when rack identity changes)
  useEffect(() => {
    if (groupRef.current && onSetRef) onSetRef(groupRef.current);
  }, [rack._id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup drag listeners if component unmounts during an active drag
  // (e.g. the rack is removed/undone mid-drag). RoomScene also re-enables
  // OrbitControls on the next pointer release as a safety net.
  useEffect(() => {
    return () => {
      if (dragListenersRef.current) {
        window.removeEventListener('pointermove', dragListenersRef.current.onMove);
        window.removeEventListener('pointerup', dragListenersRef.current.onUp);
        window.removeEventListener('pointercancel', dragListenersRef.current.onUp);
        dragListenersRef.current = null;
      }
    };
  }, []);

  const rackType = rack.type || 'grid';

  // Compute display grid dimensions per type
  const { displayRows, displayCols } = getDisplayDims(rack);

  // Double-height rows (grid racks only) — the rack grows taller by
  // DOUBLE_ROW_HEADROOM cell heights per double row so the top-layer
  // bottles fit under the plank/top rail above.
  const doubleRows = useMemo(
    () => getGridDoubleRows(rack),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rack.isModular, rack.type, rack.rows, rack.cols, rack.typeConfig?.doubleHeightRows]
  );
  const extraRowH = CELL_H * DOUBLE_ROW_HEADROOM;
  // Cumulative headroom above (and including) 0-indexed row r — shifts that
  // row's plank/scallops/rail down so they stay under the row's bottles.
  const headroomAbove = (r) => {
    let n = 0;
    for (const d of doubleRows) if (d - 1 <= r) n++;
    return n * extraRowH;
  };

  // Cube and modular racks have irregular internal layouts. Reuse the 2D
  // layout engine (rackLayouts.js — source of truth for slot numbering) and
  // scale its coordinates into 3D metres so bottles land in the right cells
  // and the frame is sized to the true footprint.
  const useScaled = rack.isModular || rackType === 'cube';
  const scaledLayout = useMemo(
    () => (useScaled ? buildScaledLayout(rack) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [useScaled, rack.isModular, rack.modules, rack.type, rack.rows, rack.cols, rack.typeConfig]
  );

  // Default computed size; overrides allow matching real-world dimensions
  // scaleOverride applies uniform scaling via a Three.js group transform
  const rackScale = scaleOverride || 1;
  const baseInnerW = scaledLayout ? scaledLayout.innerW : displayCols * CELL_W;
  const baseInnerH = scaledLayout
    ? scaledLayout.innerH
    : displayRows * CELL_H + doubleRows.length * extraRowH;
  const defaultWidth = baseInnerW + PANEL_THICK * 2;
  // x-rack is square by construction; honouring a stray widthOverride (e.g.
  // left over from a rack that was switched to x-rack after a width was set)
  // would stretch the slot grid and X-beams out of alignment, so ignore it.
  const width = rackType === 'x-rack' ? defaultWidth : (widthOverride || defaultWidth);
  const hasShelfBack = rackType === 'shelf' && (rack.typeConfig?.backCols || 0) > 0;
  const depth = depthOverride || (hasShelfBack ? RACK_DEPTH * 1.7 : RACK_DEPTH);
  const innerW = (width - PANEL_THICK * 2);
  const innerH = baseInnerH;
  const height = innerH + PANEL_THICK * 2;
  const effectiveCellW = innerW / displayCols;
  const rotRad = (rotation * Math.PI) / 180;

  const woodTex = useMemo(() => getWoodTexture(), []);

  const slotMap = useMemo(() => {
    const m = {};
    (rack.slots || []).forEach(s => { m[s.position] = s; });
    return m;
  }, [rack.slots]);

  const disabledSet = useMemo(
    () => new Set(rack.disabledPositions || []),
    [rack.disabledPositions]
  );

  // Accurate total slot count per type — reuses the same helpers the 2D rack
  // view uses, so the label always matches the backend's real capacity
  // (handles per-module types, cube, and shelf bottlesPerCell correctly).
  const totalSlots = useMemo(() => {
    if (rack.isModular) return getModularTotalSlots(rack.modules || []);
    return getTotalSlots(rackType, rack.rows || 4, rack.cols || 4, rack.typeConfig);
  }, [rack.isModular, rack.modules, rackType, rack.rows, rack.cols, rack.typeConfig]);

  const slotPositions = useMemo(() => {
    if (scaledLayout) {
      // The scaled positions are in base metres. Scale x so the bottle grid
      // tracks the frame when a widthOverride stretches/shrinks it (there is
      // no height override, so y is left as-is).
      const sx = scaledLayout.innerW ? innerW / scaledLayout.innerW : 1;
      return sx === 1
        ? scaledLayout.positions
        : scaledLayout.positions.map(p => ({ ...p, x: p.x * sx }));
    }
    if (rackType === 'x-rack') return computeXRackSlotPositions(rack.typeConfig?.bottlesPerSection || 10, innerW, innerH);
    if (rackType === 'hex') return computeHexSlotPositions(rack.rows || 4, rack.cols || 4, innerW, innerH);
    if (rackType === 'triangle') return computeTriangleSlotPositions(rack.cols || 1, innerW, innerH);
    if (rackType === 'stack') return computeStackSlotPositions(rack.rows || 4, innerH);
    if (rackType === 'shelf') return computeShelfSlotPositions(
      displayRows, displayCols, rack.typeConfig?.backCols || 0, innerW, innerH,
      rack.typeConfig?.bottlesPerCell || 1, depth
    );
    return computeSlotPositions(displayRows, displayCols, innerW, innerH, doubleRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaledLayout, rackType, rack.rows, rack.cols, displayRows, displayCols, innerW, innerH, depth,
      doubleRows, rack.typeConfig?.backCols, rack.typeConfig?.bottlesPerCell, rack.typeConfig?.bottlesPerSection]);

  const edgesGeom = useMemo(() => {
    const sw = width * rackScale, sh = height * rackScale, sd = depth * rackScale;
    const box = new THREE.BoxGeometry(sw + 0.02, sh + 0.02, sd + 0.02);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    return edges;
  }, [width, height, depth, rackScale]);

  // Dispose the previous EdgesGeometry when the rack is resized (the memo
  // rebuilds on size/scale change) and on unmount. R3F never disposes a
  // geometry passed via the `geometry` prop, so without this it leaks a GPU
  // buffer per resize.
  useEffect(() => () => edgesGeom.dispose(), [edgesGeom]);

  // ── Drag logic ─────────────────────────────────────────
  // Use a ref for the drag plane so it can be set to the rack's y-elevation
  // at drag start (fixes incorrect projection for stacked/elevated racks)
  const floorPlane = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
  const dragOffset = useRef(new THREE.Vector3());

  const handlePointerDown = (e) => {
    if (!isEditMode) return;
    e.stopPropagation();
    onClick?.(e.shiftKey);

    // Set drag plane to the rack's current y-elevation (fixes Bug 4:
    // stacked racks no longer project to y=0)
    const rackY = position[1];
    floorPlane.current.set(new THREE.Vector3(0, 1, 0), -rackY);

    // intersectPlane returns null on a miss (the target vector is left
    // untouched) — check the RETURN value, not the always-truthy target,
    // or a miss reads as a hit at (0,0,0) and corrupts the drag offset.
    const intersection = new THREE.Vector3();
    const hit = raycaster.ray.intersectPlane(floorPlane.current, intersection);
    if (!hit) return;

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
      const moveHit = raycaster.ray.intersectPlane(floorPlane.current, point);
      if (!moveHit) return; // ray missed the drag plane (pointer above horizon)
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
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      dragListenersRef.current = null;
    };

    // Remove any stale listeners before adding new ones
    if (dragListenersRef.current) {
      window.removeEventListener('pointermove', dragListenersRef.current.onMove);
      window.removeEventListener('pointerup', dragListenersRef.current.onUp);
      window.removeEventListener('pointercancel', dragListenersRef.current.onUp);
    }
    dragListenersRef.current = { onMove, onUp };

    // Listen on window (not the canvas) so a pointer release outside the canvas
    // — over a side panel, the header, or off-window — still ends the drag.
    // pointercancel covers touch/pen interruptions.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
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

      {/* Grid / hex / stack / triangle: shelves + scallops + rails. Cube and
          modular racks have irregular internal layouts (driven by the scaled
          2D layout), so the simple per-row planks/scallops don't apply. */}
      {rackType !== 'x-rack' && rackType !== 'shelf' && rackType !== 'cube' && !rack.isModular && (
        <>
          {/* Shelves between rows (thin planks). headroomAbove shifts a
              plank down past the extra headroom of every double-height row
              above it, so each plank stays directly under its row's bottles
              (and above the next row's top layer). */}
          {Array.from({ length: Math.max(displayRows - 1, 0) }).map((_, i) => {
            const sy = height / 2 - PANEL_THICK - (i + 1) * CELL_H - headroomAbove(i);
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
              ? height / 2 - PANEL_THICK - (r + 1) * CELL_H - headroomAbove(r) + WOOD_THICK / 2
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
              ? height / 2 - PANEL_THICK - (r + 1) * CELL_H - headroomAbove(r) + 0.008
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

      {/* Shelf: open compartments — just horizontal shelf planks, no scallops
          or dividers. When pull-out is enabled the planks become part of
          per-row sliding groups (rendered below alongside the bottles), so
          we skip the static planks here to avoid double-rendering. */}
      {rackType === 'shelf' && !enableShelfPullOut && (
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
      {rackType === 'shelf' && enableShelfPullOut ? (
        // Per-row groups so each shelf row can slide forward independently.
        // Planks live inside the row groups too (so the wood slides with
        // its bottles).
        Array.from({ length: displayRows }).map((_, r) => {
          const rowSlots = slotPositions.filter(sp => sp.row === r);
          const hasPlank = r < displayRows - 1;
          const plankY = hasPlank
            ? height / 2 - PANEL_THICK - (r + 1) * CELL_H
            : null;
          return (
            <PullOutShelfRow
              key={`row-${r}`}
              row={r}
              isPulled={pulledShelfRow === r}
              plankY={plankY}
              rackHeight={height}
              innerW={innerW}
              shelfDepth={shelfDepth}
              depth={depth}
              woodTex={woodTex}
              shelfColor={shelfColor}
              frameColor={frameColor}
              rowSlots={rowSlots}
              slotMap={slotMap}
              disabledSet={disabledSet}
              onTogglePull={() => setPulledShelfRow(prev => prev === r ? null : r)}
              onBottleClick={onBottleClick}
              onEmptySlotClick={onEmptySlotClick}
              highlightBottleId={highlightBottleId}
              getBottleStyle={getBottleStyle}
            />
          );
        })
      ) : (
        slotPositions.map(({ position: pos, x, y, z = 0, bottleZ, isBack, flipNeck }) => {
          const slot = slotMap[pos];
          const filled = !!slot;
          const wineType = slot?.bottle?.wineDefinition?.type || 'red';
          const finalBottleZ = bottleZ !== undefined ? bottleZ : (-0.08 + z);
          if (!filled && disabledSet.has(pos)) {
            return (
              <DisabledSlotDisc
                key={pos}
                position={[x, y, rackType === 'shelf' ? z : (depth / 2 - 0.005)]}
                isBack={isBack}
              />
            );
          }
          return filled ? (
            <Bottle
              key={pos}
              position={[x, y, finalBottleZ]}
              wineType={wineType}
              slot={slot}
              onBottleClick={onBottleClick}
              highlighted={highlightBottleId && (slot.bottle?._id || slot.bottle) === highlightBottleId}
              flipNeck={!!flipNeck}
              lensStyle={getBottleStyle ? getBottleStyle(slot) : null}
            />
          ) : (
            <EmptySlot
              key={pos}
              // Shelf positions encode an absolute z (cubby opening for their
              // row). Other types use z=0; place their ring at the actual
              // cabinet front face (depth-aware) so it tracks the opening even
              // when depthOverride resizes the cabinet.
              position={[x, y, rackType === 'shelf' ? z : (depth / 2 - 0.005)]}
              slotPosition={pos}
              onClick={onEmptySlotClick}
              isBack={isBack}
              useAbsoluteZ
            />
          );
        })
      )}

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
              {rack.slots?.length || 0}/{totalSlots - disabledSet.size}
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
