/**
 * Shared constants and helpers for the 3D room view.
 * Used by CellarRoom, RoomScene, and RackMesh to avoid duplication.
 */

import {
  computeLayout, computeModularLayout, CELL_SIZE,
  validDoubleHeightRows, DOUBLE_ROW_HEADROOM, cabinetShelfRows,
} from './rackLayouts';

// ── Rack physical dimensions (metres) ────────────────────
export const CELL_W = 0.105;       // cell width
export const CELL_H = 0.105;       // cell height
export const RACK_DEPTH = 0.34;    // default rack depth
export const WOOD_THICK = 0.012;   // internal shelf/beam thickness
export const PANEL_THICK = 0.018;  // outer frame panel thickness
export const BOTTLE_RADIUS = 0.037;

// ── Cabinet (wine fridge) dimensions ─────────────────────
export const CABINET_LEVEL_H = 0.079;      // vertical pitch of stacked bottle rows
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
  const twoDeep = rack.typeConfig?.twoDeep !== false;
  const levelsOf = (rows) => (twoDeep ? Math.ceil(rows / 2) : rows);
  const bayHeights = shelfRows.map((r) => Math.max(CELL_H, levelsOf(r) * CABINET_LEVEL_H + CABINET_BAY_HEADROOM));
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
      // The beech plank under this bay (the bottom bay rests on the cabinet floor).
      plankY: i < n - 1 ? bottom - WOOD_THICK / 2 : null,
    };
  });
  return {
    shelfRows, twoDeep, bays, innerH, height,
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
