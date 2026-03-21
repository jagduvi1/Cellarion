/**
 * Rack geometry utilities — compute total slot counts per rack type.
 *
 * Each rack type interprets `rows` and `cols` differently:
 *   grid     — rows × cols rectangular grid
 *   x-rack   — square with X dividers; 4 triangular sections, each holds bottlesPerSection bottles
 *   hex      — hex honeycomb; alternating row widths (cols, cols-1, …)
 *   triangle — A-frame; base width = cols, each row shrinks by 1
 *   stack    — single vertical column; height = rows
 *   cube     — grid of sub-modules; outer grid = rows × cols, each module = moduleRows × moduleCols
 *   shelf    — open case storage; rows × cols (same count as grid, different visual)
 */

/**
 * Total number of valid slot positions for a given rack configuration.
 */
function totalSlots(type, rows, cols, typeConfig) {
  switch (type) {
    case 'grid':
      return rows * cols;

    case 'x-rack': {
      // Square with X dividers creating 4 triangular sections.
      // Each section holds bottlesPerSection bottles (default 10).
      const bps = typeConfig?.bottlesPerSection || 10;
      return 4 * bps;
    }

    case 'hex': {
      // Honeycomb grid: `rows` rows. Even rows (0-indexed) have `cols` slots,
      // odd rows have `cols - 1` slots (offset).
      let total = 0;
      for (let r = 0; r < rows; r++) {
        total += (r % 2 === 0) ? cols : Math.max(1, cols - 1);
      }
      return total;
    }

    case 'triangle': {
      // A-frame: row 0 has `cols` slots, row 1 has `cols - 1`, etc.
      // Total = cols + (cols-1) + … + 1 = cols × (cols + 1) / 2
      // rows is derived from cols (= cols rows), so we use cols as the base.
      const base = cols;
      return (base * (base + 1)) / 2;
    }

    case 'stack':
      // Single column, height = rows
      return rows;

    case 'cube': {
      // Grid of sub-modules. Outer grid = rows × cols modules.
      // Each module = moduleRows × moduleCols slots.
      const mr = typeConfig?.moduleRows || 2;
      const mc = typeConfig?.moduleCols || 2;
      return rows * cols * mr * mc;
    }

    case 'shelf': {
      // Open case storage: rows × cols compartments, each holds bottlesPerCell bottles.
      const cells = rows * cols;
      const bpc = typeConfig?.bottlesPerCell || 1;
      return cells * bpc;
    }

    default:
      // Fall back to grid behaviour
      return rows * cols;
  }
}

/**
 * Total slots for a modular rack (sum of all modules).
 * @param {Array<{ type: string, rows: number, cols: number, typeConfig?: object }>} modules
 * @returns {number}
 */
function modularTotalSlots(modules) {
  if (!modules || modules.length === 0) return 0;
  return modules.reduce((sum, m) => sum + totalSlots(m.type, m.rows, m.cols, m.typeConfig), 0);
}

/**
 * Convenience: get max position for a rack document.
 * Handles both simple and modular racks.
 * @param {{ isModular?: boolean, modules?: Array, type?: string, rows: number, cols: number, typeConfig?: object }} rack
 * @returns {number}
 */
function getMaxPosition(rack) {
  if (rack.isModular && rack.modules?.length > 0) {
    return modularTotalSlots(rack.modules);
  }
  return totalSlots(rack.type || 'grid', rack.rows, rack.cols, rack.typeConfig);
}

module.exports = { totalSlots, modularTotalSlots, getMaxPosition };
