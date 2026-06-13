/**
 * Shared constants and helpers for the 3D room view.
 * Used by CellarRoom, RoomScene, and RackMesh to avoid duplication.
 */

import { computeLayout, computeModularLayout, CELL_SIZE } from './rackLayouts';

// ── Rack physical dimensions (metres) ────────────────────
export const CELL_W = 0.105;       // cell width
export const CELL_H = 0.105;       // cell height
export const RACK_DEPTH = 0.34;    // default rack depth
export const WOOD_THICK = 0.012;   // internal shelf/beam thickness
export const PANEL_THICK = 0.018;  // outer frame panel thickness
export const BOTTLE_RADIUS = 0.037;

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
 * Compute full rack height in metres (outer frame included).
 */
export function getRackHeight(rack) {
  if (usesScaledLayout(rack)) {
    return buildScaledLayout(rack).innerH + PANEL_THICK * 2;
  }
  const { displayRows } = getDisplayDims(rack);
  return displayRows * CELL_H + PANEL_THICK * 2;
}

/**
 * Default rack depth in metres. Two-deep shelves need extra depth to fit
 * front + back bottles end-to-end inside the shelf.
 */
export function getDefaultRackDepth(rack) {
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
