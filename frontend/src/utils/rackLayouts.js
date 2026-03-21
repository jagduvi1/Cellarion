/**
 * Rack layout engine — computes SVG coordinates for each slot position per rack type.
 *
 * Returns { totalSlots, viewBox: { width, height }, slots: [{ position, cx, cy }] }
 *
 * Position numbering is 1-based and contiguous (1 through totalSlots).
 */

const SLOT_R = 20;       // slot circle radius
const SLOT_GAP = 8;      // gap between slots
const PADDING = 20;       // viewBox padding
const CELL = SLOT_R * 2 + SLOT_GAP;  // centre-to-centre distance

// ── Grid ─────────────────────────────────────────────────────────────
function gridLayout(rows, cols) {
  const slots = [];
  let pos = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      slots.push({
        position: pos++,
        cx: PADDING + SLOT_R + c * CELL,
        cy: PADDING + SLOT_R + r * CELL,
      });
    }
  }
  return {
    totalSlots: slots.length,
    viewBox: {
      width:  PADDING * 2 + cols * CELL - SLOT_GAP,
      height: PADDING * 2 + rows * CELL - SLOT_GAP,
    },
    slots,
  };
}

// ── X-Rack ──────────────────────────────────────────────────────────
// Square with X-shaped dividers creating 4 triangular sections.
// Each section holds bottlesPerSection bottles arranged in triangular rows.
// Sections: 0=top, 1=right, 2=bottom, 3=left
function xRackLayout(typeConfig) {
  const bps = typeConfig?.bottlesPerSection || 10;
  const total = 4 * bps;

  // Number of rows per section for triangular stacking: k*(k+1)/2 >= bps
  let k = 1;
  while (k * (k + 1) / 2 < bps) k++;

  // Spacing between bottles within the triangular sections
  const rowStep = CELL * 0.78;
  const colStep = CELL * 0.82;
  const centerGap = CELL * 0.35;

  // Half-side: from center to edge, must fit k rows of bottles
  const halfSide = k * rowStep + centerGap + SLOT_R;
  const fullSize = halfSide * 2;
  const cx = PADDING + halfSide;
  const cy = PADDING + halfSide;

  const slots = [];
  let pos = 1;

  for (let section = 0; section < 4; section++) {
    let placed = 0;
    for (let row = 0; row < k && placed < bps; row++) {
      const bottlesInRow = Math.min(k - row, bps - placed);
      // Distance from center: row 0 = outermost (near wall), row k-1 = innermost (near center)
      const distFromCenter = halfSide - SLOT_R - row * rowStep;

      for (let col = 0; col < bottlesInRow; col++) {
        const lateral = (col - (bottlesInRow - 1) / 2) * colStep;
        let sx, sy;
        switch (section) {
          case 0: // top: base at top edge
            sx = cx + lateral;
            sy = cy - distFromCenter;
            break;
          case 1: // right: base at right edge
            sx = cx + distFromCenter;
            sy = cy + lateral;
            break;
          case 2: // bottom: base at bottom edge
            sx = cx - lateral;
            sy = cy + distFromCenter;
            break;
          case 3: // left: base at left edge
            sx = cx - distFromCenter;
            sy = cy - lateral;
            break;
          default:
            sx = cx;
            sy = cy;
        }
        slots.push({ position: pos++, cx: sx, cy: sy });
        placed++;
      }
    }
  }

  return {
    totalSlots: total,
    isXRack: true,
    viewBox: {
      width:  PADDING * 2 + fullSize,
      height: PADDING * 2 + fullSize,
    },
    slots,
  };
}

// ── Hexagonal honeycomb ──────────────────────────────────────────────
// Even rows (0-indexed) have `cols` slots; odd rows have `cols - 1` (offset right by half).
function hexLayout(rows, cols) {
  const slots = [];
  let pos = 1;
  const hexH = CELL * 0.866;  // vertical distance (sin 60° ≈ 0.866)

  for (let r = 0; r < rows; r++) {
    const isOdd = r % 2 === 1;
    const rowCols = isOdd ? Math.max(1, cols - 1) : cols;
    const xOffset = isOdd ? CELL * 0.5 : 0;

    for (let c = 0; c < rowCols; c++) {
      slots.push({
        position: pos++,
        cx: PADDING + SLOT_R + c * CELL + xOffset,
        cy: PADDING + SLOT_R + r * hexH,
      });
    }
  }

  return {
    totalSlots: slots.length,
    viewBox: {
      width:  PADDING * 2 + cols * CELL - SLOT_GAP + (cols > 1 ? CELL * 0.5 : 0),
      height: PADDING * 2 + (rows - 1) * hexH + SLOT_R * 2,
    },
    slots,
  };
}

// ── Triangle (A-frame) ───────────────────────────────────────────────
// Row 0 has `base` slots, row 1 has `base - 1`, etc. down to 1.
function triangleLayout(_rows, cols) {
  const base = Math.max(1, cols);
  const numRows = base;
  const slots = [];
  let pos = 1;

  for (let r = 0; r < numRows; r++) {
    const rowCols = base - r;
    const xOffset = (r * CELL) / 2;  // centre each narrowing row
    for (let c = 0; c < rowCols; c++) {
      slots.push({
        position: pos++,
        cx: PADDING + SLOT_R + c * CELL + xOffset,
        cy: PADDING + SLOT_R + r * CELL,
      });
    }
  }

  return {
    totalSlots: slots.length,
    viewBox: {
      width:  PADDING * 2 + base * CELL - SLOT_GAP,
      height: PADDING * 2 + numRows * CELL - SLOT_GAP,
    },
    slots,
  };
}

// ── Stack (single column) ────────────────────────────────────────────
function stackLayout(rows) {
  const slots = [];
  for (let r = 0; r < rows; r++) {
    slots.push({
      position: r + 1,
      cx: PADDING + SLOT_R,
      cy: PADDING + SLOT_R + r * CELL,
    });
  }
  return {
    totalSlots: slots.length,
    viewBox: {
      width:  PADDING * 2 + SLOT_R * 2,
      height: PADDING * 2 + rows * CELL - SLOT_GAP,
    },
    slots,
  };
}

// ── Cube (grid of sub-modules) ───────────────────────────────────────
// Outer grid = rows × cols modules. Each module = moduleRows × moduleCols.
// Modules are separated by extra spacing.
function cubeLayout(rows, cols, typeConfig) {
  const mr = typeConfig?.moduleRows || 2;
  const mc = typeConfig?.moduleCols || 2;
  const moduleGap = CELL * 0.6;  // extra gap between modules
  const slots = [];
  let pos = 1;

  for (let outerR = 0; outerR < rows; outerR++) {
    for (let outerC = 0; outerC < cols; outerC++) {
      const moduleX = outerC * (mc * CELL + moduleGap);
      const moduleY = outerR * (mr * CELL + moduleGap);

      for (let innerR = 0; innerR < mr; innerR++) {
        for (let innerC = 0; innerC < mc; innerC++) {
          slots.push({
            position: pos++,
            cx: PADDING + SLOT_R + moduleX + innerC * CELL,
            cy: PADDING + SLOT_R + moduleY + innerR * CELL,
          });
        }
      }
    }
  }

  const totalW = cols * mc * CELL + (cols - 1) * moduleGap;
  const totalH = rows * mr * CELL + (rows - 1) * moduleGap;

  return {
    totalSlots: slots.length,
    viewBox: {
      width:  PADDING * 2 + totalW - SLOT_GAP,
      height: PADDING * 2 + totalH - SLOT_GAP,
    },
    slots,
  };
}

// ── Shelf (open case storage) ────────────────────────────────────────
// Same grid as 'grid' visually but each compartment holds bottlesPerCell bottles.
function shelfLayout(rows, cols, typeConfig) {
  const bpc = typeConfig?.bottlesPerCell || 1;
  const slots = [];
  let pos = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = PADDING + SLOT_R + c * CELL;
      const cy = PADDING + SLOT_R + r * CELL;
      for (let b = 0; b < bpc; b++) {
        slots.push({ position: pos++, cx, cy });
      }
    }
  }
  return {
    totalSlots: slots.length,
    bottlesPerCell: bpc,
    viewBox: {
      width:  PADDING * 2 + cols * CELL - SLOT_GAP,
      height: PADDING * 2 + rows * CELL - SLOT_GAP,
    },
    slots,
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Compute the layout for a given rack type.
 * @param {string} type - one of: grid, x-rack, hex, triangle, stack, cube, shelf
 * @param {number} rows
 * @param {number} cols
 * @param {object} [typeConfig] - extra config (e.g. moduleRows/moduleCols for cube)
 * @returns {{ totalSlots: number, viewBox: { width: number, height: number }, slots: Array<{ position: number, cx: number, cy: number }> }}
 */
export function computeLayout(type, rows, cols, typeConfig) {
  switch (type) {
    case 'x-rack':   return xRackLayout(typeConfig);
    case 'hex':      return hexLayout(rows, cols);
    case 'triangle': return triangleLayout(rows, cols);
    case 'stack':    return stackLayout(rows);
    case 'cube':     return cubeLayout(rows, cols, typeConfig);
    case 'shelf':    return shelfLayout(rows, cols, typeConfig);
    case 'grid':
    default:         return gridLayout(rows, cols);
  }
}

/** Slot radius — exported so renderers can use it. */
export const SLOT_RADIUS = SLOT_R;

/** Centre-to-centre distance — exported for builder grid snapping. */
export const CELL_SIZE = CELL;

/**
 * Compute layout for a modular rack (multiple modules composed together).
 * Each module gets its own sub-layout, offset by (module.x, module.y) in grid-cell units.
 * Slot positions are globally contiguous across all modules.
 *
 * @param {Array<{ type: string, rows: number, cols: number, typeConfig?: object, x?: number, y?: number }>} modules
 * @returns {{ totalSlots: number, viewBox: { width: number, height: number }, slots: Array<{ position: number, cx: number, cy: number, moduleIndex: number }>, moduleLayouts: Array<{ moduleIndex: number, x: number, y: number, width: number, height: number, slotCount: number }> }}
 */
export function computeModularLayout(modules) {
  if (!modules || modules.length === 0) {
    return { totalSlots: 0, viewBox: { width: 0, height: 0 }, slots: [], moduleLayouts: [] };
  }

  let globalPos = 1;
  let maxRight = 0;
  let maxBottom = 0;
  const allSlots = [];
  const moduleLayouts = [];

  modules.forEach((mod, idx) => {
    const sub = computeLayout(mod.type || 'grid', mod.rows || 1, mod.cols || 1, mod.typeConfig);
    const offsetX = (mod.x || 0) * CELL;
    const offsetY = (mod.y || 0) * CELL;

    const modSlots = sub.slots.map(s => ({
      position: globalPos++,
      cx: s.cx + offsetX,
      cy: s.cy + offsetY,
      moduleIndex: idx,
    }));

    allSlots.push(...modSlots);

    const modRight = offsetX + sub.viewBox.width;
    const modBottom = offsetY + sub.viewBox.height;
    if (modRight > maxRight) maxRight = modRight;
    if (modBottom > maxBottom) maxBottom = modBottom;

    moduleLayouts.push({
      moduleIndex: idx,
      x: offsetX,
      y: offsetY,
      width: sub.viewBox.width,
      height: sub.viewBox.height,
      slotCount: sub.totalSlots,
    });
  });

  return {
    totalSlots: allSlots.length,
    viewBox: { width: maxRight, height: maxBottom },
    slots: allSlots,
    moduleLayouts,
  };
}

/**
 * Quick modular total slot count without computing coordinates.
 * @param {Array<{ type: string, rows: number, cols: number, typeConfig?: object }>} modules
 * @returns {number}
 */
export function getModularTotalSlots(modules) {
  if (!modules || modules.length === 0) return 0;
  return modules.reduce((sum, m) => sum + getTotalSlots(m.type || 'grid', m.rows || 1, m.cols || 1, m.typeConfig), 0);
}

/**
 * Quick total slot count without computing full coordinates.
 * Mirrors backend rackGeometry.totalSlots.
 */
export function getTotalSlots(type, rows, cols, typeConfig) {
  switch (type) {
    case 'x-rack': {
      const bps = typeConfig?.bottlesPerSection || 10;
      return 4 * bps;
    }
    case 'hex': {
      let total = 0;
      for (let r = 0; r < rows; r++) {
        total += (r % 2 === 0) ? cols : Math.max(1, cols - 1);
      }
      return total;
    }
    case 'triangle': {
      const base = Math.max(1, cols);
      return (base * (base + 1)) / 2;
    }
    case 'stack':
      return rows;
    case 'cube': {
      const mr = typeConfig?.moduleRows || 2;
      const mc = typeConfig?.moduleCols || 2;
      return rows * cols * mr * mc;
    }
    case 'shelf': {
      const cells = rows * cols;
      const bpc = typeConfig?.bottlesPerCell || 1;
      return cells * bpc;
    }
    case 'grid':
    default:
      return rows * cols;
  }
}
