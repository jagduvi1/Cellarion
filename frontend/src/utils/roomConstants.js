/**
 * Shared constants and helpers for the 3D room view.
 * Used by CellarRoom, RoomScene, and RackMesh to avoid duplication.
 */

// ── Rack physical dimensions (metres) ────────────────────
export const CELL_W = 0.105;       // cell width
export const CELL_H = 0.105;       // cell height
export const RACK_DEPTH = 0.34;    // default rack depth
export const WOOD_THICK = 0.012;   // internal shelf/beam thickness
export const PANEL_THICK = 0.018;  // outer frame panel thickness
export const BOTTLE_RADIUS = 0.037;

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
  const { displayRows } = getDisplayDims(rack);
  return displayRows * CELL_H + PANEL_THICK * 2;
}

/**
 * Compute world-space half-width/half-depth for a rack, accounting for
 * rotation and width/depth overrides from the placement.
 */
export function getRackWorldDims(rack, placement) {
  const { displayCols } = getDisplayDims(rack);
  const defaultW = displayCols * CELL_W + PANEL_THICK * 2;
  const w = placement.widthOverride || defaultW;
  const d = placement.depthOverride || RACK_DEPTH;
  const rot = (placement.rotation || 0) % 360;
  const isRotated = rot === 90 || rot === 270;
  return {
    halfW: (isRotated ? d : w) / 2,
    halfD: (isRotated ? w : d) / 2,
  };
}
