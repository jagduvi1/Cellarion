/**
 * Shared constants and helpers for the 3D room view.
 * Used by CellarRoom, RoomScene, and RackMesh to avoid duplication.
 */

import {
  computeLayout, computeModularLayout, CELL_SIZE,
  validDoubleHeightRows, DOUBLE_ROW_HEADROOM, cabinetShelfRows, cabinetBays, cabinetHeadToTail,
  cabinetRowWidth, cabinetBayUnits, cabinetNeckForward,
  cabinetBayOpts, cabinetRestsBehindAcross, cabinetRowOffset,
} from './rackLayouts';

// ── Rack physical dimensions (metres) ────────────────────
export const CELL_W = 0.105;       // cell width
export const CELL_H = 0.105;       // cell height
export const RACK_DEPTH = 0.34;    // default rack depth
export const WOOD_THICK = 0.012;   // internal shelf/beam thickness
export const PANEL_THICK = 0.018;  // outer frame panel thickness
export const BOTTLE_RADIUS = 0.037;
export const BOTTLE_LENGTH = 0.285; // base to capsule, along the bottle lathe's local +Y

// ── Cabinet (wine fridge) dimensions ─────────────────────
export const CABINET_LEVEL_H = 0.079;      // vertical pitch of stacked bottle rows
// A level nested in the grooves of the level below sits √3/2 of a bottle
// diameter higher, not a full one (touching circles offset by half a
// diameter). Same ratio the hex layout uses.
export const CABINET_NEST_RATIO = Math.sqrt(3) / 2;
export const CABINET_BAY_HEADROOM = 0.03;  // air above the top row of a bay
export const CABINET_TOP_STRIP = 0.04;     // control strip under the top panel
export const CABINET_BOTTOM_EXTRA = 0.05;  // plinth / machine compartment
export const CABINET_DEPTH_TWO_DEEP = 0.62; // neck-to-neck bottles need ~2 × 0.285
export const CABINET_DEPTH_SINGLE = 0.42;

/**
 * Bay-by-bay geometry of a cabinet rack in rack-local metres (rack centred
 * at y = 0, top at +height/2). Shelf i (from the top) is a bay of
 * shelfRows[i] rows; with twoDeep two rows share one level, so the bay is
 * ceil(rows / 2) levels tall. Every renderer (RackMesh body, bays, bottles,
 * ShelfView3D camera, RoomScene stacking) reads this one function so they
 * agree on where each plank and bottle is.
 */
export function getCabinetGeometry(rack) {
  const shelfRows = cabinetShelfRows(rack.rows || 1, rack.typeConfig);
  const shapes = cabinetBays(rack.rows || 1, rack.cols || 1, rack.typeConfig);
  const twoDeep = rack.typeConfig?.twoDeep !== false;
  const stagger = rack.typeConfig?.stagger !== false;
  const headToTail = cabinetHeadToTail(rack.typeConfig);
  // Alternating rows always nest (a narrow row lies in the grooves of the
  // wide row below), so a bay that alternates nests whatever stagger says —
  // as in rackLayouts. `alternate` here = every bay does.
  const alternate = shapes.length > 0 && shapes.every((b) => b.alternate);
  const pitchOf = (bay) => ((bay.alternate || stagger) ? CABINET_LEVEL_H * CABINET_NEST_RATIO : CABINET_LEVEL_H);
  const levelPitch = (alternate || stagger) ? CABINET_LEVEL_H * CABINET_NEST_RATIO : CABINET_LEVEL_H;
  const levelsOf = (rows) => (twoDeep ? Math.ceil(rows / 2) : rows);
  // The first level rests on the plank; only the levels ABOVE it are nested.
  const bayHeights = shapes.map((b) => Math.max(
    CELL_H,
    CABINET_LEVEL_H + Math.max(0, levelsOf(b.rows) - 1) * pitchOf(b) + CABINET_BAY_HEADROOM
  ));
  const n = shelfRows.length;
  const innerH = CABINET_TOP_STRIP
    + bayHeights.reduce((a, b) => a + b, 0)
    + Math.max(0, n - 1) * WOOD_THICK
    + CABINET_BOTTOM_EXTRA;
  const height = innerH + PANEL_THICK * 2;
  let y = height / 2 - PANEL_THICK - CABINET_TOP_STRIP;
  const bays = shelfRows.map((rows, i) => {
    const top = y;
    const bottom = y - bayHeights[i];
    y = bottom - WOOD_THICK;
    return {
      index: i, rows, levels: levelsOf(rows), height: bayHeights[i], top, bottom,
      // The bay's own width and pattern, how its bottles lie ('' / 'front' /
      // 'all' — drawing only), and the pitch its levels stack at.
      cols: shapes[i].cols, alternate: shapes[i].alternate, sideways: shapes[i].sideways, levelPitch: pitchOf(shapes[i]),
      // The beech plank under this bay (the bottom bay rests on the cabinet floor).
      plankY: i < n - 1 ? bottom - WOOD_THICK / 2 : null,
    };
  });
  return {
    shelfRows, twoDeep, stagger, alternate, headToTail, levelPitch, bays, innerH, height,
    depth: twoDeep ? CABINET_DEPTH_TWO_DEEP : CABINET_DEPTH_SINGLE,
    topStrip: CABINET_TOP_STRIP, bottomExtra: CABINET_BOTTOM_EXTRA,
  };
}

// Metres per SVG pixel: one 2D layout cell (CELL_SIZE px, centre-to-centre)
// maps to one 3D cell (CELL_W metres). Lets us reuse the 2D layout engine
// for irregular rack types (cube / modular) and stay in sync with it.
const SVG_TO_M = CELL_W / CELL_SIZE;

/**
 * Build 3D slot positions for cube / modular racks by reusing the 2D layout
 * engine (rackLayouts.js — the single source of truth for slot numbering) and
 * scaling its SVG coordinates into 3D metres, centred on the rack origin with
 * the SVG y-down axis flipped to 3D y-up.
 *
 * Returns { positions: [{ position, x, y, z }], innerW, innerH } in metres.
 */
export function buildScaledLayout(rack) {
  const layout = rack.isModular
    ? computeModularLayout(rack.modules || [])
    : computeLayout(rack.type || 'grid', rack.rows || 4, rack.cols || 4, rack.typeConfig);
  const vbW = layout.viewBox.width || 0;
  const vbH = layout.viewBox.height || 0;
  const positions = (layout.slots || []).map(s => ({
    position: s.position,
    x: (s.cx - vbW / 2) * SVG_TO_M,
    y: (vbH / 2 - s.cy) * SVG_TO_M,
    z: 0,
  }));
  return { positions, innerW: vbW * SVG_TO_M, innerH: vbH * SVG_TO_M };
}

// True for rack types whose internal layout is irregular and therefore driven
// by the scaled 2D layout rather than the simple rows × cols grid formulas.
function usesScaledLayout(rack) {
  return !!rack.isModular || (rack.type || 'grid') === 'cube';
}

/**
 * Compute display grid dimensions (rows × cols) for any rack type.
 */
export function getDisplayDims(rack) {
  const rackType = rack.type || 'grid';
  if (rack.isModular) {
    return {
      displayRows: Math.max(...(rack.modules || []).map(m => (m.y || 0) + (m.rows || 1)), 1),
      displayCols: Math.max(...(rack.modules || []).map(m => (m.x || 0) + (m.cols || 1)), 1),
    };
  }
  switch (rackType) {
    case 'x-rack': {
      const bps = rack.typeConfig?.bottlesPerSection || 10;
      let k = 1;
      while (k * (k + 1) / 2 < bps) k++;
      const size = 2 * k + 1;
      return { displayRows: size, displayCols: size };
    }
    case 'triangle': {
      const base = Math.max(1, rack.cols || 1);
      return { displayRows: base, displayCols: base };
    }
    case 'stack':
      return { displayRows: rack.rows || 4, displayCols: 1 };
    default:
      return { displayRows: rack.rows || 4, displayCols: rack.cols || 4 };
  }
}

/**
 * Valid double-height rows for a simple grid rack (empty for every other
 * shape). See rackLayouts.validDoubleHeightRows for the filtering rules.
 */
export function getGridDoubleRows(rack) {
  if (rack.isModular || (rack.type || 'grid') !== 'grid') return [];
  return validDoubleHeightRows(rack.rows || 4, rack.cols || 4, rack.typeConfig?.doubleHeightRows);
}

/**
 * Extra inner height (metres) a grid rack needs for its double-height rows:
 * DOUBLE_ROW_HEADROOM cell heights of headroom above each double row so the
 * top-layer bottles fit under the shelf/plank above.
 */
export function getGridExtraHeight(rack) {
  return getGridDoubleRows(rack).length * CELL_H * DOUBLE_ROW_HEADROOM;
}

/**
 * Compute full rack height in metres (outer frame included).
 */
export function getRackHeight(rack) {
  if (usesScaledLayout(rack)) {
    return buildScaledLayout(rack).innerH + PANEL_THICK * 2;
  }
  if (rack.type === 'cabinet' && !rack.isModular) return getCabinetGeometry(rack).height;
  const { displayRows } = getDisplayDims(rack);
  return displayRows * CELL_H + getGridExtraHeight(rack) + PANEL_THICK * 2;
}

/**
 * Default rack depth in metres. Two-deep shelves need extra depth to fit
 * front + back bottles end-to-end inside the shelf.
 */
export function getDefaultRackDepth(rack) {
  if (rack.type === 'cabinet' && !rack.isModular) return getCabinetGeometry(rack).depth;
  const hasShelfBack = rack.type === 'shelf' && (rack.typeConfig?.backCols || 0) > 0;
  return hasShelfBack ? RACK_DEPTH * 1.7 : RACK_DEPTH;
}

/**
 * Compute world-space half-width/half-depth for a rack, accounting for
 * rotation and width/depth overrides from the placement.
 */
export function getRackWorldDims(rack, placement) {
  const defaultW = usesScaledLayout(rack)
    ? buildScaledLayout(rack).innerW + PANEL_THICK * 2
    : getDisplayDims(rack).displayCols * CELL_W + PANEL_THICK * 2;
  const w = placement.widthOverride || defaultW;
  const d = placement.depthOverride || getDefaultRackDepth(rack);
  const scale = placement.scaleOverride || 1;
  const rot = (placement.rotation || 0) % 360;
  const isRotated = rot === 90 || rot === 270;
  return {
    halfW: ((isRotated ? d : w) * scale) / 2,
    halfD: ((isRotated ? w : d) * scale) / 2,
  };
}

/**
 * Clamp a rack position so the rack stays within the room walls.
 * roomDims: { width, depth }  — full room dimensions (room centered at origin)
 * Returns clamped { x, z }.
 */
export function clampToRoom(x, z, rack, placement, roomDims) {
  const { halfW, halfD } = getRackWorldDims(rack, placement);
  const roomHalfW = roomDims.width / 2;
  const roomHalfD = roomDims.depth / 2;
  return {
    x: Math.max(-roomHalfW + halfW, Math.min(roomHalfW - halfW, x)),
    z: Math.max(-roomHalfD + halfD, Math.min(roomHalfD - halfD, z)),
  };
}

// Cabinet (wine fridge): each bay stacks its rows in Y (real stacking, not
// the shelf type's z-stagger). Row 1 rests on the plank; with twoDeep, odd
// rows are the front row of a level (base toward the viewer, neck pointing
// in) and even rows the back row (neck-to-neck behind them). Geometry comes
// from roomConstants.getCabinetGeometry so body, planks and bottles agree.
// On an alternating bay the rows are cols / cols−1 wide in turn
// (rackLayouts.cabinetRowWidth) and the narrow ones sit half a bottle over,
// in the grooves of the wide row below — the shelf is exactly cols wide. A
// bay narrower than the cabinet (its own cols) sits centred in the body.
// `row` carries the BAY index so PullOutShelfRow can slide a whole bay.
// Head to tail (one deep only): every other bottle of a row is turned round,
// neck toward the viewer, its base a bottle length further in so it fills
// the same depth as its neighbours.
export function computeCabinetSlotPositions(cab, width, depth) {
  const positions = [];
  // A staggered shelf is half a bottle wider than its bottle count, so the
  // cells are sized against the widest bay's cols + 0.5 and the offset level
  // lands inside the frame instead of through the side panel. (Not for an
  // alternating bay: there the offset rows are the narrow ones and never
  // poke out.)
  const drawOpts = { twoDeep: cab.twoDeep, stagger: cab.stagger, backOffset: false };
  const units = Math.max(1, ...cab.bays.map((b) => cabinetBayUnits(b, drawOpts)));
  const cW = width / units;
  const halfD = depth / 2;
  // A bottle's local +Y axis is 0.285 long; a base 0.029 in from a face puts
  // the neck just short of the centreline (same figures as the shelf type).
  const frontBottleZ = halfD - 0.029;
  const backBottleZ = -(halfD - 0.029);
  const frontEmptyZ = halfD - 0.005;
  const neckForwardZ = frontBottleZ - BOTTLE_LENGTH;
  const backEmptyZ = -halfD + 0.005;
  // Bottles lying ACROSS (typeConfig.shelfSideways): base at the left, neck
  // to the right, centred in the cabinet — shrunk to fit a cabinet narrower
  // than a bottle is long; one bottle diameter (+ a hair) is the
  // front-to-back pitch of a pile. Only the BOTTLE moves to where it lies:
  // every slot keeps the ordinary cabinet's click target (x, z), so the
  // targets never overlap (release audit 2026-10-13).
  const sideScale = Math.max(0.2, Math.min(1, (width - 0.01) / BOTTLE_LENGTH));
  const sideR = BOTTLE_RADIUS * sideScale;
  const sideX = -(BOTTLE_LENGTH * sideScale) / 2;
  const sidePitch = sideR * 2 + 0.004;
  const sideFrontZ = halfD - 0.01 - sideR;
  let pos = 1;
  cab.bays.forEach((bay, i) => {
    const cols = Math.max(1, bay.cols);
    const nest = bay.alternate || cab.stagger;
    const x0 = -width / 2 + cW / 2 + ((units - cabinetBayUnits(bay, drawOpts)) / 2) * cW;
    // 'front': the first bottle of the bottom row lies across the front, so
    // the bay's other front bottles sit one bottle further in.
    const frontPush = bay.sideways === 'front' ? sidePitch : 0;
    // 'all': every row is a front-to-back line of bottles lying across; a
    // level's rows (front then back, when two deep) share one line.
    const levelCount = {};
    if (bay.sideways === 'all') {
      for (let r = 1; r <= bay.rows; r++) {
        const level = cab.twoDeep ? Math.ceil(r / 2) : r;
        levelCount[level] = (levelCount[level] || 0) + cabinetRowWidth(r, cols, cabinetBayOpts(bay, cab.twoDeep));
      }
    }
    const levelUsed = {};
    for (let r = 1; r <= bay.rows; r++) {
      const level = cab.twoDeep ? Math.ceil(r / 2) : r;
      const isBack = cab.twoDeep && r % 2 === 0;
      const y = bay.bottom + BOTTLE_RADIUS + 0.003 + (level - 1) * bay.levelPitch;
      // Nested levels alternate half a bottle left and right (see
      // roomConstants.getCabinetGeometry): the shelf is half a bottle wider
      // than its bottle count, exactly like a real fridge's staggered shelf.
      // Alternating rows: the narrow rows are the offset ones instead.
      const rowWidth = cabinetRowWidth(r, cols, cabinetBayOpts(bay, cab.twoDeep));
      // A level resting behind a bottle across the front (a stacked one-deep
      // shelf) lies over the bottles behind that one, which sit half a bottle
      // in from the first row's cells: there the slot is drawn and clicked
      // where it lies (rackLayouts.cabinetRowOffset).
      const behind = cabinetRestsBehindAcross(bay, r, cab.twoDeep);
      const nudge = behind
        ? cabinetRowOffset(bay, r, { twoDeep: cab.twoDeep, stagger: cab.stagger }) * cW - cW / 2
        : (bay.alternate
          ? (rowWidth < cols ? cW / 2 : 0)
          : (nest && cols > 1 && level % 2 === 0 ? cW / 2 : 0));
      // The ordinary cabinet's click target for each slot of this row.
      const targetX = (c) => x0 + c * cW + nudge;
      const targetZ = isBack ? backEmptyZ : frontEmptyZ;
      if (bay.sideways === 'all') {
        // A pile: the line runs from the front of the cabinet inwards, packed
        // tighter when it would not fit (the last bottle's radius and a
        // nested level's half pitch included, so nothing pokes through the
        // back panel); a nested LEVEL sits half a bottle further in, in the
        // grooves of the one below.
        const inLevel = levelCount[level];
        const nestedLevel = nest && level % 2 === 0;
        const pitch = Math.min(sidePitch,
          (depth - 0.02 - 2 * sideR) / Math.max(1, inLevel - 1 + (nestedLevel ? 0.5 : 0)));
        const zNudge = nestedLevel ? pitch / 2 : 0;
        for (let c = 0; c < rowWidth; c++) {
          const k = levelUsed[level] || 0;
          levelUsed[level] = k + 1;
          positions.push({
            position: pos++,
            x: targetX(c), y, z: targetZ,
            bottleX: sideX, bottleZ: sideFrontZ - k * pitch - zNudge, bottleScale: sideScale,
            sideways: true, isBack, flipNeck: false, row: i,
          });
        }
        continue;
      }
      for (let c = 0; c < rowWidth; c++) {
        if (bay.sideways === 'front' && r === 1 && c === 0) {
          // The bottle across the front of the shelf, in front of the rest.
          positions.push({
            position: pos++, x: targetX(c), y, z: targetZ,
            bottleX: sideX, bottleZ: sideFrontZ, bottleScale: sideScale, sideways: true,
            isBack: false, flipNeck: false, row: i,
          });
          continue;
        }
        // Behind an across bottle the bay's front rows sit one bottle further
        // in and half a bottle over: the bottom row is one bottle narrower and
        // centred, the levels above still lie in its grooves, and two deep
        // the front rows interleave with the back rows instead of meeting
        // them neck to neck.
        const frontSide = bay.sideways === 'front' && !isBack;
        const neckForward = cab.headToTail && !isBack
          && cabinetNeckForward(bay.sideways === 'front' && r === 1 ? c - 1 : c);
        const push = frontSide ? frontPush : 0;
        positions.push({
          position: pos++,
          x: targetX(c), y, z: targetZ,
          ...(frontSide && !behind ? { bottleX: targetX(c) - cW / 2 } : {}),
          bottleZ: isBack ? backBottleZ : (neckForward ? neckForwardZ : frontBottleZ) - push,
          isBack,
          flipNeck: !isBack && !neckForward,
          row: i,
        });
      }
    }
  });
  return positions;
}
